import express from 'express';
import request from 'supertest';

jest.mock('../../utils/redis-client.js', () => ({ getRedisClient: async () => null }));

import { createCourtsRoutes } from '../courts-routes.js';

function app() {
  const db = { query: jest.fn(async () => ({ rows: [] })) };
  const r = createCourtsRoutes(db as never);
  const a = express();
  a.use('/sud', r.courts);
  a.use('/suddia', r.judges);
  return { a, db };
}

describe('/sud and /suddia routes', () => {
  it('redirects the bare judges path to the courts index', async () => {
    const res = await request(app().a).get('/suddia');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/sud');
  });

  it('answers 404 noindex for malformed slugs without touching the database', async () => {
    const { a, db } = app();
    for (const p of ['/sud/Bad_Slug', '/suddia/x--y', '/sud/%D0%B0']) {
      const res = await request(a).get(p);
      expect(res.status).toBe(404);
      expect(res.text).toContain('noindex');
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it('answers 404 for unknown courts and judges', async () => {
    for (const p of ['/sud/nema-takoho-sudu', '/suddia/nema-takoho-00000']) {
      expect((await request(app().a).get(p)).status).toBe(404);
    }
  });

  it('serves a valid empty sitemap', async () => {
    const res = await request(app().a).get('/suddia/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<urlset');
  });
});
