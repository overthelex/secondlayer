/**
 * Tests for admin backfill-fulltext endpoints
 */

import express from 'express';
import request from 'supertest';
import { createAdminRoutes } from '../admin-routes.js';

// Mock axios
jest.mock('axios', () => ({
  default: { get: jest.fn() },
  get: jest.fn(),
}));

// Mock html-parser
jest.mock('../../utils/html-parser.js', () => ({
  CourtDecisionHTMLParser: jest.fn().mockImplementation((html: string) => ({
    toText: jest.fn().mockReturnValue(html.includes('empty') ? '' : 'A'.repeat(200)),
    extractArticleHTML: jest.fn().mockReturnValue('<article>parsed</article>'),
    getMetadata: jest.fn().mockReturnValue({ caseNumber: '123/456/24' }),
  })),
}));

import axios from 'axios';
const mockedAxiosGet = axios.get as jest.Mock;

// --- Helpers ---

function createMockDb(overrides: Record<string, any> = {}) {
  const defaultResults: Record<string, any> = {
    // Admin role check: query is "SELECT is_admin, role FROM users WHERE id = $1"
    'is_admin': { rows: [{ is_admin: true, role: 'administrator' }] },
    // Backfill query (docs missing fulltext)
    zakononline_id: {
      rows: [
        { zakononline_id: '111', title: 'Doc A', metadata: { justice_kind: '1' } },
        { zakononline_id: '222', title: 'Doc B', metadata: { justice_kind: '1' } },
      ],
    },
    // UPDATE documents
    'UPDATE documents': { rows: [], rowCount: 1 },
    // zo_dictionaries
    zo_dictionaries: { rows: [] },
    ...overrides,
  };

  return {
    query: jest.fn().mockImplementation((sql: string) => {
      for (const [key, val] of Object.entries(defaultResults)) {
        if (sql.includes(key)) return Promise.resolve(val);
      }
      return Promise.resolve({ rows: [] });
    }),
    getPool: jest.fn(),
  } as any;
}

function createApp(db: any) {
  const app = express();
  app.use(express.json());
  // Inject fake user (skip real JWT)
  app.use((req: any, _res, next) => {
    req.user = { id: 'user-1', email: 'admin@test.com' };
    next();
  });
  app.use('/api/admin', createAdminRoutes(db));
  return app;
}

// --- Tests ---

describe('Admin Backfill Fulltext Endpoints', () => {
  let app: express.Application;
  let db: any;

  beforeEach(() => {
    jest.clearAllMocks();
    db = createMockDb();
    app = createApp(db);
  });

  describe('POST /api/admin/backfill-fulltext', () => {
    it('should start a backfill job and return job_id', async () => {
      const res = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({ limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.job_id).toMatch(/^backfill-/);
      expect(res.body.total).toBe(2);
      expect(res.body.status).toBe('queued');
      expect(res.body.message).toContain('2 документів');
    });

    it('should return message when no documents need backfill', async () => {
      const emptyDb = createMockDb({ zakononline_id: { rows: [] } });
      const emptyApp = createApp(emptyDb);

      const res = await request(emptyApp)
        .post('/api/admin/backfill-fulltext')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.message).toContain('Немає документів');
    });

    it('should accept justice_kind_code filter', async () => {
      const res = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({ justice_kind_code: '5', limit: 50 });

      expect(res.status).toBe(200);
      expect(res.body.job_id).toBeDefined();

      // Verify justice_kind filter was in the query
      const queryCalls = db.query.mock.calls;
      const backfillQuery = queryCalls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('justice_kind')
      );
      expect(backfillQuery).toBeDefined();
      expect(backfillQuery![1]).toContain('5');
    });

    it('should cap limit at 1000', async () => {
      const res = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({ limit: 5000 });

      expect(res.status).toBe(200);

      const queryCalls = db.query.mock.calls;
      const backfillQuery = queryCalls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('LIMIT')
      );
      expect(backfillQuery).toBeDefined();
      const limitParam = backfillQuery![1][backfillQuery![1].length - 1];
      expect(limitParam).toBeLessThanOrEqual(1000);
    });

    it('should reject when a backfill is already running', async () => {
      const first = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({});
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({});
      expect(second.status).toBe(409);
      expect(second.body.error).toContain('вже виконується');
    });
  });

  describe('GET /api/admin/backfill-fulltext/:jobId', () => {
    it('should return job status for existing job', async () => {
      const start = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({});
      const jobId = start.body.job_id;

      const res = await request(app)
        .get(`/api/admin/backfill-fulltext/${jobId}`);

      expect(res.status).toBe(200);
      expect(res.body.job_id).toBe(jobId);
      expect(res.body.total).toBe(2);
      expect(['queued', 'running', 'completed']).toContain(res.body.status);
    });

    it('should return 404 for unknown job', async () => {
      const res = await request(app)
        .get('/api/admin/backfill-fulltext/nonexistent-123');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/admin/backfill-fulltext/:jobId/stop', () => {
    it('should request stop for a running job', async () => {
      const start = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({});
      const jobId = start.body.job_id;

      const res = await request(app)
        .post(`/api/admin/backfill-fulltext/${jobId}/stop`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Stop requested');
    });

    it('should return 404 for unknown job', async () => {
      const res = await request(app)
        .post('/api/admin/backfill-fulltext/nonexistent/stop');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/admin/backfill-fulltext (latest)', () => {
    it('should return active:false when no jobs exist', async () => {
      const res = await request(app)
        .get('/api/admin/backfill-fulltext');

      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
      expect(res.body.job).toBeNull();
    });

    it('should return active job after starting one', async () => {
      await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({});

      const res = await request(app)
        .get('/api/admin/backfill-fulltext');

      expect(res.status).toBe(200);
      expect(res.body.active).toBe(true);
      expect(res.body.job).toBeDefined();
      expect(res.body.job.job_id).toMatch(/^backfill-/);
    });
  });

  describe('Backfill job execution', () => {
    it('should scrape documents and update DB on success', async () => {
      mockedAxiosGet.mockResolvedValue({
        status: 200,
        data: '<html><body>Court decision full text</body></html>',
      });

      const start = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({ limit: 2 });
      const jobId = start.body.job_id;

      // Wait for background processing (500ms rate limit * 2 docs + buffer)
      await new Promise(r => setTimeout(r, 2500));

      const res = await request(app)
        .get(`/api/admin/backfill-fulltext/${jobId}`);

      expect(res.body.status).toBe('completed');
      expect(res.body.processed).toBe(2);
      expect(res.body.scraped).toBe(2);
      expect(res.body.errors).toBe(0);

      // Verify UPDATE was called for each document
      const updateCalls = db.query.mock.calls.filter((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE documents')
      );
      expect(updateCalls.length).toBe(2);
    }, 10000);

    it('should handle scraping errors gracefully', async () => {
      mockedAxiosGet.mockRejectedValue(new Error('Connection timeout'));

      const start = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({ limit: 2 });
      const jobId = start.body.job_id;

      await new Promise(r => setTimeout(r, 2500));

      const res = await request(app)
        .get(`/api/admin/backfill-fulltext/${jobId}`);

      expect(res.body.status).toBe('completed');
      expect(res.body.processed).toBe(2);
      expect(res.body.scraped).toBe(0);
      expect(res.body.errors).toBe(2);
      expect(res.body.error_details.length).toBeGreaterThan(0);
    }, 10000);

    it('should handle empty text from parser', async () => {
      mockedAxiosGet.mockResolvedValue({
        status: 200,
        data: '<html>empty</html>',
      });

      const start = await request(app)
        .post('/api/admin/backfill-fulltext')
        .send({ limit: 2 });
      const jobId = start.body.job_id;

      await new Promise(r => setTimeout(r, 2500));

      const res = await request(app)
        .get(`/api/admin/backfill-fulltext/${jobId}`);

      expect(res.body.scraped).toBe(0);
      expect(res.body.errors).toBe(2);
    }, 10000);

    it('should stop when stop is requested', async () => {
      // Slow axios to give time to stop
      mockedAxiosGet.mockImplementation(() =>
        new Promise(r => setTimeout(() => r({ status: 200, data: '<html>ok</html>' }), 200))
      );

      // Use many docs so job takes long enough to stop
      const manyDb = createMockDb({
        zakononline_id: {
          rows: Array.from({ length: 10 }, (_, i) => ({
            zakononline_id: String(1000 + i),
            title: `Doc ${i}`,
            metadata: { justice_kind: '1' },
          })),
        },
      });
      const manyApp = createApp(manyDb);

      const start = await request(manyApp)
        .post('/api/admin/backfill-fulltext')
        .send({ limit: 10 });
      const jobId = start.body.job_id;

      // Wait a bit, then stop
      await new Promise(r => setTimeout(r, 800));
      await request(manyApp)
        .post(`/api/admin/backfill-fulltext/${jobId}/stop`);

      // Wait for stop to take effect
      await new Promise(r => setTimeout(r, 1500));

      const res = await request(manyApp)
        .get(`/api/admin/backfill-fulltext/${jobId}`);

      expect(res.body.status).toBe('stopped');
      expect(res.body.processed).toBeLessThan(10);
    }, 15000);
  });
});
