/**
 * Access policy on the REST tool routes (/api/tools): client API keys are v2-MCP-only,
 * operator tools are admin-only, vault tools always run as the caller, and every refusal
 * is written to mcp_access_log for the security alarm.
 */
import express from 'express';
import request from 'supertest';
import { createToolExecutionRoutes } from '../tool-execution-routes';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

let authAs: any = {};
jest.mock('../../middleware/dual-auth.js', () => ({
  dualAuth: (req: any, _res: any, next: any) => { Object.assign(req, authAs); next(); },
}));
jest.mock('../../middleware/balance-check.js', () => ({
  createBalanceCheckMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../services/uk-judgment-access.js', () => ({
  gatedRegistryOf: () => null, checkJudgmentAccess: jest.fn(), logJudgmentAccess: jest.fn(),
}));

const TOOLS = ['search_legislation', 'nextcloud_upload', 'get_document'].map((name) => ({
  name, description: '', inputSchema: { type: 'object', properties: {} },
}));

function makeApp() {
  const executeTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
  const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const app = express();
  app.use(express.json());
  app.use('/api/tools', createToolExecutionRoutes({
    toolRegistry: {
      getLocalToolDefinitions: () => TOOLS, getAllTools: async () => TOOLS,
      getToolCounts: () => ({ backend: TOOLS.length }), executeTool,
      validateToolArgs: async () => null, handles: () => true,
      getRoute: () => null,
    } as any,
    db,
    serviceProxy: {} as any,
    billingService: {} as any,
    costTracker: {
      createTrackingRecord: jest.fn(), completeTrackingRecord: jest.fn(),
      estimateCost: jest.fn().mockResolvedValue({}),
    } as any,
    creditService: { calculateCreditsForTool: jest.fn().mockResolvedValue(0) } as any,
    batchDocumentTools: {} as any,
  }));
  const accessLogOutcomes = () => db.query.mock.calls
    .filter(([sql]: any[]) => String(sql).includes('INSERT INTO mcp_access_log'))
    .map(([, params]: any[]) => params[1]);
  return { app, executeTool, accessLogOutcomes };
}

const CLIENT_KEY = { authType: 'apikey', clientKey: 'sl_client00000000', user: { id: 'client-1', is_admin: false } };
const ADMIN_KEY = { authType: 'apikey', clientKey: 'sl_admin000000000', user: { id: 'admin-1', is_admin: true } };
const WEB_USER = { authType: 'jwt', user: { id: 'web-1', is_admin: false } };

describe('/api/tools access policy', () => {
  it.each([
    ['/api/tools/search_legislation', {}],
    ['/api/tools/search_legislation/stream', {}],
    ['/api/tools/batch', { calls: [{ name: 'search_legislation' }] }],
  ])('refuses a client API key on %s and logs endpoint_denied', async (path, body) => {
    authAs = CLIENT_KEY;
    const { app, executeTool, accessLogOutcomes } = makeApp();
    const res = await request(app).post(path).send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('API_KEY_V2_ONLY');
    expect(executeTool).not.toHaveBeenCalled();
    expect(accessLogOutcomes()).toEqual(['endpoint_denied']);
  });

  it('refuses an operator tool to a web user, including inside a batch', async () => {
    authAs = WEB_USER;
    const { app, executeTool, accessLogOutcomes } = makeApp();
    const single = await request(app).post('/api/tools/nextcloud_upload').send({ remote_path: 'x', local_file_path: '/proc/self/environ' });
    const batch = await request(app).post('/api/tools/batch').send({ calls: [{ name: 'search_legislation' }, { name: 'nextcloud_upload' }] });
    expect(single.status).toBe(403);
    expect(batch.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
    expect(accessLogOutcomes()).toEqual(['tool_denied', 'tool_denied']);
  });

  it('lets an admin key through', async () => {
    authAs = ADMIN_KEY;
    const { app, executeTool } = makeApp();
    const res = await request(app).post('/api/tools/nextcloud_upload').send({ remote_path: 'x' });
    expect(res.status).not.toBe(403);
    expect(executeTool).toHaveBeenCalledWith('nextcloud_upload', expect.anything());
  });

  it('runs vault tools as the caller whatever userId the request names', async () => {
    authAs = WEB_USER;
    const { app, executeTool } = makeApp();
    await request(app).post('/api/tools/get_document').send({ documentId: 'doc-1', userId: 'victim' });
    await request(app).post('/api/tools/batch').send({ calls: [{ name: 'get_document', arguments: { documentId: 'doc-2', userId: 'victim' } }] });
    const userIds = executeTool.mock.calls.map(([, args]: any[]) => args.userId);
    expect(userIds).toEqual(['web-1', 'web-1']);
  });
});
