/**
 * WorkflowMemoryService unit tests
 *
 * Covers:
 * - initialize: creates missing Qdrant collections, skips existing ones, runs only once
 * - query: embedding, per-layer search, merge+sort by score, topK trim, tag filter,
 *          sessionId logRetrieval, no logging when sessionId absent
 * - ingestPrinciple: PG upsert + Qdrant domain collection
 * - ingestPattern: PG insert + Qdrant workflow collection
 * - ingestPractitioner: PG insert + Qdrant practitioner collection
 * - getStats: counts from all 4 tables
 * - collectionForLayer: correct mapping per layer
 */

// --- Module-level mocks MUST come before imports ---
// The mock variables are set up in beforeEach to avoid TypeScript inference issues
// with module-level mockResolvedValue calls.

// Typed as functions (not jest.Mock<any>): jest-mock 30.5 infers `never` for
// mockResolvedValue's parameter when the mock's function type is `any`, which
// fails the suite at type-check time on an unlocked runner install.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetCollections = jest.fn<(...args: any[]) => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateCollection = jest.fn<(...args: any[]) => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSearch = jest.fn<(...args: any[]) => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpsert = jest.fn<(...args: any[]) => Promise<any>>();

jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({
    getCollections: mockGetCollections,
    createCollection: mockCreateCollection,
    search: mockSearch,
    upsert: mockUpsert,
  })),
}));

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { WorkflowMemoryService } from '../workflow-memory-service';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FAKE_EMBEDDING = new Array(1024).fill(0.1);

function makeDb(responder?: (sql: string) => any) {
  return {
    query: jest.fn((sql: string, _params?: any[]) => {
      if (responder) return Promise.resolve(responder(sql));
      return Promise.resolve({ rows: [] });
    }),
  };
}

function makeEmbeddingService() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mock = jest.fn<(...args: any[]) => Promise<any>>();
  mock.mockResolvedValue(FAKE_EMBEDDING);
  return { generateEmbedding: mock } as any;
}

function makeService(db = makeDb(), emb = makeEmbeddingService()) {
  return new WorkflowMemoryService(db, emb);
}

// Default: all three collections already exist so initialize() is a no-op
function allCollectionsExist() {
  mockGetCollections.mockResolvedValue({
    collections: [
      { name: 'wm_domain' },
      { name: 'wm_workflow' },
      { name: 'wm_practitioner' },
    ],
  });
}

function noCollectionsExist() {
  mockGetCollections.mockResolvedValue({ collections: [] });
}

// ---------------------------------------------------------------------------

describe('WorkflowMemoryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset default resolved values
    mockCreateCollection.mockResolvedValue({});
    mockUpsert.mockResolvedValue({});
    allCollectionsExist();
  });

  // ── initialize ─────────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('skips createCollection when all three collections already exist', async () => {
      const svc = makeService();
      await svc.initialize();
      expect(mockCreateCollection).not.toHaveBeenCalled();
    });

    it('creates each missing collection with correct vector config', async () => {
      noCollectionsExist();
      const svc = makeService();
      await svc.initialize();

      expect(mockCreateCollection).toHaveBeenCalledTimes(3);
      const names = mockCreateCollection.mock.calls.map((c: any[]) => c[0]);
      expect(names).toContain('wm_domain');
      expect(names).toContain('wm_workflow');
      expect(names).toContain('wm_practitioner');

      for (const call of mockCreateCollection.mock.calls as any[]) {
        expect(call[1]).toEqual({ vectors: { size: 1024, distance: 'Cosine' } });
      }
    });

    it('creates only the missing collection when two of three exist', async () => {
      mockGetCollections.mockResolvedValue({
        collections: [{ name: 'wm_domain' }, { name: 'wm_workflow' }],
      });
      const svc = makeService();
      await svc.initialize();

      expect(mockCreateCollection).toHaveBeenCalledTimes(1);
      expect(mockCreateCollection).toHaveBeenCalledWith('wm_practitioner', expect.any(Object));
    });

    it('is idempotent — second call does not query Qdrant again', async () => {
      const svc = makeService();
      await svc.initialize();
      await svc.initialize();

      expect(mockGetCollections).toHaveBeenCalledTimes(1);
    });
  });

  // ── query ──────────────────────────────────────────────────────────────────

  describe('query', () => {
    it('calls generateEmbedding with the query text', async () => {
      const emb = makeEmbeddingService();
      mockSearch.mockResolvedValue([]);
      const svc = makeService(makeDb(), emb);

      await svc.query({ query: 'deployment conventions' });

      expect(emb.generateEmbedding).toHaveBeenCalledWith('deployment conventions', 'wm_query');
    });

    it('searches all three layers by default', async () => {
      mockSearch.mockResolvedValue([]);
      const svc = makeService();

      const result = await svc.query({ query: 'test' });

      expect(mockSearch).toHaveBeenCalledTimes(3);
      const searchedCollections = mockSearch.mock.calls.map((c: any[]) => c[0]);
      expect(searchedCollections).toContain('wm_domain');
      expect(searchedCollections).toContain('wm_workflow');
      expect(searchedCollections).toContain('wm_practitioner');
      expect(result.layers_searched).toEqual(
        expect.arrayContaining(['principle', 'pattern', 'practitioner']),
      );
    });

    it('searches only specified layers', async () => {
      mockSearch.mockResolvedValue([]);
      const svc = makeService();

      const result = await svc.query({ query: 'test', layers: ['principle'] });

      expect(mockSearch).toHaveBeenCalledTimes(1);
      expect(mockSearch).toHaveBeenCalledWith('wm_domain', expect.any(Object));
      expect(result.layers_searched).toEqual(['principle']);
    });

    it('merges results from multiple layers and sorts by score descending', async () => {
      mockSearch
        .mockResolvedValueOnce([
          { score: 0.7, payload: { pg_id: 1, title: 'A', body: 'body-a', tags: [] } },
        ])
        .mockResolvedValueOnce([
          { score: 0.9, payload: { pg_id: 2, title: 'B', body: 'body-b', tags: [] } },
        ])
        .mockResolvedValueOnce([
          { score: 0.5, payload: { pg_id: 3, title: 'C', body: 'body-c', tags: [] } },
        ]);

      const svc = makeService();
      const result = await svc.query({ query: 'test', topK: 10 });

      expect(result.hits).toHaveLength(3);
      expect(result.hits[0].score).toBe(0.9);
      expect(result.hits[1].score).toBe(0.7);
      expect(result.hits[2].score).toBe(0.5);
    });

    it('trims merged hits to topK', async () => {
      const makeHit = (score: number, pg_id: number) => ({
        score,
        payload: { pg_id, title: `title-${pg_id}`, body: 'body', tags: [] },
      });
      mockSearch
        .mockResolvedValueOnce([makeHit(0.9, 1), makeHit(0.8, 2)])
        .mockResolvedValueOnce([makeHit(0.75, 3), makeHit(0.6, 4)])
        .mockResolvedValueOnce([makeHit(0.55, 5), makeHit(0.4, 6)]);

      const svc = makeService();
      const result = await svc.query({ query: 'test', topK: 3 });

      expect(result.hits).toHaveLength(3);
      expect(result.hits[0].score).toBe(0.9);
    });

    it('passes tag filter to Qdrant when tags provided', async () => {
      mockSearch.mockResolvedValue([]);
      const svc = makeService();

      await svc.query({ query: 'test', tags: ['billing', 'auth'] });

      for (const call of mockSearch.mock.calls as any[]) {
        expect(call[1].filter).toEqual({
          must: [{ key: 'tags', match: { any: ['billing', 'auth'] } }],
        });
      }
    });

    it('does NOT pass filter when tags array is empty', async () => {
      mockSearch.mockResolvedValue([]);
      const svc = makeService();

      await svc.query({ query: 'test', tags: [] });

      for (const call of mockSearch.mock.calls as any[]) {
        expect(call[1].filter).toBeUndefined();
      }
    });

    it('does NOT pass filter when tags not provided', async () => {
      mockSearch.mockResolvedValue([]);
      const svc = makeService();

      await svc.query({ query: 'test' });

      for (const call of mockSearch.mock.calls as any[]) {
        expect(call[1].filter).toBeUndefined();
      }
    });

    it('logs retrieval when sessionId is provided', async () => {
      mockSearch
        .mockResolvedValueOnce([
          { score: 0.8, payload: { pg_id: 10, title: 'T', body: 'B', tags: [] } },
        ])
        .mockResolvedValue([]);

      const db = makeDb();
      const svc = makeService(db);

      await svc.query({ query: 'test', layers: ['principle'], sessionId: 'sess-123' });

      const insertCalls = (db.query.mock.calls as any[]).filter((c) =>
        c[0].includes('workflow_memory_retrievals'),
      );
      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0][1]).toContain('sess-123');
    });

    it('does NOT log retrieval when sessionId is absent', async () => {
      mockSearch.mockResolvedValue([]);
      const db = makeDb();
      const svc = makeService(db);

      await svc.query({ query: 'test' });

      const insertCalls = (db.query.mock.calls as any[]).filter((c) =>
        c[0].includes('workflow_memory_retrievals'),
      );
      expect(insertCalls).toHaveLength(0);
    });

    it('maps hit fields correctly from Qdrant payload', async () => {
      mockSearch
        .mockResolvedValueOnce([
          {
            score: 0.88,
            payload: {
              pg_id: 42,
              title: 'Blue-green deploy',
              body: 'Deploy to inactive color first',
              source: 'adr',
              tags: ['deploy', 'infra'],
              metadata: { adv: true },
            },
          },
        ])
        .mockResolvedValue([]);

      const svc = makeService();
      const result = await svc.query({ query: 'deploy', layers: ['principle'] });

      expect(result.hits[0]).toMatchObject({
        layer: 'principle',
        id: 42,
        title: 'Blue-green deploy',
        body: 'Deploy to inactive color first',
        score: 0.88,
        source: 'adr',
        tags: ['deploy', 'infra'],
        metadata: { adv: true },
      });
    });

    it('uses default topK=5 when topK not specified', async () => {
      const makeHit = (score: number, pg_id: number) => ({
        score,
        payload: { pg_id, title: `t${pg_id}`, body: 'b', tags: [] },
      });
      // Each layer returns 4 hits; total = 12, but topK=5 slices to 5
      mockSearch.mockResolvedValue(
        Array.from({ length: 4 }, (_, i) => makeHit(0.9 - i * 0.05, i + 1)),
      );
      const svc = makeService();
      const result = await svc.query({ query: 'test' });

      expect(result.hits.length).toBeLessThanOrEqual(5);
    });

    it('passes score_threshold to Qdrant', async () => {
      mockSearch.mockResolvedValue([]);
      const svc = makeService();

      await svc.query({ query: 'test', minScore: 0.6 });

      for (const call of mockSearch.mock.calls as any[]) {
        expect(call[1].score_threshold).toBe(0.6);
      }
    });
  });

  // ── ingestPrinciple ────────────────────────────────────────────────────────

  describe('ingestPrinciple', () => {
    it('inserts into workflow_memory_principles and returns the new id', async () => {
      const db = makeDb(() => ({ rows: [{ id: 7 }] }));
      const svc = makeService(db);

      const id = await svc.ingestPrinciple({
        principleKey: 'deploy.blue_green',
        title: 'Blue-green deploy',
        body: 'Always deploy to inactive colour first.',
        source: 'adr',
        tags: ['deploy'],
      });

      expect(id).toBe(7);
      const pgCall = (db.query.mock.calls as any[]).find((c) =>
        c[0].includes('workflow_memory_principles'),
      );
      expect(pgCall).toBeDefined();
      expect(pgCall[1]).toContain('deploy.blue_green');
    });

    it('uses ON CONFLICT DO UPDATE (upsert) semantics', async () => {
      const db = makeDb(() => ({ rows: [{ id: 3 }] }));
      const svc = makeService(db);
      await svc.ingestPrinciple({ principleKey: 'k', title: 'T', body: 'B' });

      const pgCall = (db.query.mock.calls as any[]).find((c) =>
        c[0].includes('workflow_memory_principles'),
      );
      expect(pgCall[0]).toMatch(/ON CONFLICT.*DO UPDATE/s);
    });

    it('upserts into Qdrant wm_domain collection', async () => {
      const db = makeDb(() => ({ rows: [{ id: 5 }] }));
      const svc = makeService(db);

      await svc.ingestPrinciple({ principleKey: 'k', title: 'T', body: 'B' });

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      const [collection, payload] = mockUpsert.mock.calls[0] as any[];
      expect(collection).toBe('wm_domain');
      expect(payload.points[0].id).toBe(5);
      expect(payload.points[0].vector).toEqual(FAKE_EMBEDDING);
    });

    it('uses defaults for optional fields', async () => {
      const db = makeDb(() => ({ rows: [{ id: 1 }] }));
      const svc = makeService(db);
      await svc.ingestPrinciple({ principleKey: 'k', title: 'T', body: 'B' });

      const pgCall = (db.query.mock.calls as any[]).find((c) =>
        c[0].includes('workflow_memory_principles'),
      );
      // confidence defaults to 1.0
      expect(pgCall[1]).toContain(1.0);
      // source defaults to null
      expect(pgCall[1]).toContain(null);
    });

    it('generates embedding from title + body concatenated', async () => {
      const emb = makeEmbeddingService();
      const db = makeDb(() => ({ rows: [{ id: 1 }] }));
      const svc = makeService(db, emb);

      await svc.ingestPrinciple({ principleKey: 'k', title: 'MyTitle', body: 'MyBody' });

      expect(emb.generateEmbedding).toHaveBeenCalledWith(
        'MyTitle\nMyBody',
        'wm_ingest_principle',
      );
    });
  });

  // ── ingestPattern ──────────────────────────────────────────────────────────

  describe('ingestPattern', () => {
    it('inserts into workflow_memory_patterns and returns id', async () => {
      const db = makeDb(() => ({ rows: [{ id: 20 }] }));
      const svc = makeService(db);

      const id = await svc.ingestPattern({
        patternType: 'tool_sequence',
        description: 'Read → Edit → Build',
        tags: ['tools'],
      });

      expect(id).toBe(20);
      const pgCall = (db.query.mock.calls as any[]).find((c) =>
        c[0].includes('workflow_memory_patterns'),
      );
      expect(pgCall).toBeDefined();
      expect(pgCall[1]).toContain('tool_sequence');
    });

    it('upserts into Qdrant wm_workflow collection', async () => {
      const db = makeDb(() => ({ rows: [{ id: 21 }] }));
      const svc = makeService(db);

      await svc.ingestPattern({ patternType: 'edit_trace', description: 'Desc' });

      const [collection] = mockUpsert.mock.calls[0] as any[];
      expect(collection).toBe('wm_workflow');
    });

    it('serialises patternData to JSON string for PG', async () => {
      const db = makeDb(() => ({ rows: [{ id: 22 }] }));
      const svc = makeService(db);
      const patternData = { steps: ['a', 'b'], count: 2 };

      await svc.ingestPattern({ patternType: 'pt', description: 'D', patternData });

      const pgCall = (db.query.mock.calls as any[]).find((c) =>
        c[0].includes('workflow_memory_patterns'),
      );
      expect(pgCall[1]).toContain(JSON.stringify(patternData));
    });

    it('generates embedding from description text', async () => {
      const emb = makeEmbeddingService();
      const db = makeDb(() => ({ rows: [{ id: 1 }] }));
      const svc = makeService(db, emb);

      await svc.ingestPattern({ patternType: 'pt', description: 'Step by step' });

      expect(emb.generateEmbedding).toHaveBeenCalledWith('Step by step', 'wm_ingest_pattern');
    });
  });

  // ── ingestPractitioner ─────────────────────────────────────────────────────

  describe('ingestPractitioner', () => {
    it('inserts into workflow_memory_practitioner and returns id', async () => {
      const db = makeDb(() => ({ rows: [{ id: 99 }] }));
      const svc = makeService(db);

      const id = await svc.ingestPractitioner({
        knowledgeType: 'session_summary',
        title: 'Session recap',
        body: 'Fixed billing bug.',
        sessionId: 's-1',
        tags: ['billing'],
      });

      expect(id).toBe(99);
      const pgCall = (db.query.mock.calls as any[]).find((c) =>
        c[0].includes('workflow_memory_practitioner'),
      );
      expect(pgCall).toBeDefined();
      expect(pgCall[1]).toContain('session_summary');
    });

    it('upserts into Qdrant wm_practitioner collection', async () => {
      const db = makeDb(() => ({ rows: [{ id: 100 }] }));
      const svc = makeService(db);

      await svc.ingestPractitioner({ knowledgeType: 'correction', title: 'T', body: 'B' });

      const [collection] = mockUpsert.mock.calls[0] as any[];
      expect(collection).toBe('wm_practitioner');
    });

    it('generates embedding from title + body concatenated', async () => {
      const emb = makeEmbeddingService();
      const db = makeDb(() => ({ rows: [{ id: 1 }] }));
      const svc = makeService(db, emb);

      await svc.ingestPractitioner({ knowledgeType: 'correction', title: 'TT', body: 'BB' });

      expect(emb.generateEmbedding).toHaveBeenCalledWith('TT\nBB', 'wm_ingest_practitioner');
    });

    it('stores optional arrays with defaults', async () => {
      const db = makeDb(() => ({ rows: [{ id: 1 }] }));
      const svc = makeService(db);

      await svc.ingestPractitioner({ knowledgeType: 'session_summary', title: 'T', body: 'B' });

      const pgCall = (db.query.mock.calls as any[]).find((c) =>
        c[0].includes('workflow_memory_practitioner'),
      );
      const params = pgCall[1] as any[];
      // params: [knowledgeType, title, body, sessionId, commitRange, filesTouched, toolsUsed, tags]
      expect(params[5]).toEqual([]); // filesTouched
      expect(params[6]).toEqual([]); // toolsUsed
      expect(params[7]).toEqual([]); // tags
    });
  });

  // ── getStats ───────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns counts from all five tables', async () => {
      let callIndex = 0;
      const counts = [12, 34, 56, 78, 3];
      const db = makeDb(() => ({ rows: [{ cnt: counts[callIndex++] }] }));
      const svc = makeService(db);

      const stats = await svc.getStats();

      expect(stats.principles).toBe(12);
      expect(stats.patterns).toBe(34);
      expect(stats.practitioner).toBe(56);
      expect(stats.retrievals).toBe(78);
      expect(stats.reconciliations).toBe(3);
    });

    it('issues five COUNT(*) queries', async () => {
      const db = makeDb(() => ({ rows: [{ cnt: 0 }] }));
      const svc = makeService(db);

      await svc.getStats();

      expect(db.query).toHaveBeenCalledTimes(5);
      const sqls = (db.query.mock.calls as any[]).map((c) => c[0]);
      expect(sqls.some((s: string) => s.includes('workflow_memory_principles'))).toBe(true);
      expect(sqls.some((s: string) => s.includes('workflow_memory_patterns'))).toBe(true);
      expect(sqls.some((s: string) => s.includes('workflow_memory_practitioner'))).toBe(true);
      expect(sqls.some((s: string) => s.includes('workflow_memory_retrievals'))).toBe(true);
      expect(sqls.some((s: string) => s.includes('workflow_memory_reconciliations'))).toBe(true);
    });

    it('converts COUNT() string result to number', async () => {
      const db = makeDb(() => ({ rows: [{ cnt: '42' }] }));
      const svc = makeService(db);

      const stats = await svc.getStats();

      expect(typeof stats.principles).toBe('number');
      expect(stats.principles).toBe(42);
    });
  });

  // ── collectionForLayer (via query) ─────────────────────────────────────────

  describe('layer → collection mapping', () => {
    it('principle maps to wm_domain', async () => {
      mockSearch.mockResolvedValue([]);
      const svc = makeService();
      await svc.query({ query: 'x', layers: ['principle'] });
      expect(mockSearch).toHaveBeenCalledWith('wm_domain', expect.any(Object));
    });

    it('pattern maps to wm_workflow', async () => {
      mockSearch.mockResolvedValue([]);
      const svc = makeService();
      await svc.query({ query: 'x', layers: ['pattern'] });
      expect(mockSearch).toHaveBeenCalledWith('wm_workflow', expect.any(Object));
    });

    it('practitioner maps to wm_practitioner', async () => {
      mockSearch.mockResolvedValue([]);
      const svc = makeService();
      await svc.query({ query: 'x', layers: ['practitioner'] });
      expect(mockSearch).toHaveBeenCalledWith('wm_practitioner', expect.any(Object));
    });
  });

  // ── logRetrieval (indirectly via query) ────────────────────────────────────

  describe('logRetrieval (via query with sessionId)', () => {
    it('groups hits by layer and inserts one row per layer that has hits', async () => {
      mockSearch
        .mockResolvedValueOnce([
          { score: 0.9, payload: { pg_id: 1, title: 'T1', body: 'B1', tags: [] } },
          { score: 0.8, payload: { pg_id: 2, title: 'T2', body: 'B2', tags: [] } },
        ])
        .mockResolvedValueOnce([
          { score: 0.7, payload: { pg_id: 3, title: 'T3', body: 'B3', tags: [] } },
        ])
        .mockResolvedValue([]);

      const db = makeDb();
      const svc = makeService(db);

      await svc.query({
        query: 'test',
        layers: ['principle', 'pattern', 'practitioner'],
        sessionId: 'my-session',
      });

      const retrievalInserts = (db.query.mock.calls as any[]).filter((c) =>
        c[0].includes('workflow_memory_retrievals'),
      );
      // principle has 2 hits → 1 insert; pattern has 1 hit → 1 insert; practitioner has 0 → no insert
      expect(retrievalInserts).toHaveLength(2);
    });

    it('passes correct session_id and query_text to retrieval log', async () => {
      mockSearch
        .mockResolvedValueOnce([
          { score: 0.85, payload: { pg_id: 5, title: 'T', body: 'B', tags: [] } },
        ])
        .mockResolvedValue([]);

      const db = makeDb();
      const svc = makeService(db);

      await svc.query({ query: 'my-query', layers: ['principle'], sessionId: 'sid-42' });

      const insertCall = (db.query.mock.calls as any[]).find((c) =>
        c[0].includes('workflow_memory_retrievals'),
      );
      expect(insertCall[1][0]).toBe('sid-42');
      expect(insertCall[1][1]).toBe('my-query');
    });
  });
});
