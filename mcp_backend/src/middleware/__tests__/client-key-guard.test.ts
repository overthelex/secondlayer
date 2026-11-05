/**
 * Client API keys reach only /api/v2/mcp: every other REST surface that accepts API keys
 * (worker heartbeat, internal stats, tool catalogue, substrate) refuses them and logs it.
 */
import express from 'express';
import request from 'supertest';
import { createClientKeyGuard } from '../client-key-guard';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

function makeApp(authAs: any, adminInDb = false) {
  const db = {
    query: jest.fn(async (sql: string) => (String(sql).includes('FROM users') ? { rows: [{ admin: adminInDb }] } : { rows: [] })),
  };
  const app = express();
  app.use((req: any, _res, next) => { Object.assign(req, authAs); next(); });
  app.get('/api/internal/db-stats', createClientKeyGuard(db) as any, (_req, res) => { res.json({ ok: true }); });
  const logged = () => db.query.mock.calls
    .filter(([sql]: any[]) => String(sql).includes('INSERT INTO mcp_access_log'))
    .map(([, params]: any[]) => params[1]);
  return { app, logged };
}

describe('createClientKeyGuard', () => {
  it('refuses a non-admin client key and logs endpoint_denied', async () => {
    const { app, logged } = makeApp({ authType: 'apikey', clientKey: 'sl_client', user: { id: 'u-client-1', is_admin: false } });
    const res = await request(app).get('/api/internal/db-stats');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('API_KEY_V2_ONLY');
    expect(logged()).toEqual(['endpoint_denied']);
  });

  it('lets an admin key through (flag on the user or in the DB)', async () => {
    expect((await request(makeApp({ authType: 'apikey', user: { id: 'u-admin-1', is_admin: true } }).app).get('/api/internal/db-stats')).status).toBe(200);
    expect((await request(makeApp({ authType: 'apikey', user: { id: 'u-admin-2' } }, true).app).get('/api/internal/db-stats')).status).toBe(200);
  });

  it('lets a legacy env key (no user) and a JWT user through', async () => {
    expect((await request(makeApp({ authType: 'apikey' }).app).get('/api/internal/db-stats')).status).toBe(200);
    expect((await request(makeApp({ authType: 'jwt', user: { id: 'u-web' } }).app).get('/api/internal/db-stats')).status).toBe(200);
  });
});
