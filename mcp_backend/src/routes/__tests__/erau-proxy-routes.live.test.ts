/**
 * Live check of GET /search against the real ЄРАУ registry.
 *
 * The mocked suite once returned `total` as a JSON number while the registry returns a
 * string, which let a broken type-check ship to production looking fully tested. This
 * test talks to erau.unba.org.ua so the response shape is the real one. It is opt-in —
 * CI must not hammer НААУ — and it asserts on invariants rather than exact counts, since
 * the register grows.
 *
 *   ERAU_LIVE_TEST=1 npx jest erau-proxy-routes.live
 */

import express from 'express';
import request from 'supertest';
import { createERAUProxyRoutes } from '../erau-proxy-routes';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../utils/redis-client.js', () => ({
  getRedisClient: jest.fn(async () => null),
}));

const describeIfLive = process.env.ERAU_LIVE_TEST ? describe : describe.skip;

function makeApp() {
  const app = express();
  app.use(express.json());
  // No cache service: every call goes to the registry.
  app.use('/', createERAUProxyRoutes(undefined, undefined));
  return app;
}

const PAGE_SIZE = 200;
const MAX_RESULTS = 2000;

describeIfLive('GET /search against the live ЄРАУ registry', () => {
  jest.setTimeout(120000);

  it('returns far more than one page for a common surname', async () => {
    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    expect(res.status).toBe(200);
    // 291 at the time of writing; the register only grows.
    expect(res.body.length).toBeGreaterThan(PAGE_SIZE);
  });

  it('surfaces advocates certified in the last few years', async () => {
    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    const newest = res.body[0].certat as string;
    expect(Number(newest.slice(0, 4))).toBeGreaterThanOrEqual(2024);
  });

  it('orders by certificate date, newest first, with numeric ids', async () => {
    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    const dates = res.body.map((l: any) => l.certat);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(res.body.every((l: any) => typeof l.id === 'number')).toBe(true);
  });

  it('caps a very broad query and keeps the recent end of it', async () => {
    // "ко" matches over 22000 advocates, well past the cap.
    const res = await request(makeApp()).get('/search').query({ surname: 'ко' });

    expect(res.body).toHaveLength(MAX_RESULTS);
    const recent = res.body.filter((l: any) => Number(String(l.certat).slice(0, 4)) >= 2019);
    expect(recent.length).toBeGreaterThan(MAX_RESULTS / 2);
  });
});
