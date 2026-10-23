import { acquireMcpCall, documentsFetched, resetMcpUsageLimits, setMcpUsageLimitCache } from '../mcp-usage-limits';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const BRAUN = {
  user_id: 'braun', max_concurrent: 2, per_minute: 3, per_hour: 100, per_day: 10,
  doc_fetch_per_day: 5, warn_ratio: '0.80',
};

const db = { query: jest.fn(async () => ({ rows: [BRAUN] })) };
const T0 = Date.UTC(2026, 9, 23, 12, 0, 5);

beforeEach(() => {
  resetMcpUsageLimits();
  db.query.mockClear();
});

describe('acquireMcpCall', () => {
  it('does not limit an account without a row', async () => {
    for (let i = 0; i < 50; i++) {
      const d = await acquireMcpCall(db, 'someone-else', 'search_court_decisions', {}, T0);
      expect(d.allowed).toBe(true);
    }
  });

  it('refuses the call past the per-minute limit and tells when to retry', async () => {
    for (let i = 0; i < 3; i++) {
      const d = await acquireMcpCall(db, 'braun', 'search_npa', {}, T0);
      expect(d.allowed).toBe(true);
      if (d.allowed) d.release();
    }
    const d = await acquireMcpCall(db, 'braun', 'search_npa', {}, T0);
    expect(d).toEqual({ allowed: false, message: expect.stringContaining('3 запитів на хвилину') });
    expect((d as any).message).toContain('через 55 с');
  });

  it('opens a fresh window the next minute', async () => {
    for (let i = 0; i < 3; i++) await acquireMcpCall(db, 'braun', 'search_npa', {}, T0).then((d) => d.allowed && d.release());
    const next = await acquireMcpCall(db, 'braun', 'search_npa', {}, T0 + 60_000);
    expect(next.allowed).toBe(true);
  });

  it('caps concurrent calls and frees the slot on release', async () => {
    const a = await acquireMcpCall(db, 'braun', 'search_npa', {}, T0);
    const b = await acquireMcpCall(db, 'braun', 'search_npa', {}, T0 + 60_000);
    const c = await acquireMcpCall(db, 'braun', 'search_npa', {}, T0 + 120_000);
    expect(a.allowed && b.allowed).toBe(true);
    expect(c).toEqual({ allowed: false, message: expect.stringContaining('одночасних запитів (2)') });
    if (a.allowed) { a.release(); a.release(); } // double release is harmless
    const d = await acquireMcpCall(db, 'braun', 'search_npa', {}, T0 + 180_000);
    expect(d.allowed).toBe(true);
  });

  it('warns at 80% of the daily quota and blocks at 100%', async () => {
    const results = [];
    for (let i = 0; i < 11; i++) {
      const d = await acquireMcpCall(db, 'braun', 'search_npa', {}, T0 + i * 60_000);
      results.push(d);
      if (d.allowed) d.release();
    }
    expect((results[6] as any).warning).toBeUndefined();
    expect((results[7] as any).warning).toContain('8 з 10');
    expect(results[9].allowed).toBe(true);
    expect(results[10]).toEqual({ allowed: false, message: expect.stringContaining('10 запитів на добу') });
  });

  it('counts load_full_texts by documents, not by calls', async () => {
    const ok = await acquireMcpCall(db, 'braun', 'get_court_decision', { doc_id: 1 }, T0);
    expect(ok.allowed).toBe(true);
    if (ok.allowed) ok.release();
    const bulk = await acquireMcpCall(db, 'braun', 'load_full_texts', { doc_ids: [1, 2, 3, 4, 5] }, T0 + 60_000);
    expect(bulk).toEqual({ allowed: false, message: expect.stringContaining('5 повних текстів') });
  });

  it('uses INCRBY on the cache for a multi-document call', async () => {
    const increment = jest.fn(async (_k: string, _t: number, by = 1) => by);
    setMcpUsageLimitCache({ increment } as any);
    const d = await acquireMcpCall(db, 'braun', 'load_full_texts', { doc_ids: [1, 2, 3] }, T0);
    expect(d.allowed).toBe(true);
    expect(increment).toHaveBeenCalledWith(expect.stringMatching(/^mcplim:braun:docs:/), 86400, 3);
  });
});

describe('documentsFetched', () => {
  it('counts full-text tools only', () => {
    expect(documentsFetched('search_court_decisions', {})).toBe(0);
    expect(documentsFetched('get_court_decision', {})).toBe(1);
    expect(documentsFetched('load_full_texts', { doc_ids: [1, 2, 3], max_docs: 2 })).toBe(2);
    expect(documentsFetched('load_full_texts', { doc_ids: new Array(1000).fill(1) })).toBe(1000);
  });
});
