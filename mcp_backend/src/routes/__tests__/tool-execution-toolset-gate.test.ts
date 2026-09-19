/**
 * The deployment toolset gate on the DIRECT REST routes (`/api/tools`).
 *
 * MCP_TOOLSET narrowed every MCP transport but not this router, and since
 * 2026-09-18 that is a jurisdiction leak rather than a theoretical one: the same
 * image runs as lawrider.uk on GCP and lawrider.ch on cthulhu, the Swiss corpus
 * is still on the GCP disk, and an authenticated caller could POST
 * /api/tools/ch_get_act_text there and read it. Same shape in reverse on cthulhu.
 *
 * Four doors lead into the registry — list, batch, stream and single call — and
 * all four are checked here, because gating three of them is the same as gating
 * none.
 */

import express from 'express';
import request from 'supertest';
import { createToolExecutionRoutes } from '../tool-execution-routes';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// Authentication is not what this test is about; let every request through as a
// key-authenticated client with credit.
jest.mock('../../middleware/dual-auth.js', () => ({
  dualAuth: (req: any, _res: any, next: any) => {
    req.clientKey = 'test-key-0000';
    req.user = { id: 'user-1' };
    next();
  },
}));
jest.mock('../../middleware/balance-check.js', () => ({
  createBalanceCheckMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../services/uk-judgment-access.js', () => ({
  gatedRegistryOf: () => null,
  checkJudgmentAccess: jest.fn(),
  logJudgmentAccess: jest.fn(),
}));

const ORIGINAL_TOOLSET = process.env.MCP_TOOLSET;
afterEach(() => {
  if (ORIGINAL_TOOLSET === undefined) delete process.env.MCP_TOOLSET;
  else process.env.MCP_TOOLSET = ORIGINAL_TOOLSET;
});

const LOCAL_TOOLS = [
  { name: 'uk_get_act', description: '', inputSchema: { type: 'object', properties: {} } },
  { name: 'ch_get_act_text', description: '', inputSchema: { type: 'object', properties: {} } },
  { name: 'search_court_decisions', description: '', inputSchema: { type: 'object', properties: {} } },
];

function makeApp() {
  const executeTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
  const app = express();
  app.use(express.json());
  app.use('/api/tools', createToolExecutionRoutes({
    toolRegistry: {
      getLocalToolDefinitions: () => LOCAL_TOOLS,
      getAllTools: async () => LOCAL_TOOLS,
      getToolCounts: () => ({ backend: LOCAL_TOOLS.length }),
      executeTool,
      handles: () => true,
    } as any,
    db: { query: jest.fn() },
    serviceProxy: {} as any,
    billingService: {} as any,
    costTracker: { createTrackingRecord: jest.fn(), completeTrackingRecord: jest.fn() } as any,
    creditService: {} as any,
    batchDocumentTools: {} as any,
  }));
  return { app, executeTool };
}

describe('/api/tools under MCP_TOOLSET=uk', () => {
  beforeEach(() => { process.env.MCP_TOOLSET = 'uk'; });

  it('refuses a Swiss tool without executing it', async () => {
    const { app, executeTool } = makeApp();
    const res = await request(app).post('/api/tools/ch_get_act_text').send({ as_of: '2020-01-01' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not available on this deployment/);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('refuses a Ukrainian tool on the streaming route too', async () => {
    const { app, executeTool } = makeApp();
    const res = await request(app)
      .post('/api/tools/search_court_decisions/stream')
      .send({ query: 'x' });

    expect(res.status).toBe(404);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('refuses the same tools inside a batch, per call', async () => {
    const { app, executeTool } = makeApp();
    const res = await request(app).post('/api/tools/batch').send({
      calls: [{ name: 'ch_get_act_text' }, { name: 'search_court_decisions' }],
    });

    expect(res.status).toBe(200);
    const errors = (res.body.results || []).map((r: any) => r.error);
    expect(errors).toEqual(['Not available', 'Not available']);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('lists only the tools it would actually run', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/tools');

    const names = (res.body.tools || []).map((t: any) => t.name);
    expect(names).toEqual(['uk_get_act']);
    expect(res.body.count).toBe(1);
  });

  it('does not refuse a UK tool', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/tools/uk_get_act').send({ leg_id: 'ukpga/2006/46' });

    // Deliberately narrow. Everything past the gate — billing, credit, cost
    // tracking — needs doubles this file does not build, so the request dies
    // later with a 500 and never reaches executeTool. What this asserts is the
    // only thing it can honestly prove: the gate let it by. Claiming more would
    // be a test that passes for the wrong reason.
    expect(res.status).not.toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/not available on this deployment/);
  });
});

describe('/api/tools under MCP_TOOLSET=ch', () => {
  beforeEach(() => { process.env.MCP_TOOLSET = 'ch'; });

  it('mirrors the rule: the Swiss box refuses the British tool', async () => {
    const { app, executeTool } = makeApp();
    const res = await request(app).post('/api/tools/uk_get_act').send({ leg_id: 'ukpga/2006/46' });

    expect(res.status).toBe(404);
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe('/api/tools with no MCP_TOOLSET', () => {
  it('narrows nothing, so legal.org.ua is unaffected', async () => {
    delete process.env.MCP_TOOLSET;
    const { app } = makeApp();
    const res = await request(app).get('/api/tools');

    expect((res.body.tools || []).map((t: any) => t.name)).toEqual(
      ['uk_get_act', 'ch_get_act_text', 'search_court_decisions']);
  });
});
