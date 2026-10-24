/**
 * EdsrFtsService.searchFulltext — party filter SQL construction
 *
 * Verifies that party_name / party_role are anchored into the tsquery match
 * (phraseto_tsquery + to_tsquery role forms), not appended as bag-of-words.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EdsrFtsService, buildPartyRoleRegex, buildPartyYearLegs, partyNameTokenCount } from '../edrsr-fts-service';

const findRegexParam = (params: any[]): string | undefined =>
  params.find((p) => typeof p === 'string' && (p.includes('(?:до|проти)') || p.includes('за[[:space:]]+позов')));

const makeDb = () => {
  const calls: { sql: string; params: any[] }[] = [];
  const db = {
    calls,
    query: jest.fn((sql: string, params: any[]) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows: [] });
    }),
  };
  return db;
};

describe('EdsrFtsService.searchFulltext party filters', () => {
  it('uses only plainto_tsquery when no party filter', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('оренда землі', db);

    const sql = db.calls[0].sql;
    expect(sql).toContain("plainto_tsquery('simple', $1)");
    expect(sql).not.toContain('phraseto_tsquery');
    expect(sql).not.toMatch(/&& to_tsquery/); // no role-noun clause
    expect(sql).not.toContain('f.full_text ~*'); // no role regex post-filter
    // topical query is the only tsquery param
    expect(db.calls[0].params[0]).toBe('оренда землі');
  });

  it('anchors party_name as a phrase combined with && ', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('доставка вантажу', db, { party_name: 'Нова Пошта' });

    const sql = db.calls[0].sql;
    expect(sql).toContain('phraseto_tsquery');
    expect(sql).toContain('&&');
    // party name passed as a bound param, never interpolated
    expect(db.calls[0].params).toContain('Нова Пошта');
  });

  it('adds enumerated role case-forms for defendant', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('доставка', db, { party_name: 'Нова Пошта', party_role: 'defendant' });

    const sql = db.calls[0].sql;
    expect(sql).toContain("to_tsquery('simple'");
    expect(sql).toContain('відповідач');
    expect(sql).toContain('відповідача');
    expect(sql).not.toContain('позивач');
    // claim-clause regex post-filter, anchored on the respondent slot "до …"
    expect(sql).toContain('f.full_text ~*');
    const rx = findRegexParam(db.calls[0].params);
    expect(rx).toBeDefined();
    expect(rx).toContain('(?:до|проти)');
    expect(rx).toContain('Нова[[:space:]]+Пошта');
    expect(rx).toContain('[»"”“]'); // required closing quote discriminates the exact entity
  });

  it('adds plaintiff role forms for plaintiff', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('спір', db, { party_name: 'Нова Пошта', party_role: 'plaintiff' });

    const sql = db.calls[0].sql;
    expect(sql).toContain('позивач');
    expect(sql).not.toContain('відповідач');
    const rx = findRegexParam(db.calls[0].params);
    expect(rx).toBeDefined();
    expect(rx).toContain('за[[:space:]]+позов'); // anchored on the claimant slot
  });

  it('falls back to pool.query when connect() yields no usable client (wrapper pool regression)', async () => {
    // Regression: compare_practice_pro_contra passes a wrapper pool whose connect() exists but
    // returns undefined; the statement-timeout path did `client.release()` and crashed with
    // "Cannot read properties of undefined (reading 'release')". Must fall back, not throw.
    const svc = new EdsrFtsService();
    const db = makeDb() as any;
    db.connect = jest.fn(() => Promise.resolve(undefined)); // connect present but yields nothing

    await expect(svc.searchFulltext('поновлення строку', db)).resolves.toBeDefined();
    expect(db.query).toHaveBeenCalled();           // fell back to the plain pooled query
    expect(db.calls[0].sql).toContain('cand AS MATERIALIZED'); // still runs cap-before-rank
  });

  it('treats party_role "any" as no role constraint', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('спір', db, { party_name: 'Нова Пошта', party_role: 'any' });

    const sql = db.calls[0].sql;
    expect(sql).toContain('phraseto_tsquery');
    expect(sql).not.toMatch(/&& to_tsquery/);
    expect(sql).not.toContain('f.full_text ~*');
  });
});

describe('EdsrFtsService.searchFulltext total', () => {
  // `total` used to be `safeLimit * 10` as soon as there was more than one page, so the
  // same query reported 30 at limit 3 and 1000 at limit 100 — a number describing the
  // request rather than the registry, which a reading model cannot tell from a real count.
  const makeDbWithRows = (rowCount: number, candTotal: number) => {
    const calls: { sql: string; params: any[] }[] = [];
    const rows = Array.from({ length: rowCount }, (_v, i) => ({
      doc_id: i + 1, headline: 'x', rank: 0.5, cand_total: candTotal,
    }));
    return {
      calls,
      query: jest.fn((sql: string, params: any[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows });
      }),
    };
  };

  it('counts the candidate set instead of scaling with the caller\'s limit', async () => {
    const svc = new EdsrFtsService();
    const db = makeDbWithRows(4, 137);

    const res = await svc.searchFulltext('іпотека', db as any, {}, 3, 0);

    expect(db.calls[0].sql).toContain('(SELECT count(*)::int FROM cand) AS cand_total');
    expect(res.total).toBe(137);        // not 3 * 10
    expect(res.returned).toBe(3);       // the extra probe row is trimmed
    expect(res.has_more).toBe(true);
    expect(res.total_is_floor).toBeUndefined();
  });

  it('reports the same total whatever limit the caller asked for', async () => {
    const svc = new EdsrFtsService();
    const small = await svc.searchFulltext('іпотека', makeDbWithRows(4, 137) as any, {}, 3, 0);
    const large = await svc.searchFulltext('іпотека', makeDbWithRows(101, 137) as any, {}, 100, 0);

    expect(small.total).toBe(large.total);
  });

  it('flags a total that hit the candidate cap as a floor, not an exact count', async () => {
    const svc = new EdsrFtsService();
    const res = await svc.searchFulltext('договір', makeDbWithRows(21, 2000) as any, {}, 20, 0);

    expect(res.total).toBe(2000);
    expect(res.total_is_floor).toBe(true);
    expect(res.candidate_cap).toBe(2000);
  });

  it('reports 0 for a page past the end rather than inventing one', async () => {
    const svc = new EdsrFtsService();
    const res = await svc.searchFulltext('іпотека', makeDbWithRows(0, 137) as any, {}, 20, 100000);

    expect(res.total).toBe(0);
    expect(res.returned).toBe(0);
    expect(res.has_more).toBe(false);
  });
});

describe('EdsrFtsService.searchFulltext candidate cap + timeout (LEXAI-2087)', () => {
  const makeDbWithRows = (rowCount: number, candTotal: number) => {
    const calls: { sql: string; params: any[] }[] = [];
    const rows = Array.from({ length: rowCount }, (_v, i) => ({
      doc_id: i + 1, headline: 'x', rank: 0.5, cand_total: candTotal,
    }));
    return {
      calls,
      query: jest.fn((sql: string, params: any[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows });
      }),
    };
  };

  it('uses the default 2000-candidate cap when none is given', async () => {
    const svc = new EdsrFtsService();
    const db = makeDbWithRows(1, 1);
    await svc.searchFulltext('іпотека', db as any);
    expect(db.calls[0].sql).toMatch(/LIMIT 2000\s*\)/);
  });

  it('honours a smaller candidate cap and reports the floor against it', async () => {
    const svc = new EdsrFtsService();
    const db = makeDbWithRows(16, 100);
    const res = await svc.searchFulltext('морал:* & шкода:*', db as any, {}, 15, 0, undefined, 'морал:* & шкода:*', { candidateCap: 100 });
    expect(db.calls[0].sql).toMatch(/LIMIT 100\s*\)/);
    expect(res.total).toBe(100);
    expect(res.total_is_floor).toBe(true);
    expect(res.candidate_cap).toBe(100);
  });

  it('clamps the cap to the default ceiling and ignores junk values', async () => {
    const svc = new EdsrFtsService();
    const big = makeDbWithRows(1, 1);
    await svc.searchFulltext('іпотека', big as any, {}, 20, 0, undefined, undefined, { candidateCap: 999999 });
    expect(big.calls[0].sql).toMatch(/LIMIT 2000\s*\)/);
    const junk = makeDbWithRows(1, 1);
    await svc.searchFulltext('іпотека', junk as any, {}, 20, 0, undefined, undefined, { candidateCap: -5 });
    expect(junk.calls[0].sql).toMatch(/LIMIT 2000\s*\)/);
  });

  it('marks a statement timeout as timed_out (not a genuine 0) and does not cache it', async () => {
    const svc = new EdsrFtsService();
    const cache = {
      getCachedFtsResults: jest.fn(() => Promise.resolve(null)),
      setCachedFtsResults: jest.fn(() => Promise.resolve()),
    };
    (svc as any).edsrCache = cache;
    const db = {
      query: jest.fn(() => Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))),
    };
    const res = await svc.searchFulltext('морал:* & шкода:*', db as any, {}, 15, 0, undefined, 'морал:* & шкода:*');
    expect(res.total).toBe(0);
    expect(res.timed_out).toBe(true);
    expect(cache.setCachedFtsResults).not.toHaveBeenCalled();
  });

  it('keys the cache by candidate cap so a capped total never answers an uncapped query', async () => {
    const svc = new EdsrFtsService();
    const keys: string[] = [];
    (svc as any).edsrCache = {
      getCachedFtsResults: jest.fn((k: string) => { keys.push(k); return Promise.resolve(null); }),
      setCachedFtsResults: jest.fn(() => Promise.resolve()),
    };
    await svc.searchFulltext('x', makeDbWithRows(1, 1) as any, {}, 20, 0, undefined, 'морал:*');
    await svc.searchFulltext('x', makeDbWithRows(1, 1) as any, {}, 20, 0, undefined, 'морал:*', { candidateCap: 100 });
    expect(keys[0]).toBe('tsq:морал:*');
    expect(keys[1]).toBe('tsq:морал:*|cap:100');
  });
});

describe('buildPartyRoleRegex', () => {
  it('anchors the defendant on the respondent slot and requires a closing quote', () => {
    const rx = buildPartyRoleRegex('Нова Пошта', 'defendant');
    expect(rx.startsWith('(?:до|проти)')).toBe(true);
    expect(rx).toContain('Нова[[:space:]]+Пошта[»"”“]');
  });

  it('anchors the plaintiff on the claimant slot', () => {
    const rx = buildPartyRoleRegex('Нова Пошта', 'plaintiff');
    expect(rx.startsWith('за[[:space:]]+позов')).toBe(true);
  });

  it('escapes regex metacharacters in user-supplied names', () => {
    const rx = buildPartyRoleRegex('А.Б (В)', 'defendant');
    expect(rx).toContain('\\.');
    expect(rx).toContain('\\(');
    expect(rx).toContain('\\)');
  });
});

describe('EdsrFtsService.filterDocIdsByConstraints', () => {
  it('adds the claim-clause role regex post-filter on the fused candidates', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.filterDocIdsByConstraints([1, 2, 3], { party_name: 'Нова Пошта', party_role: 'defendant' }, db);

    const sql = db.calls[0].sql;
    expect(sql).toContain('f.doc_id = ANY($1)');
    expect(sql).toContain('phraseto_tsquery');
    expect(sql).toContain('f.full_text ~*');
    const rx = findRegexParam(db.calls[0].params);
    expect(rx).toContain('(?:до|проти)');
  });

  it('is a pass-through (no query) when no party/instance constraint is given', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    const res = await svc.filterDocIdsByConstraints([1, 2], {}, db);

    expect(db.calls).toHaveLength(0);
    expect(res.size).toBe(2);
  });
});

describe('buildPartyYearLegs', () => {
  it('scans exactly the requested years, newest first — never the current year by default', () => {
    // LEXAI-2086: with the newest leg pinned to the current year, the 2026 partition filled
    // the cap for a Q1-2025 query and the date filter then dropped every candidate.
    expect(buildPartyYearLegs('2025-01-01', '2025-03-31', 2026)).toEqual([{ minYear: 2025, maxYear: 2025 }]);
    expect(buildPartyYearLegs('2023-06-01', '2025-03-31', 2026)).toEqual([
      { minYear: 2025, maxYear: 2025 },
      { minYear: 2024, maxYear: 2024 },
      { minYear: 2023, maxYear: 2023 },
    ]);
  });

  it('opens the newest leg upward without date_to and the oldest downward without date_from', () => {
    const legs = buildPartyYearLegs(undefined, undefined, 2026);
    expect(legs[0]).toEqual({ minYear: 2026, maxYear: null }); // takes p_future too
    expect(legs[legs.length - 1]).toEqual({ minYear: null, maxYear: 2005 }); // takes pre-2005
    expect(legs).toHaveLength(2026 - 2005 + 1);
    expect(buildPartyYearLegs('2024-01-01', undefined, 2026)).toEqual([
      { minYear: 2026, maxYear: null },
      { minYear: 2025, maxYear: 2025 },
      { minYear: 2024, maxYear: 2024 },
    ]);
  });

  it('folds years below the floor into one leg', () => {
    expect(buildPartyYearLegs('1999-01-01', '2006-12-31', 2026)).toEqual([
      { minYear: 2006, maxYear: 2006 },
      { minYear: 1999, maxYear: 2005 },
    ]);
    expect(buildPartyYearLegs('1999-01-01', '2002-12-31', 2026)).toEqual([{ minYear: 1999, maxYear: 2002 }]);
  });

  it('returns no legs for an inverted range', () => {
    expect(buildPartyYearLegs('2025-01-01', '2024-12-31', 2026)).toEqual([]);
  });
});

describe('partyNameTokenCount', () => {
  it('counts word tokens the way the simple parser splits them', () => {
    expect(partyNameTokenCount('ПРИВАТБАНК')).toBe(1);
    expect(partyNameTokenCount('Нова Пошта')).toBe(2);
    expect(partyNameTokenCount('КБ "ПРИВАТБАНК"')).toBe(2);
    expect(partyNameTokenCount('ЛУЇ ДРЕЙФУС КОМПАНІ УКРАЇНА')).toBe(4);
  });
});

/** A db whose single FTS statement answers with the given row. */
const makeCountDb = (row: any) => {
  const db = {
    calls: [] as { sql: string; params: any[] }[],
    query: jest.fn((sql: string, params: any[]) => {
      db.calls.push({ sql, params });
      return Promise.resolve({ rows: sql.includes('cand AS MATERIALIZED') ? [row] : [] });
    }),
  };
  return db;
};
const ftsCall = (db: { calls: { sql: string; params: any[] }[] }) => {
  const c = db.calls.find((x) => x.sql.includes('cand AS MATERIALIZED'));
  if (!c) throw new Error('no candidate-CTE query was issued');
  return c;
};

describe('EdsrFtsService.countByParty', () => {
  it('unwraps a Database wrapper to its pg Pool for the statement_timeout', async () => {
    const svc = new EdsrFtsService();
    const clientCalls: string[] = [];
    const client = {
      query: jest.fn((sql: string) => { clientCalls.push(sql); return Promise.resolve({ rows: [] }); }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn(() => Promise.resolve(client)) };
    // BaseDatabase: connect() pings and resolves to nothing; getPool() is the real pool.
    const wrapper = { query: jest.fn(), connect: jest.fn(() => Promise.resolve(undefined)), getPool: () => pool };

    await svc.countByParty('Нова Пошта', 'defendant', wrapper);
    expect(clientCalls.some((q) => /^SET LOCAL statement_timeout = \d+$/.test(q))).toBe(true);
    expect(wrapper.query).not.toHaveBeenCalled();
  });

  it('runs the count under a statement_timeout and turns a timeout into advice', async () => {
    const svc = new EdsrFtsService();
    const clientCalls: string[] = [];
    const client = {
      query: jest.fn((sql: string) => {
        clientCalls.push(sql);
        if (sql.includes('cand AS MATERIALIZED')) {
          return Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    const db = { query: jest.fn(), connect: jest.fn(() => Promise.resolve(client)) };

    await expect(svc.countByParty('Нова Пошта', 'defendant', db)).rejects.toThrow(/Звузьте період/);
    expect(clientCalls[1]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(Number(clientCalls[1].split('= ')[1])).toBeLessThan(60_000);
    expect(clientCalls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('answers count, breakdown and sample from one statement', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({
      cum: [10],
      distinct_cases: 8,
      by_court: [{ court_code: 1690, count: 7 }, { court_code: 2605, count: 3 }],
      sample: [{ doc_id: '5', cause_num: '1/2', court_code: 1, justice_kind: 3, adjudication_date: '2025-03-30T21:00:00+00:00' }],
    });
    const res = await svc.countByParty('Нова Пошта', 'defendant', db, { date_from: '2025-01-01', date_to: '2025-03-31' }, 50);

    const { sql, params } = ftsCall(db);
    expect(db.calls.filter((c) => c.sql.includes('edrsr_fulltext'))).toHaveLength(1);
    expect(sql).toContain('to_tsquery(\'simple\', \'відповідач');
    expect(sql).toContain('LIMIT 50');
    expect(params).toContain('Нова Пошта');
    expect(res.total).toBe(10);
    expect(res.distinct_cases).toBe(8);
    expect(res.by_court).toEqual([{ court_code: 1690, count: 7 }, { court_code: 2605, count: 3 }]);
    expect(res.sample).toHaveLength(1);
    expect(res.sample![0].doc_id).toBe(5);
    expect(res.capped).toBeUndefined();
  });

  it('omits the sample unless asked', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({ cum: [3], distinct_cases: 3, by_court: [{ court_code: 1, count: 3 }] });
    const res = await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db);
    expect(ftsCall(db).sql).not.toContain('AS sample');
    expect(res.sample).toBeUndefined();
  });

  it('separates distinct cases from documents (ЕВЕРЛІҐАЛ read 684 "справ" against 591 real)', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({ cum: [684], distinct_cases: 591, by_court: [{ court_code: 4824, count: 400 }, { court_code: 1003, count: 284 }] });
    const res = await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db, { date_from: '2025-01-01', date_to: '2025-12-31' });

    expect(res.total).toBe(684);
    // cases: the global count(DISTINCT cause_num), never the sum of a per-court breakdown —
    // a case appears once per instance it passed through
    expect(res.distinct_cases).toBe(591);
    expect(ftsCall(db).sql).toContain('count(DISTINCT cause_num) FROM cand');
  });

  /**
   * LEXAI-2086. ПРИВАТБАНК, 2025-01-01..2025-03-31 answered "0 cases, capped": a LIMIT on raw
   * matches, taken from the 2026 partition before the date filter, was full of 2026
   * documents the filter then threw away. Measured after the fix: 50,553 documents.
   */
  it('applies the period inside the scan, before anything can stop it', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({ cum: [50553], distinct_cases: 37015, by_court: [] });
    const res = await svc.countByParty('Приватбанк', undefined, db, { date_from: '2025-01-01', date_to: '2025-03-31' });

    const { sql, params } = ftsCall(db);
    // Only the requested year is scanned — no 2026 leg, no ±1 widening.
    expect(sql).toContain('f.adj_year >= 2025 AND f.adj_year <= 2025');
    expect(sql).not.toMatch(/adj_year [<>]=? 202[46]/);
    expect(sql).not.toContain('l1 AS');
    // The date filter sits inside the leg, and no LIMIT truncates a leg.
    const leg = sql.slice(sql.indexOf('l0 AS MATERIALIZED'), sql.indexOf('c0 AS'));
    expect(leg).toContain("d.adjudication_date >= ($2::date)::timestamp AT TIME ZONE 'Europe/Kyiv'");
    expect(leg).toContain("d.adjudication_date < ($3::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv'");
    expect(leg).not.toMatch(/LIMIT/);
    expect(params).toEqual(['Приватбанк', '2025-01-01', '2025-03-31']);
    expect(res.total).toBe(50553);
    expect(res.capped).toBeUndefined();
  });

  it('selects by the AND form and rechecks the phrase only after the date filter', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({ cum: [3857], distinct_cases: 3019, by_court: [] });
    await svc.countByParty('Нова Пошта', undefined, db, { date_from: '2025-01-01', date_to: '2025-03-31' });

    const sql = ftsCall(db).sql;
    // GIN on the AND form never opens the TOASTed tsv; the phrase check does, so it runs on
    // the 3,991 date-filtered rows instead of 13,880 (the old shape timed out).
    expect(sql).toContain("f.tsv @@ (plainto_tsquery('simple', $1))");
    expect(sql).toMatch(/\) j\s+WHERE j\.tsv @@ phraseto_tsquery\('simple', \$1\)/);
  });

  it('skips the phrase recheck for a one-word name', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({ cum: [1], distinct_cases: 1, by_court: [] });
    await svc.countByParty('ПРИВАТБАНК', undefined, db, { date_from: '2025-01-01', date_to: '2025-03-31' });
    const sql = ftsCall(db).sql;
    expect(sql).not.toContain('phraseto_tsquery');
    expect(sql).not.toContain('f.tsv,'); // tsv is not carried out of the scan, so never detoasted
  });

  it('runs the role regex after the date filter too', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({ cum: [37], distinct_cases: 29, by_court: [] });
    await svc.countByParty('Нова Пошта', 'defendant', db, { date_from: '2025-01-01', date_to: '2025-03-31' });
    const { sql, params } = ftsCall(db);
    expect(sql).toMatch(/WHERE j\.tsv @@ phraseto_tsquery\('simple', \$1\) AND j\.full_text ~\* \$2/);
    expect(findRegexParam(params)).toBeDefined();
  });

  it('keeps the plan-shape guards: materialized legs, fenced scan, per-leg partition bounds', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({ cum: [], distinct_cases: 0, by_court: [] });
    await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db, {}, 10);
    const sql = ftsCall(db).sql;
    // Unfenced, the GIN misestimate hash-joins a seq scan of all 136M edrsr_documents rows.
    expect(sql).toContain('l0 AS MATERIALIZED');
    expect(sql).toContain('cand AS MATERIALIZED');
    expect(sql).toMatch(/OFFSET 0\s+\) m\s+JOIN edrsr_documents d ON d\.doc_id = m\.doc_id/);
    // Every leg bounds d.adjudication_date to its own year, which prunes edrsr_documents.
    expect(sql).toContain("d.adjudication_date >= '2014-01-01'::timestamp AT TIME ZONE 'Europe/Kyiv' AND d.adjudication_date < '2015-01-01'::timestamp AT TIME ZONE 'Europe/Kyiv'");
    // Older legs are gated on what the newer ones counted, so a full cap skips their scans.
    expect(sql).toContain('(SELECT n FROM c0) < 25000');
    expect(sql).toMatch(/c1 AS \(\s+SELECT \(SELECT n FROM c0\) \+ count\(\*\)::int AS n FROM l1/);
    // Structural guard against a CTE following another without a comma.
    expect(sql).not.toMatch(/\)\s*\n\s*[a-z_0-9]+ AS (MATERIALIZED )?\(/);
  });

  it('flags capped only when older years were skipped, and says from which year it is exact', async () => {
    const svc = new EdsrFtsService();
    // 2026 alone counted 201,641 (measured): every older leg was skipped.
    const db = makeCountDb({ cum: [201641, 201641, 201641], distinct_cases: 145330, by_court: [{ court_code: 232, count: 2023 }] });
    const res = await svc.countByParty('ПРИВАТБАНК', undefined, db, { date_from: '2024-01-01' });

    expect(res.total).toBe(201641);
    expect(res.capped).toBe(true);
    expect(res.candidate_cap).toBe(25000);
    expect(res.counted_from_year).toBe(2026);
  });

  it('a capped result can never be zero, and a full scan is never capped', async () => {
    const svc = new EdsrFtsService();
    // Every year scanned, the last one pushing the total past the threshold: nothing was
    // skipped, so the count is exact however large it is.
    const full = makeCountDb({ cum: [10000, 20000, 30000], distinct_cases: 1, by_court: [] });
    const res = await svc.countByParty('X', undefined, full, { date_from: '2024-01-01', date_to: '2026-12-31' });
    expect(res.total).toBe(30000);
    expect(res.capped).toBeUndefined();

    // An empty answer is exact zero.
    const empty = makeCountDb({ cum: [0, 0, 0], distinct_cases: 0, by_court: [] });
    const res0 = await svc.countByParty('X', undefined, empty, { date_from: '2024-01-01', date_to: '2026-12-31' });
    expect(res0.total).toBe(0);
    expect(res0.capped).toBeUndefined();
  });

  it('answers an inverted range without touching the database', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({});
    const res = await svc.countByParty('ПРИВАТБАНК', undefined, db, { date_from: '2025-01-01', date_to: '2024-12-31' }, 5);
    expect(res).toEqual({ total: 0, distinct_cases: 0, by_court: [], sample: [] });
    expect(db.calls.some((c) => c.sql.includes('edrsr_fulltext'))).toBe(false);
  });

  it('applies justice_kind inside each leg', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb({ cum: [1], distinct_cases: 1, by_court: [] });
    await svc.countByParty('ПРИВАТБАНК', undefined, db, { date_from: '2025-01-01', date_to: '2025-12-31', justice_kind: 3 });
    const { sql, params } = ftsCall(db);
    const leg = sql.slice(sql.indexOf('l0 AS MATERIALIZED'), sql.indexOf('c0 AS'));
    expect(leg).toContain('d.justice_kind = $4');
    expect(params[3]).toBe(3);
  });
});

describe('EdsrFtsService dedicated EDRSR pool', () => {
  it('routes queries to the dedicated pool instead of the caller-passed one', async () => {
    const dedicated = makeDb();
    const passed = makeDb();
    const svc = new EdsrFtsService(dedicated as any);
    await svc.searchFulltext('оренда землі', passed);
    expect(dedicated.query).toHaveBeenCalled();
    expect(passed.query).not.toHaveBeenCalled();
  });

  it('uses the caller-passed pool when no dedicated pool is configured', async () => {
    const passed = makeDb();
    const svc = new EdsrFtsService();
    await svc.searchFulltext('оренда землі', passed);
    expect(passed.query).toHaveBeenCalled();
  });
});

/**
 * judge filter — resolved through edrsr_judges_distinct rather than scanned.
 *
 * The old predicate `LOWER(d.judge) LIKE LOWER('%v%')` seq-scanned all 26
 * partitions of edrsr_documents (135.8M rows). These pin the three outcomes,
 * because getting the middle one wrong returns unrelated judges rather than
 * an empty result — a silent correctness bug, not a visible failure.
 */
describe('EdsrFtsService.searchFulltext judge filter', () => {
  // first query is the judge resolve, second is the actual search
  const makeDbWithJudges = (judgeRows: any[] | Error) => {
    const calls: { sql: string; params: any[] }[] = [];
    let seen = 0;
    return {
      calls,
      query: jest.fn((sql: string, params: any[]) => {
        calls.push({ sql, params });
        if (seen++ === 0 && sql.includes('edrsr_judges_distinct')) {
          if (judgeRows instanceof Error) return Promise.reject(judgeRows);
          return Promise.resolve({ rows: judgeRows });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
  };

  it('resolves the fragment and filters by equality, not LIKE', async () => {
    const svc = new EdsrFtsService();
    const db = makeDbWithJudges([
      { judge: 'Писана Таміла Олександрівна' },
      { judge: 'Писана Т.О.' },
    ]);
    await svc.searchFulltext('спір', db as any, { judge: 'Писана' });

    expect(db.calls[0].sql).toContain('edrsr_judges_distinct');
    expect(db.calls[0].params[0]).toBe('%Писана%');

    const search = db.calls[1];
    expect(search.sql).toContain('d.judge = ANY(');
    expect(search.sql).not.toContain('LOWER(d.judge) LIKE');
    // both spellings of the same judge are carried through
    expect(search.params).toContainEqual([
      'Писана Таміла Олександрівна',
      'Писана Т.О.',
    ]);
  });

  it('matches nothing when no judge matches the fragment', async () => {
    const svc = new EdsrFtsService();
    const db = makeDbWithJudges([]);
    await svc.searchFulltext('спір', db as any, { judge: 'Неіснуючий' });

    const search = db.calls[1];
    // must NOT silently drop the filter and return every judge
    expect(search.sql).toContain('FALSE');
    expect(search.sql).not.toContain('d.judge = ANY(');
  });

  it('falls back to the substring predicate when the lookup is unavailable', async () => {
    const svc = new EdsrFtsService();
    const db = makeDbWithJudges(new Error('relation "edrsr_judges_distinct" does not exist'));
    await svc.searchFulltext('спір', db as any, { judge: 'Писана' });

    const search = db.calls[1];
    // slow, but correct — never unfiltered
    expect(search.sql).toContain('LOWER(d.judge) LIKE LOWER(');
    expect(search.params).toContain('%Писана%');
  });
});
