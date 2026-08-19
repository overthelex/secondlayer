/**
 * Tests for erau-proxy-routes — GET /search
 *
 * Regression: ERAU pages its results (10 per request by default) ordered by ascending
 * registry id. Reading only the first page returned the ten oldest advocates and hid
 * everyone certified in recent years.
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

const PAGE_SIZE = 200;
const MAX_RESULTS = 2000;

/** Build `count` upstream rows; certificate dates run from 1994 forward. */
function makeUpstreamRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(8000 + i),
    surname: 'Мельник',
    firstname: `Імʼя${i}`,
    middlename: 'Петрович',
    racalc: 'Рада адвокатів Київської області',
    certnum: `21/${i}`,
    certat: `${1994 + Math.floor(i / 9)}-03-30 00:00:00`,
    certcalc: 'Київська обласна КДКА',
  }));
}

/**
 * Mock fetch that honours limit/offset over a fixed corpus.
 *
 * The registry reports `total` as a *string* ("291"), and ids likewise. An earlier
 * version of this mock returned a number, which let a `typeof total === 'number'` check
 * in the proxy silently collapse the total to 0 and stop paging after the first page —
 * the fixture hid the bug from the suite and it reached production. Keep the string.
 */
function mockPagedFetch(rows: any[], options: { omitTotal?: boolean } = {}) {
  const calls: Array<{ limit: number; offset: number }> = [];
  const fn = jest.fn(async (url: string) => {
    const parsed = new URL(url);
    const limit = Number(parsed.searchParams.get('limit') ?? 10);
    const offset = Number(parsed.searchParams.get('offset') ?? 0);
    calls.push({ limit, offset });
    const items = rows.slice(offset, offset + limit);
    return {
      ok: true,
      status: 200,
      json: async () => (options.omitTotal ? { items } : { items, total: String(rows.length) }),
    };
  });
  (global as any).fetch = fn;
  return calls;
}

function makeApp(cacheService?: any) {
  const app = express();
  app.use(express.json());
  app.use('/', createERAUProxyRoutes(cacheService, undefined));
  return app;
}

function makeCacheService(overrides: any = {}) {
  return {
    getBySurname: jest.fn(async () => null),
    cacheResults: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('GET /search', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete (global as any).fetch;
  });

  it('rejects a surname shorter than 2 characters', async () => {
    const res = await request(makeApp()).get('/search').query({ surname: 'М' });
    expect(res.status).toBe(400);
  });

  it('returns the whole result set, not just the first page', async () => {
    const rows = makeUpstreamRows(291);
    const calls = mockPagedFetch(rows);

    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(291);
    expect(calls).toEqual([
      { limit: PAGE_SIZE, offset: 0 },
      { limit: PAGE_SIZE, offset: PAGE_SIZE },
    ]);
  });

  it('includes advocates certified after 2019, which the first page never contained', async () => {
    const rows = makeUpstreamRows(291);
    mockPagedFetch(rows);

    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    const years = res.body.map((l: any) => Number(String(l.certat).slice(0, 4)));
    expect(Math.max(...years)).toBeGreaterThanOrEqual(2019);
    // Before the fix only the ten lowest ids came back, all of them pre-2019.
    const oldestTen = rows.slice(0, 10).map((r) => r.certat);
    expect(oldestTen.every((d) => Number(d.slice(0, 4)) < 2019)).toBe(true);
  });

  it('orders the result set by certificate date, newest first', async () => {
    mockPagedFetch(makeUpstreamRows(291));

    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    const dates = res.body.map((l: any) => l.certat);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(Number(dates[0].slice(0, 4))).toBeGreaterThan(Number(dates[dates.length - 1].slice(0, 4)));
  });

  it('puts rows without a certificate date last', async () => {
    const rows = makeUpstreamRows(3);
    rows[0].certat = '';
    mockPagedFetch(rows);

    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    expect(res.body).toHaveLength(3);
    expect(res.body[res.body.length - 1].certat).toBeFalsy();
  });

  it('coerces the upstream string id to a number', async () => {
    mockPagedFetch(makeUpstreamRows(3));
    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });
    expect(res.body.every((l: any) => typeof l.id === 'number')).toBe(true);
    expect(res.body.map((l: any) => l.id).sort()).toEqual([8000, 8001, 8002]);
  });

  it('stops paging when a short page comes back', async () => {
    const calls = mockPagedFetch(makeUpstreamRows(5));
    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });
    expect(res.body).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });

  it('keeps paging when the registry reports the total as a string', async () => {
    // Regression: a numeric type-check on `total` reduced every search to its first page.
    const calls = mockPagedFetch(makeUpstreamRows(291));

    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    expect(res.body).toHaveLength(291);
    expect(res.body.length).toBeGreaterThan(PAGE_SIZE);
    expect(calls).toHaveLength(2);
  });

  it('keeps paging when the registry omits the total entirely', async () => {
    const calls = mockPagedFetch(makeUpstreamRows(291), { omitTotal: true });

    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    expect(res.body).toHaveLength(291);
    expect(calls).toHaveLength(2);
  });

  it('reads the tail of an oversized result set, where the recent admissions are', async () => {
    // A two-character query such as "ко" matches over 22000 advocates upstream. ERAU
    // orders by ascending registry id and offers no sort parameter, so capping from the
    // head would return the oldest 2000 and make "newest first" meaningless.
    const rows = makeUpstreamRows(22071);
    const calls = mockPagedFetch(rows);

    const res = await request(makeApp()).get('/search').query({ surname: 'ко' });

    expect(res.body).toHaveLength(MAX_RESULTS);
    // The probe reads the head only to learn the total; collection starts at the tail.
    expect(calls[0]).toEqual({ limit: PAGE_SIZE, offset: 0 });
    expect(calls[1]).toEqual({ limit: PAGE_SIZE, offset: rows.length - MAX_RESULTS });

    const lowestReturnedId = Math.min(...res.body.map((l: any) => l.id));
    expect(lowestReturnedId).toBe(Number(rows[rows.length - MAX_RESULTS].id));
  });

  it('does not truncate a result set that fits under the cap', async () => {
    const rows = makeUpstreamRows(MAX_RESULTS);
    mockPagedFetch(rows);

    const res = await request(makeApp()).get('/search').query({ surname: 'Мельник' });

    expect(res.body).toHaveLength(MAX_RESULTS);
  });

  it('passes the upstream total to the cache alongside the rows', async () => {
    mockPagedFetch(makeUpstreamRows(291));
    const cache = makeCacheService();

    await request(makeApp(cache)).get('/search').query({ surname: 'Мельник' });

    expect(cache.cacheResults).toHaveBeenCalledWith(
      'Мельник',
      expect.arrayContaining([expect.objectContaining({ id: 8000 })]),
      291
    );
    expect(cache.cacheResults.mock.calls[0][1]).toHaveLength(291);
  });

  it('serves a cache hit without calling upstream', async () => {
    const fetchSpy = jest.fn();
    (global as any).fetch = fetchSpy;
    const cache = makeCacheService({
      getBySurname: jest.fn(async () => [{ id: 1, surname: 'Мельник', firstname: 'Іван' }]),
    });

    const res = await request(makeApp(cache)).get('/search').query({ surname: 'Мельник' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves a cached empty result set instead of re-querying upstream', async () => {
    const fetchSpy = jest.fn();
    (global as any).fetch = fetchSpy;
    const cache = makeCacheService({ getBySurname: jest.fn(async () => []) });

    const res = await request(makeApp(cache)).get('/search').query({ surname: 'Неіснуючий' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to a stale result set when upstream fails', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const cache = makeCacheService({
      getBySurname: jest.fn(async (_s: string, opts: any = {}) =>
        (opts.allowStale ? [{ id: 42, surname: 'Мельник', firstname: 'Іван' }] : null)
      ),
    });

    const res = await request(makeApp(cache)).get('/search').query({ surname: 'Мельник' });

    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe(42);
    expect(cache.getBySurname).toHaveBeenLastCalledWith('Мельник', { allowStale: true });
  });

  it('reports 502 when upstream fails and nothing is cached', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const res = await request(makeApp(makeCacheService())).get('/search').query({ surname: 'Мельник' });
    expect(res.status).toBe(502);
  });
});
