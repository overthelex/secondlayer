/**
 * EdsrFtsService.searchFulltext — party filter SQL construction
 *
 * Verifies that party_name / party_role are anchored into the tsquery match
 * (phraseto_tsquery + to_tsquery role forms), not appended as bag-of-words.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  EdsrFtsService, buildPartyRoleRegex, buildPartyAnyRoleRegex, partySplitToken, partyAnyRoleRecheckSql,
  PARTY_WINDOW_BEFORE, PARTY_WINDOW_AFTER,
  buildYearLegs, yearLegPredicate, kyivDayBoundsSql, partyNameTokenCount,
  partyNorm, partyCore, partyNameKeys, partiesLegCovered,
} from '../edrsr-fts-service';

const COVERAGE_SQL = 'edrsr_parties_coverage';

const findRegexParam = (params: any[]): string | undefined =>
  params.find((p) => typeof p === 'string' && (p.includes('(?:до|проти)') || p.includes('за[[:space:]]+позов')));

const makeDb = () => {
  const calls: { sql: string; params: any[] }[] = [];
  const db = {
    calls,
    query: jest.fn((sql: string, params: any[]) => {
      // The edrsr_parties_coverage lookup (LEXAI-1760) answers "no year covered" and is not
      // recorded, so calls[0] stays the search statement.
      if (sql.includes(COVERAGE_SQL)) return Promise.resolve({ rows: [] });
      calls.push({ sql, params });
      return Promise.resolve({ rows: [] });
    }),
  };
  return db;
};

/** Like makeDb, but edrsr_parties_coverage lists `years`. */
const makeCoveredDb = (years: number[]) => {
  const calls: { sql: string; params: any[] }[] = [];
  const db = {
    calls,
    query: jest.fn((sql: string, params: any[]) => {
      if (sql.includes(COVERAGE_SQL)) return Promise.resolve({ rows: years.map((adj_year) => ({ adj_year })) });
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
    expect(keys[0]).toBe('y1|tsq:морал:*');
    expect(keys[1]).toBe('y1|tsq:морал:*|cap:100');
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

// LEXAI-2124. The patterns run in PostgreSQL ARE (`~*`); for these tests they are translated
// to an equivalent JS RegExp (POSIX [[:space:]] → \s, case-insensitive). The snippets are
// real Укрексімбанк contexts from prod EDRSR decisions (2025).
describe('buildPartyAnyRoleRegex (LEXAI-2124)', () => {
  const toJs = (ere: string) => new RegExp(ere.replace(/\[\[:space:\]\]/g, '\\s'), 'iu');
  const rx = toJs(buildPartyAnyRoleRegex('Укрексімбанк'));

  it.each([
    // payee bank requisites in a utility-debt court order
    'на користь Міського комунального підприємства «Чернівцітеплокомуненерго», р/р НОМЕР_2 в АТ «Укрексімбанк» м. Чернівці, МФО 322313, код 34519280',
    'на користь стягувача Державного комунального підприємства «Луцьктепло», яке знаходиться за адресою: 43021, місто Луцьк, IBAN НОМЕР_2 МФО 322313 АТ «Укрексімбанк», заборгованість',
    'на користь стягувача комунального підприємства «Луцькводоканал», що знаходиться за адресою: м. Луцьк, вул. Дубнівська, 26, р/р № НОМЕР_2 в АТ «Укрексімбанк», МФО 322313',
    'Стягнути в солідарному порядку з відповідачів ОСОБА_1 та ОСОБА_2 на користь МКП «Чернівцітеплокомуненерго» заборгованість в сумі 4 998,72 гривень, на р/р НОМЕР_2 в АТ «Укрексімбанк»',
    'Кошти перерахувати на розрахунковий рахунок НОМЕР_2 в АТ «Укрексімбанк», Код ЄДРПОУ 03344065.',
    // enforcement: the debtor's account in the bank, banks listed for arrest
    'арешт коштів боржника в АТ «Укрексімбанк»',
    'АТ Ощадбанк, МФО 300465; АТ СЕНС БАНК, МФО 300346; АТ Укрексімбанк, МФО 322313;',
    // evidence / custody / requests — "до" without a claim
    'журнал банківських виписок АТ «Укрексімбанк» за листопад 2021 рік на 93 арк.',
    'які передані на зберігання до АТ «Укрексімбанк» (58005, м. Чернівці',
    'запити до банківських установ: - АТ «ПУМБ»; - запити до АТ «Укрексімбанк» з метою встановлення',
    'направлено до АТ "Укрексімбанк"; № 9/2024/35158255 від 28.02.2024',
  ])('does not count a non-party mention: %s', (text) => {
    expect(rx.test(text)).toBe(false);
  });

  it.each([
    'за позовом Акціонерного товариства «Укрексімбанк» до ДП «Чайка» про стягнення',
    'зустрічний позов ОСОБА_1 до АТ "Укрексімбанк" про витребування майна',
    'за зустрічним позовом ТОВ Аграрний дім Геліос до АТ «Укрексімбанк», за участі третіх осіб',
    'третя особа: Акціонерне товариство «Укрексімбанк», про стягнення боргу',
    'на стороні відповідача АТ Укрексімбанк, позовні вимоги задоволено',
    'кредитор: Публічне акціонерне товариство Державний експортно-імпортний банк України (АТ Укрексімбанк) (вул. Антоновича, 127',
    'апеляційну скаргу АТ «Укрексімбанк» залишено без задоволення',
    'заява АТ «Укрексімбанк» про видачу дубліката виконавчого листа',
    'представник АТ "Укрексімбанк" заперечував проти відкладення',
    'вимоги, забезпечені заставою майна боржника - кредитори - АТ "Укрексімбанк", ТОВ "Немишвіль-ГВ"',
  ])('counts a party mention: %s', (text) => {
    expect(rx.test(text)).toBe(true);
  });

  it('does not count a longer company name that merely starts with the party name', () => {
    expect(toJs(buildPartyAnyRoleRegex('Нова Пошта')).test('відповідач: ТОВ «Нова Пошта Інтернешнл»')).toBe(false);
    expect(toJs(buildPartyAnyRoleRegex('Нова Пошта')).test('відповідач: ТОВ «Нова Пошта»')).toBe(true);
  });

  it('escapes regex metacharacters in user-supplied names', () => {
    const ere = buildPartyAnyRoleRegex('А.Б (В)');
    expect(ere).toContain('А\\.Б[[:space:]]+\\(В\\)');
  });
});

describe('partySplitToken / partyAnyRoleRecheckSql (LEXAI-2124)', () => {
  it('splits on the longest word, lower-cased', () => {
    expect(partySplitToken('Укрексімбанк')).toBe('укрексімбанк');
    expect(partySplitToken('Нова Пошта')).toBe('пошта');
    expect(partySplitToken('«Фінансова компанія Фангарант груп»')).toBe('фінансова'); // first of equals
  });

  it('runs the pattern over windows around each mention, not over the whole text', () => {
    const sql = partyAnyRoleRecheckSql('j', '$4', '$5');
    expect(sql).toContain('string_to_array(lower(j.full_text), $4)');
    expect(sql).toContain(`right(w.p, ${PARTY_WINDOW_BEFORE}) || $4 || left(w.nx, ${PARTY_WINDOW_AFTER}) ~* $5`);
    expect(sql).not.toMatch(/j\.full_text ~\*/);
  });

  it('windows reach further than the pattern can (equivalence with a whole-text match)', () => {
    // claim span (250) + "позов…" + legal form must fit before the split token.
    expect(PARTY_WINDOW_BEFORE).toBeGreaterThanOrEqual(400);
    expect(PARTY_WINDOW_AFTER).toBeGreaterThan(0);
  });
});

describe('EdsrFtsService.filterDocIdsByConstraints', () => {
  it('adds the claim-clause role regex post-filter on the fused candidates', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.filterDocIdsByConstraints([1, 2, 3], { party_name: 'Нова Пошта', party_role: 'defendant' }, db);

    const sql = db.calls[0].sql;
    expect(sql).toContain('f.doc_id = ANY($1)');
    // With a role the regex enforces adjacency, so the name is AND-ed (no tsv heap recheck).
    expect(sql).toContain('plainto_tsquery');
    expect(sql).not.toContain('phraseto_tsquery');
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

describe('buildYearLegs', () => {
  it('scans exactly the requested years, newest first — never the current year by default', () => {
    // LEXAI-2086: with the newest leg pinned to the current year, the 2026 partition filled
    // the cap for a Q1-2025 query and the date filter then dropped every candidate.
    expect(buildYearLegs('2025-01-01', '2025-03-31', 2026)).toEqual([{ minYear: 2025, maxYear: 2025 }]);
    expect(buildYearLegs('2023-06-01', '2025-03-31', 2026)).toEqual([
      { minYear: 2025, maxYear: 2025 },
      { minYear: 2024, maxYear: 2024 },
      { minYear: 2023, maxYear: 2023 },
    ]);
  });

  it('opens the newest leg upward without date_to and the oldest downward without date_from', () => {
    const legs = buildYearLegs(undefined, undefined, 2026);
    expect(legs[0]).toEqual({ minYear: 2026, maxYear: null }); // takes p_future too
    expect(legs[legs.length - 1]).toEqual({ minYear: null, maxYear: 2005 }); // takes pre-2005
    expect(legs).toHaveLength(2026 - 2005 + 1);
    expect(buildYearLegs('2024-01-01', undefined, 2026)).toEqual([
      { minYear: 2026, maxYear: null },
      { minYear: 2025, maxYear: 2025 },
      { minYear: 2024, maxYear: 2024 },
    ]);
  });

  it('folds years below the floor into one leg', () => {
    expect(buildYearLegs('1999-01-01', '2006-12-31', 2026)).toEqual([
      { minYear: 2006, maxYear: 2006 },
      { minYear: 1999, maxYear: 2005 },
    ]);
    expect(buildYearLegs('1999-01-01', '2002-12-31', 2026)).toEqual([{ minYear: 1999, maxYear: 2002 }]);
  });

  it('returns no legs for an inverted range', () => {
    expect(buildYearLegs('2025-01-01', '2024-12-31', 2026)).toEqual([]);
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

/** One year leg's answer, as the per-leg statement returns it (LEXAI-2177). */
type LegRow = { n: number; causes?: string[]; by_court?: Array<{ court_code: number; count: number }>; sample?: any[] };
const LEG_MARK = 'WITH l AS MATERIALIZED';

/**
 * A db whose year-leg statements answer, in call order (newest year first), with `legs`;
 * legs beyond the list count 0. An entry may be an Error to reject that leg with.
 */
const makeCountDb = (legs: Array<LegRow | Error>) => {
  let k = 0;
  const db = {
    calls: [] as { sql: string; params: any[] }[],
    query: jest.fn((sql: string, params: any[]) => {
      db.calls.push({ sql, params });
      if (!sql.includes(LEG_MARK)) return Promise.resolve({ rows: [] });
      const leg = legs[k++] ?? { n: 0 };
      if (leg instanceof Error) return Promise.reject(leg);
      return Promise.resolve({ rows: [{ causes: [], by_court: [], ...leg }] });
    }),
  };
  return db;
};
const legCalls = (db: { calls: { sql: string; params: any[] }[] }) => db.calls.filter((x) => x.sql.includes(LEG_MARK));
const ftsCall = (db: { calls: { sql: string; params: any[] }[] }) => {
  const c = legCalls(db)[0];
  if (!c) throw new Error('no year-leg query was issued');
  return c;
};
const pgTimeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const causes = (n: number, prefix = 'c') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** In-memory stand-in for EdsrCacheService's generic JSON methods. */
const makeLegCache = () => {
  const store = new Map<string, any>();
  return {
    store,
    getCachedJson: jest.fn((ns: string, key: string) => Promise.resolve(store.has(`${ns}|${key}`) ? JSON.parse(store.get(`${ns}|${key}`)) : null)),
    setCachedJson: jest.fn((ns: string, key: string, v: any, _ttl: number) => { store.set(`${ns}|${key}`, JSON.stringify(v)); return Promise.resolve(); }),
  };
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

    await svc.countByParty('Нова Пошта', 'defendant', wrapper, { date_from: '2025-01-01' });
    expect(clientCalls.some((q) => /^SET LOCAL statement_timeout = \d+$/.test(q))).toBe(true);
    expect(wrapper.query).not.toHaveBeenCalled();
  });

  it('runs each leg under a statement_timeout and turns a total timeout into advice', async () => {
    const svc = new EdsrFtsService();
    const clientCalls: string[] = [];
    const client = {
      query: jest.fn((sql: string) => {
        clientCalls.push(sql);
        if (sql.includes(LEG_MARK)) return Promise.reject(pgTimeout());
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    const db = { query: jest.fn(), connect: jest.fn(() => Promise.resolve(client)) };

    // date_from only: the parties-table fast path (both bounds) never asks the pool.
    await expect(svc.countByParty('Нова Пошта', 'defendant', db, { date_from: '2025-01-01' }))
      .rejects.toThrow(/Звузьте період/);
    expect(clientCalls[1]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(Number(clientCalls[1].split('= ')[1])).toBeLessThan(60_000);
    expect(clientCalls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('answers count, breakdown and sample of a one-year period from one statement', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{
      n: 10,
      causes: causes(8),
      by_court: [{ court_code: 1690, count: 7 }, { court_code: 2605, count: 3 }],
      sample: [{ doc_id: '5', cause_num: '1/2', court_code: 1, justice_kind: 3, adjudication_date: '2025-03-30T21:00:00+00:00' }],
    }]);
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
    expect(res.incomplete).toBeUndefined();
  });

  it('omits the sample unless asked', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 3, causes: causes(3), by_court: [{ court_code: 1, count: 3 }] }]);
    const res = await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db);
    expect(ftsCall(db).sql).not.toContain('AS sample');
    expect(res.sample).toBeUndefined();
  });

  it('separates distinct cases from documents (ЕВЕРЛІҐАЛ read 684 "справ" against 591 real)', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 684, causes: causes(591), by_court: [{ court_code: 4824, count: 400 }, { court_code: 1003, count: 284 }] }]);
    const res = await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db, { date_from: '2025-01-01', date_to: '2025-12-31' });

    expect(res.total).toBe(684);
    // cases: distinct cause_num over the whole candidate set, never the sum of a per-court
    // breakdown — a case appears once per instance it passed through
    expect(res.distinct_cases).toBe(591);
    expect(ftsCall(db).sql).toContain('array_agg(DISTINCT cause_num) FROM l WHERE cause_num IS NOT NULL');
  });

  it('merges legs: a case seen in two years is one case, court counts add up', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([
      { n: 3, causes: ['a', 'b'], by_court: [{ court_code: 1, count: 2 }, { court_code: 2, count: 1 }] },
      { n: 2, causes: ['b', 'c'], by_court: [{ court_code: 1, count: 2 }] },
    ]);
    const res = await svc.countByParty('X', undefined, db, { date_from: '2025-01-01', date_to: '2026-06-30' });
    expect(legCalls(db)).toHaveLength(2);
    expect(res.total).toBe(5);
    expect(res.distinct_cases).toBe(3);
    expect(res.by_court).toEqual([{ court_code: 1, count: 4 }, { court_code: 2, count: 1 }]);
    expect(res.by_court.reduce((s, c) => s + c.count, 0)).toBe(res.total);
  });

  it('merges the per-leg samples newest first and keeps the requested size', async () => {
    const svc = new EdsrFtsService();
    const s = (doc_id: number, d: string) => ({ doc_id, cause_num: null, court_code: 1, justice_kind: 1, adjudication_date: d });
    const db = makeCountDb([
      { n: 2, sample: [s(3, '2026-02-01T00:00:00Z'), s(2, '2026-01-01T00:00:00Z')] },
      { n: 2, sample: [s(1, '2025-12-01T00:00:00Z'), s(0, '2025-01-01T00:00:00Z')] },
    ]);
    const res = await svc.countByParty('X', undefined, db, { date_from: '2025-01-01', date_to: '2026-06-30' }, 3);
    expect(res.sample!.map((x) => x.doc_id)).toEqual([3, 2, 1]);
  });

  /**
   * LEXAI-2086. ПРИВАТБАНК, 2025-01-01..2025-03-31 answered "0 cases, capped": a LIMIT on raw
   * matches, taken from the 2026 partition before the date filter, was full of 2026
   * documents the filter then threw away. Measured after the fix: 50,553 documents.
   */
  it('applies the period inside the scan, before anything can stop it', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 50553, causes: causes(10) }]);
    const res = await svc.countByParty('Приватбанк', undefined, db, { date_from: '2025-01-01', date_to: '2025-03-31' });

    const { sql, params } = ftsCall(db);
    // Only the requested year is scanned — no 2026 leg, no ±1 widening.
    expect(legCalls(db)).toHaveLength(1);
    expect(sql).toContain('f.adj_year = 2025');
    expect(sql).not.toMatch(/adj_year [<>]=? 202[46]/);
    // The date filter sits inside the leg, and no LIMIT truncates it.
    expect(sql).toContain("d.adjudication_date >= ($2::date)::timestamp AT TIME ZONE 'Europe/Kyiv'");
    expect(sql).toContain("d.adjudication_date < ($3::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv'");
    expect(sql.slice(0, sql.indexOf('SELECT\n          (SELECT count(*)'))).not.toMatch(/LIMIT/);
    // Date bounds keep $2/$3; the any-role recheck (LEXAI-2124) appends split token + pattern.
    expect(params).toEqual(['Приватбанк', '2025-01-01', '2025-03-31', 'приватбанк', buildPartyAnyRoleRegex('Приватбанк')]);
    expect(res.total).toBe(50553);
    expect(res.capped).toBeUndefined();
  });

  it('selects by the AND form and rechecks the phrase only after the date filter', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 3857 }]);
    await svc.countByParty('Нова Пошта', undefined, db, { date_from: '2025-01-01', date_to: '2025-03-31' });

    const sql = ftsCall(db).sql;
    // GIN on the AND form never opens the TOASTed tsv; the phrase check does, so it runs on
    // the 3,991 date-filtered rows instead of 13,880 (the old shape timed out).
    expect(sql).toContain("f.tsv @@ (plainto_tsquery('simple', $1))");
    expect(sql).toMatch(/\) j\s+WHERE j\.tsv @@ phraseto_tsquery\('simple', \$1\)/);
  });

  it('skips the phrase recheck for a one-word name', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 1 }]);
    await svc.countByParty('ПРИВАТБАНК', undefined, db, { date_from: '2025-01-01', date_to: '2025-03-31' });
    const sql = ftsCall(db).sql;
    expect(sql).not.toContain('phraseto_tsquery');
    expect(sql).not.toContain('f.tsv,'); // tsv is not carried out of the scan, so never detoasted
  });

  it('anchors a role-less count to a party slot, after the date filter (LEXAI-2124)', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 446 }, { n: 629 }]);
    await svc.countByParty('Укрексімбанк', undefined, db, { date_from: '2025-01-01' });
    const { sql, params } = ftsCall(db);
    // full_text is carried out of the fenced scan and rechecked on the date-filtered rows only.
    expect(sql).toContain('SELECT f.doc_id, f.full_text');
    expect(sql).toMatch(/\) j\s+WHERE EXISTS \(/);
    expect(sql).toContain('string_to_array(lower(j.full_text), $3)');
    expect(params).toEqual(['Укрексімбанк', '2025-01-01', 'укрексімбанк', buildPartyAnyRoleRegex('Укрексімбанк')]);
  });

  it('keeps the claim-clause regex (not the any-role one) for an explicit role', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 1 }]);
    await svc.countByParty('Укрексімбанк', 'plaintiff', db, { date_from: '2025-01-01' });
    const { sql, params } = ftsCall(db);
    expect(sql).not.toContain('string_to_array');
    expect(params).not.toContain(buildPartyAnyRoleRegex('Укрексімбанк'));
  });

  it('runs the role regex after the date filter too', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 37 }]);
    await svc.countByParty('Нова Пошта', 'defendant', db, { date_from: '2025-01-01', date_to: '2025-03-31' });
    const { sql, params } = ftsCall(db);
    expect(sql).toMatch(/WHERE j\.tsv @@ phraseto_tsquery\('simple', \$1\) AND j\.full_text ~\* \$2/);
    expect(findRegexParam(params)).toBeDefined();
  });

  it('keeps the plan-shape guards: materialized leg, fenced scan, per-leg partition bounds, newest first', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([]);
    await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db, {}, 10);
    const calls = legCalls(db);
    const sql = calls[0].sql;
    // Unfenced, the GIN misestimate hash-joins a seq scan of all 136M edrsr_documents rows.
    expect(sql).toContain(LEG_MARK);
    expect(sql).toMatch(/OFFSET 0\s+\) m\s+JOIN edrsr_documents d ON d\.doc_id = m\.doc_id/);
    // One statement per year, newest first; each bounds d.adjudication_date to its own year.
    const y = new Date().getFullYear();
    expect(calls[0].sql).toContain(`f.adj_year >= ${y}`);
    expect(calls[1].sql).toContain(`f.adj_year = ${y - 1}`);
    expect(calls.some((c) => c.sql.includes("d.adjudication_date >= '2014-01-01'::timestamp AT TIME ZONE 'Europe/Kyiv' AND d.adjudication_date < '2015-01-01'::timestamp AT TIME ZONE 'Europe/Kyiv'"))).toBe(true);
    expect(calls).toHaveLength(y - 2005 + 1);
  });

  it('stops going back once the newer years counted the cap, and says from which year it is exact', async () => {
    const svc = new EdsrFtsService();
    // 2026 alone counted 201,641 (measured): every older leg is skipped — never queried.
    const db = makeCountDb([{ n: 201641, causes: causes(10) }]);
    const res = await svc.countByParty('ПРИВАТБАНК', undefined, db, { date_from: '2024-01-01', date_to: '2026-12-31' });

    expect(legCalls(db)).toHaveLength(1);
    expect(res.total).toBe(201641);
    expect(res.capped).toBe(true);
    expect(res.candidate_cap).toBe(25000);
    expect(res.counted_from_year).toBe(2026);
    expect(res.incomplete).toBeUndefined();
  });

  it('drops counted_from_year when a newer leg before the cap is still pending', async () => {
    const svc = new EdsrFtsService();
    // 2026 times out, 2025 alone reaches the cap, 2024 is skipped: "exact from 2025 onward"
    // would wrongly cover the uncounted 2026.
    const db = makeCountDb([pgTimeout(), { n: 30000 }]);
    const res = await svc.countByParty('X', undefined, db, { date_from: '2024-01-01', date_to: '2026-12-31' });
    expect(res.capped).toBe(true);
    expect(res.counted_from_year).toBeUndefined();
    expect(res.pending_years).toEqual([2026]);
  });

  it('a capped result can never be zero, and a full scan is never capped', async () => {
    const svc = new EdsrFtsService();
    // Every year scanned, the last one pushing the total past the threshold: nothing was
    // skipped, so the count is exact however large it is.
    const full = makeCountDb([{ n: 10000 }, { n: 10000 }, { n: 10000 }]);
    const res = await svc.countByParty('X', undefined, full, { date_from: '2024-01-01', date_to: '2026-12-31' });
    expect(res.total).toBe(30000);
    expect(res.capped).toBeUndefined();

    // An empty answer is exact zero.
    const empty = makeCountDb([]);
    const res0 = await svc.countByParty('X', undefined, empty, { date_from: '2024-01-01', date_to: '2026-12-31' });
    expect(res0.total).toBe(0);
    expect(res0.capped).toBeUndefined();
    expect(res0.incomplete).toBeUndefined();
  });

  it('answers an inverted range without touching the database', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([]);
    const res = await svc.countByParty('ПРИВАТБАНК', undefined, db, { date_from: '2025-01-01', date_to: '2024-12-31' }, 5);
    expect(res).toEqual({ total: 0, distinct_cases: 0, by_court: [], sample: [] });
    expect(db.calls.some((c) => c.sql.includes('edrsr_fulltext'))).toBe(false);
  });

  it('applies justice_kind inside each leg', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 1 }]);
    await svc.countByParty('ПРИВАТБАНК', undefined, db, { date_from: '2025-01-01', date_to: '2025-12-31', justice_kind: 3 });
    const { sql, params } = ftsCall(db);
    expect(sql).toContain('d.justice_kind = $4');
    expect(params[3]).toBe(3);
  });

  /**
   * LEXAI-2177. Укрексімбанк 2024-01-01..2026-10-31 (and with no dates) timed out with nothing
   * returned: all year legs shared one 50 s statement, and each year's ~7.8k bare mentions
   * take 54.6 s cold to recheck. A leg that does not finish must not throw away the others.
   */
  it('keeps the years that finished when another one times out, and names the missing one', async () => {
    const svc = new EdsrFtsService();
    const db = makeCountDb([{ n: 474, causes: causes(165) }, pgTimeout(), { n: 300, causes: causes(100, 'z') }]);
    const res = await svc.countByParty('Укрексімбанк', undefined, db, { date_from: '2024-01-01', date_to: '2026-10-31' });
    expect(legCalls(db)).toHaveLength(3);
    expect(res.total).toBe(774);
    expect(res.distinct_cases).toBe(265);
    expect(res.incomplete).toBe(true);
    expect(res.pending_years).toEqual([2025]);
    expect(res.capped).toBeUndefined();
    // No cache wired: a repeat would start over, and the result says so.
    expect(res.resumable).toBe(false);
  });

  it('stops starting legs when the wall-clock budget is spent', async () => {
    const svc = new EdsrFtsService();
    let clock = 1_000_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const db = makeCountDb([{ n: 1, causes: ['a'] }, { n: 1, causes: ['b'] }]);
      const query = db.query;
      db.query = jest.fn((sql: string, params: any[]) => {
        if (sql.includes(LEG_MARK)) clock += 30_000;
        return query(sql, params);
      }) as any;
      const res = await svc.countByParty('Укрексімбанк', undefined, db, { date_from: '2024-01-01', date_to: '2026-10-31' });
      // 2026 starts with the full budget, 2025 with what is left; 2024 never starts.
      expect(legCalls(db)).toHaveLength(2);
      expect(res.total).toBe(2);
      expect(res.pending_years).toEqual([2024]);
    } finally {
      now.mockRestore();
    }
  });

  it('resumes from cached years: a repeated call counts only what is still missing', async () => {
    const svc = new EdsrFtsService();
    const cache = makeLegCache();
    svc.setEdsrCache(cache as any);
    const range = { date_from: '2024-01-01', date_to: '2026-10-31' };

    const first = makeCountDb([{ n: 474, causes: causes(165) }, pgTimeout(), { n: 300, causes: causes(100, 'z') }]);
    const r1 = await svc.countByParty('Укрексімбанк', undefined, first, range);
    expect(r1.pending_years).toEqual([2025]);
    expect(r1.resumable).toBe(true);

    const second = makeCountDb([{ n: 339, causes: causes(52, 'y') }]);
    const r2 = await svc.countByParty('Укрексімбанк', undefined, second, range);
    expect(legCalls(second)).toHaveLength(1);
    expect(legCalls(second)[0].sql).toContain('f.adj_year = 2025');
    expect(r2.total).toBe(1113);
    expect(r2.distinct_cases).toBe(317);
    expect(r2.incomplete).toBeUndefined();

    // A timed-out leg is never cached; finished closed years get the long TTL.
    const ttls = cache.setCachedJson.mock.calls.map((c) => [JSON.parse(c[1] as string).leg, c[3]]);
    const y = new Date().getFullYear();
    for (const [leg, ttl] of ttls) expect(ttl).toBe((leg as number[])[1] < y ? 86_400 : 3_600);
  });

  it('reuses a cached year across periods that cover it whole', async () => {
    const svc = new EdsrFtsService();
    const cache = makeLegCache();
    svc.setEdsrCache(cache as any);
    await svc.countByParty('X', undefined, makeCountDb([{ n: 1 }, { n: 5 }]), { date_from: '2024-01-01', date_to: '2025-12-31' });
    const db = makeCountDb([{ n: 9 }]);
    const res = await svc.countByParty('X', undefined, db, { date_from: '2023-03-01', date_to: '2024-12-31' });
    // 2024 is whole in both periods → cached; 2023 is new and starts mid-year → queried.
    expect(legCalls(db)).toHaveLength(1);
    expect(legCalls(db)[0].sql).toContain('f.adj_year = 2023');
    expect(res.total).toBe(14);
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

// LEXAI-2085: search_court_decisions(fulltext, party_name "Нова Пошта", party_role defendant)
// ran past the 120 s tool cap. The party probe scanned all 24 year partitions oldest first,
// paying a TOAST read per GIN hit; its 8 s timeout read as "no match" and every relaxation
// step re-ran it.
describe('EdsrFtsService.searchFulltext party leg (LEXAI-2085)', () => {
  const timeoutClient = (failOn: (sql: string) => boolean) => {
    const clientCalls: string[] = [];
    const client = {
      query: jest.fn((sql: string) => {
        clientCalls.push(sql);
        if (failOn(sql)) {
          return Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    return { client, clientCalls, db: { query: jest.fn(), connect: jest.fn(() => Promise.resolve(client)) } };
  };

  it('AND-s the name lexemes instead of a phrase when the role regex enforces adjacency', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('втрата посилки', db, { party_name: 'Нова Пошта', party_role: 'defendant' });

    const { sql, params } = db.calls[0];
    expect(sql).not.toContain('phraseto_tsquery');
    expect(sql).toMatch(/plainto_tsquery\('simple', \$2\)/);
    expect(params[1]).toBe('Нова Пошта');
    expect(sql).toContain('f.full_text ~*');
  });

  it('scans the party leg newest year first, one partition per leg, under a small cap', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('втрата посилки', db, { party_name: 'Нова Пошта', party_role: 'defendant' }, 5, 0);

    const sql = db.calls[0].sql;
    const thisYear = new Date().getFullYear();
    expect(sql).toContain('UNION ALL');
    const iNow = sql.indexOf(`f.adj_year >= ${thisYear}`); // open upward: takes p_future too
    const iPrev = sql.indexOf(`f.adj_year = ${thisYear - 1}`);
    const iOld = sql.indexOf('f.adj_year = 2006');
    expect(iNow).toBeGreaterThan(-1);
    expect(iNow).toBeLessThan(iPrev);
    expect(iPrev).toBeLessThan(iOld);
    expect(sql).toMatch(/\) legs\s+LIMIT 100\s/);
    expect(sql).not.toContain('LIMIT 2000');
  });

  it('lets a caller candidateCap (LEXAI-2087) lower, but never raise, the party cap', async () => {
    const svc = new EdsrFtsService();
    const low = makeDb();
    await svc.searchFulltext('посилка', low, { party_name: 'Нова Пошта', party_role: 'defendant' }, 5, 0, undefined, undefined, { candidateCap: 50 });
    expect(low.calls[0].sql).toMatch(/\) legs\s+LIMIT 50\s/);

    const high = makeDb();
    await svc.searchFulltext('посилка', high, { party_name: 'Нова Пошта', party_role: 'defendant' }, 5, 0, undefined, undefined, { candidateCap: 500 });
    expect(high.calls[0].sql).toMatch(/\) legs\s+LIMIT 100\s/);
  });

  // LEXAI-2109: the topical candidate step was one capped scan of the parent, read in
  // partition-bound order, so with a 100-500 cap every candidate came from 2006 and hybrid
  // search put 2006 appeal verdicts first for a wage-arrears query.
  it('fills the topical candidate cap newest year first, too', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('оренда землі', db, {}, 10, 0, undefined, undefined, { candidateCap: 300 });

    const sql = db.calls[0].sql;
    const thisYear = new Date().getFullYear();
    const iNow = sql.indexOf(`f.adj_year >= ${thisYear}`);
    const iPrev = sql.indexOf(`f.adj_year = ${thisYear - 1}`);
    const iOld = sql.indexOf('f.adj_year = 2006');
    const iPre = sql.indexOf('f.adj_year <= 2005');
    expect(iNow).toBeGreaterThan(-1);
    expect(iNow).toBeLessThan(iPrev);
    expect(iPrev).toBeLessThan(iOld);
    expect(iOld).toBeLessThan(iPre);
    expect(sql).toMatch(/\) legs\s+LIMIT 300\s/);
    // The ranked re-fetch is pinned to the candidate's own partition.
    expect(sql).toContain('cand.adj_year = f.adj_year');
  });

  it('keeps the default topical cap when the caller gives none', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('оренда землі', db);
    expect(db.calls[0].sql).toMatch(/\) legs\s+LIMIT 2000\s/);
  });

  it("scans only the period's years for a dated topical query, and nothing for an inverted one", async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('оренда землі', db, { date_from: '2023-03-01', date_to: '2024-09-30' });
    const sql = db.calls[0].sql;
    expect(sql).toContain('f.adj_year = 2024');
    expect(sql).toContain('f.adj_year = 2023');
    expect(sql).not.toMatch(/f\.adj_year (=|>=|<=) (2022|2025)/);
    // Each leg also bounds edrsr_documents to its year (partition pruning on the join).
    expect(sql).toContain("d.adjudication_date >= '2024-01-01'::timestamp AT TIME ZONE 'Europe/Kyiv'");

    const inv = makeDb();
    await svc.searchFulltext('оренда землі', inv, { date_from: '2025-01-01', date_to: '2024-12-31' });
    expect(inv.calls[0].sql).toContain('WHERE FALSE');
  });

  it('flags a party total that fills the smaller cap as a floor', async () => {
    const svc = new EdsrFtsService();
    const rows = Array.from({ length: 6 }, (_v, i) => ({ doc_id: i + 1, headline: 'x', rank: 0.5, cand_total: 100 }));
    const db = { query: jest.fn(() => Promise.resolve({ rows })) };
    const res = await svc.searchFulltext('посилка', db as any, { party_name: 'Нова Пошта', party_role: 'defendant' }, 5, 0);

    expect(res.total_is_floor).toBe(true);
    expect(res.candidate_cap).toBe(100);
  });

  it('reports a timeout as timed_out (not as a no-match) and never caches it', async () => {
    const svc = new EdsrFtsService();
    const cache = { getCachedFtsResults: jest.fn(() => Promise.resolve(null)), setCachedFtsResults: jest.fn(() => Promise.resolve()) };
    svc.setEdsrCache(cache as any);
    const { db, clientCalls, client } = timeoutClient((sql) => sql.includes('cand AS MATERIALIZED'));

    const res = await svc.searchFulltext('втрата посилки', db, { party_name: 'Нова Пошта', party_role: 'defendant' }, 5, 0);

    expect(res.timed_out).toBe(true);
    expect(res.total).toBe(0);
    expect(res.results).toEqual([]);
    expect(cache.setCachedFtsResults).not.toHaveBeenCalled();
    // The party leg runs under its own bounded statement_timeout, below the 120 s tool cap.
    // (the last one: the edrsr_parties_coverage lookup runs first under its own 5 s bound)
    const timeoutStmt = clientCalls.filter((q) => /^SET LOCAL statement_timeout = \d+$/.test(q)).pop()!;
    const ms = Number(timeoutStmt.split('= ')[1]);
    expect(ms).toBeGreaterThan(8000);
    expect(ms).toBeLessThanOrEqual(20_000);
    expect(clientCalls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('bounds the post-fusion party re-check with a statement_timeout', async () => {
    const svc = new EdsrFtsService();
    const { db, clientCalls } = timeoutClient(() => false);
    await svc.filterDocIdsByConstraints([1, 2], { party_name: 'Нова Пошта', party_role: 'defendant' }, db);

    expect(clientCalls.some((q) => /^SET LOCAL statement_timeout = \d+$/.test(q))).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('yearLegPredicate', () => {
  it('pins a one-year leg to its partition and leaves open sides open', () => {
    expect(yearLegPredicate({ minYear: 2025, maxYear: 2025 })).toBe('f.adj_year = 2025');
    expect(yearLegPredicate({ minYear: 2026, maxYear: null })).toBe('f.adj_year >= 2026');
    expect(yearLegPredicate({ minYear: null, maxYear: 2005 })).toBe('f.adj_year <= 2005');
    expect(yearLegPredicate({ minYear: 1999, maxYear: 2002 })).toBe('f.adj_year >= 1999 AND f.adj_year <= 2002');
    expect(yearLegPredicate({ minYear: null, maxYear: null })).toBe('TRUE');
  });
});

// LEXAI-2110: adjudication_date holds Kyiv-local midnight. A decision of 1 January 2025 is
// stored as 2024-12-31 22:00 UTC, so `>= '2025-01-01'` (UTC midnight) dropped it.
describe('Kyiv-local date bounds (LEXAI-2110)', () => {
  it('builds whole-day Kyiv bounds, the upper one exclusive of the next day', () => {
    expect(kyivDayBoundsSql('d.adjudication_date', '$3', '$4')).toEqual([
      "d.adjudication_date >= ($3::date)::timestamp AT TIME ZONE 'Europe/Kyiv'",
      "d.adjudication_date < ($4::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv'",
    ]);
  });

  it('searchFulltext compares date_from/date_to as Kyiv calendar days', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.searchFulltext('оренда землі', db, { date_from: '2025-01-01', date_to: '2025-01-31' });
    const { sql, params } = db.calls[0];
    const iFrom = params.indexOf('2025-01-01') + 1;
    const iTo = params.indexOf('2025-01-31') + 1;
    expect(sql).toContain(`d.adjudication_date >= ($${iFrom}::date)::timestamp AT TIME ZONE 'Europe/Kyiv'`);
    expect(sql).toContain(`d.adjudication_date < ($${iTo}::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv'`);
    // No bare UTC comparison against a date parameter is left.
    expect(sql).not.toMatch(/adjudication_date (>=|<=) \$\d+(?!::)/);
  });

  it('a parties leg (LEXAI-1760) compares date_from/date_to as Kyiv calendar days', async () => {
    const svc = new EdsrFtsService();
    const db = makeCoveredDb([2025]);
    await svc.countByParty('Нова Пошта', 'defendant', db, { date_from: '2025-01-01', date_to: '2025-03-31' });
    const leg = db.calls.find((c) => c.sql.includes('FROM edrsr_parties p'))!;
    expect(leg).toBeDefined();
    const iFrom = leg.params.indexOf('2025-01-01') + 1;
    const iTo = leg.params.indexOf('2025-03-31') + 1;
    expect(leg.sql).toContain(`d.adjudication_date >= ($${iFrom}::date)::timestamp AT TIME ZONE 'Europe/Kyiv'`);
    expect(leg.sql).toContain(`d.adjudication_date < ($${iTo}::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv'`);
  });
});
});

describe('party name keys (LEXAI-1760, mirror of edrsr_party_norm / edrsr_party_core)', () => {
  it('normalises like the SQL helper', () => {
    expect(partyNorm('  ТОВ «Нова   Пошта» ')).toBe('тов нова пошта');
    expect(partyNorm('Кам’янська ʼрада`')).toBe("кам'янська 'рада'");
    expect(partyNorm('«»')).toBeNull();
  });

  it('takes the innermost quoted name as the core', () => {
    expect(partyCore('ТОВ «Нова Пошта»')).toBe('нова пошта');
    expect(partyCore('АТ «Комерційний банк «ПриватБанк»»')).toBe('приватбанк');
    expect(partyCore('ТОВ «Фінансова компанія «Європейська агенція з повернення боргів»'))
      .toBe('європейська агенція з повернення боргів');
    expect(partyCore('Головне управління ДПС у Київській області')).toBeNull();
  });

  it('strips typed legal forms from an unquoted name', () => {
    expect(partyNameKeys('Нова Пошта')?.key).toBe('нова пошта');
    expect(partyNameKeys('ТОВ Нова Пошта')?.key).toBe('нова пошта');
    expect(partyNameKeys('АТ КБ ПриватБанк')?.key).toBe('приватбанк');
    expect(partyNameKeys('Акціонерне товариство Комерційний банк ПриватБанк')?.key).toBe('приватбанк');
    expect(partyNameKeys('Товариство з обмеженою відповідальністю «Нова Пошта»')?.key).toBe('нова пошта');
  });

  it('builds a whole-word suffix LIKE with wildcards escaped, and refuses a too-short key', () => {
    expect(partyNameKeys('ДПС у Київській області')?.like).toBe('% дпс у київській області');
    expect(partyNameKeys('Ліга 100%_')?.like).toBe('% ліга 100');
    expect(partyNameKeys('ТОВ «А»')).toBeNull();
    expect(partyNameKeys('ТОВ')).toBeNull();
  });
});

describe('partiesLegCovered (LEXAI-1760)', () => {
  const cov = new Set([2023, 2024, 2025, 2026]);
  it('covers a single-year leg only when that year is listed', () => {
    expect(partiesLegCovered({ minYear: 2024, maxYear: 2024 }, cov, 2026)).toBe(true);
    expect(partiesLegCovered({ minYear: 2022, maxYear: 2022 }, cov, 2026)).toBe(false);
  });
  it('never covers a leg open downward; an upward-open leg needs every year up to now', () => {
    expect(partiesLegCovered({ minYear: null, maxYear: 2005 }, cov, 2026)).toBe(false);
    expect(partiesLegCovered({ minYear: 2026, maxYear: null }, cov, 2026)).toBe(true);
    expect(partiesLegCovered({ minYear: 2026, maxYear: null }, cov, 2027)).toBe(false);
    expect(partiesLegCovered({ minYear: 2024, maxYear: 2024 }, new Set(), 2026)).toBe(false);
  });
});

describe('EdsrFtsService parties table read path (LEXAI-1760)', () => {
  const legMark = 'WITH l AS MATERIALIZED';

  it('countByParty serves covered years from edrsr_parties and the rest from full text, open-ended', async () => {
    const svc = new EdsrFtsService();
    const db = makeCoveredDb([2024, 2025]);
    // No date_to: the newest leg is open upward from this year — not covered unless it is.
    const res = await svc.countByParty('ТОВ «Нова Пошта»', 'defendant', db, { date_from: '2023-01-01', justice_kind: 3 });
    const legs = db.calls.filter((c) => c.sql.includes(legMark));
    const thisYear = new Date().getFullYear();
    const years: number[] = [];
    for (let y = Math.max(thisYear, 2023); y >= 2023; y--) years.push(y);
    expect(legs).toHaveLength(years.length);
    legs.forEach((leg, i) => {
      const y = years[i];
      const fromParties = y === 2024 || y === 2025;
      expect(leg.sql.includes('FROM edrsr_parties p')).toBe(fromParties);
      expect(leg.sql.includes('full_text ~*')).toBe(!fromParties);
      if (fromParties) {
        expect(leg.sql).toContain(`p.adj_year = ${y}`);
        expect(leg.sql).toContain('p.role = $3');
        expect(leg.sql).toContain('p.name_core = $1');
        expect(leg.params.slice(0, 3)).toEqual(['нова пошта', '% нова пошта', 2]);
        // only its own parameters: keys, role, date_from, justice_kind
        expect(leg.params).toEqual(['нова пошта', '% нова пошта', 2, '2023-01-01', 3]);
      } else {
        expect(leg.params).toContain('ТОВ «Нова Пошта»');
      }
    });
    expect(res.total).toBe(0);
  });

  it('countByParty keeps the full-text path for role any and for an uncovered justice kind', async () => {
    const svc = new EdsrFtsService();
    const db = makeCoveredDb([2025]);
    await svc.countByParty('Нова Пошта', 'any', db, { date_from: '2025-01-01', date_to: '2025-12-31' });
    await svc.countByParty('Нова Пошта', 'plaintiff', db, { date_from: '2025-01-01', date_to: '2025-12-31', justice_kind: 2 });
    expect(db.calls.some((c) => c.sql.includes('FROM edrsr_parties'))).toBe(false);
  });

  it('countByParty answers a plaintiff count from a parties leg with role code 1', async () => {
    const svc = new EdsrFtsService();
    const calls: { sql: string; params: any[] }[] = [];
    const db = {
      query: jest.fn((sql: string, params: any[]) => {
        if (sql.includes(COVERAGE_SQL)) return Promise.resolve({ rows: [{ adj_year: 2025 }] });
        calls.push({ sql, params });
        return Promise.resolve({ rows: [{ n: 3, causes: ['a', 'b'], by_court: [{ court_code: 7, count: 3 }] }] });
      }),
    };
    const res = await svc.countByParty('ПриватБанк', 'plaintiff', db, { date_from: '2025-01-01', date_to: '2025-12-31', justice_kind: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('FROM edrsr_parties p');
    expect(calls[0].sql).toContain('d.justice_kind = $6');
    expect(calls[0].params).toEqual(['приватбанк', '% приватбанк', 1, '2025-01-01', '2025-12-31', 3]);
    expect(res).toMatchObject({ total: 3, distinct_cases: 2, by_court: [{ court_code: 7, count: 3 }] });
  });

  it('searchFulltext mixes parties legs and full-text legs, binding each parameter it uses', async () => {
    const svc = new EdsrFtsService();
    const db = makeCoveredDb([2025]);
    await svc.searchFulltext('стягнення боргу', db, {
      party_name: 'Нова Пошта', party_role: 'defendant', date_from: '2024-01-01', date_to: '2025-12-31',
    });
    const { sql, params } = db.calls[0];
    // 2025 leg: topical tsv + parties semi-join; 2024 leg: name/role tsv + claim-clause regex.
    expect(sql).toMatch(/f\.doc_id IN \(SELECT p\.doc_id FROM edrsr_parties p WHERE p\.adj_year = 2025 AND p\.role = \$4/);
    expect(sql).toContain('f.full_text ~*');
    expect(params.slice(0, 4)).toEqual(['стягнення боргу', 'нова пошта', '% нова пошта', 2]);
    expect(params).toContain('Нова Пошта');
    for (let i = 1; i <= params.length; i++) expect(sql).toContain(`$${i}`);
  });

  it('searchFulltext drops the full-text party parameters when every leg is covered for a parties kind', async () => {
    const svc = new EdsrFtsService();
    const db = makeCoveredDb([2025]);
    await svc.searchFulltext('стягнення боргу', db, {
      party_name: 'Нова Пошта', party_role: 'plaintiff', date_from: '2025-01-01', date_to: '2025-12-31', justice_kind: 3,
    });
    const { sql, params } = db.calls[0];
    expect(sql).not.toContain('f.full_text ~*');
    expect(sql).not.toContain('phraseto_tsquery');
    expect(params).not.toContain('Нова Пошта');
    expect(params.slice(0, 4)).toEqual(['стягнення боргу', 'нова пошта', '% нова пошта', 1]);
    for (let i = 1; i <= params.length; i++) expect(sql).toContain(`$${i}`);
  });

  it('countByParty without a justice kind adds the kinds 2/5 from full text to a covered leg', async () => {
    const svc = new EdsrFtsService();
    const calls: { sql: string; params: any[] }[] = [];
    const db = {
      query: jest.fn((sql: string, params: any[]) => {
        if (sql.includes(COVERAGE_SQL)) return Promise.resolve({ rows: [{ adj_year: 2025 }] });
        calls.push({ sql, params });
        return Promise.resolve({ rows: [sql.includes('FROM edrsr_parties p')
          ? { n: 3, causes: ['a', 'b'], by_court: [{ court_code: 7, count: 3 }], sample: [{ doc_id: 1 }] }
          : { n: 2, causes: ['b', 'c'], by_court: [{ court_code: 7, count: 1 }, { court_code: 9, count: 1 }], sample: [{ doc_id: 2 }] }] });
      }),
    };
    const res = await svc.countByParty('ПриватБанк', 'plaintiff', db, { date_from: '2025-01-01', date_to: '2025-12-31' });
    const legs = calls.filter((c) => c.sql.includes(legMark));
    expect(legs).toHaveLength(2);
    expect(legs[0].sql).toContain('FROM edrsr_parties p');
    expect(legs[0].params).toEqual(['приватбанк', '% приватбанк', 1, '2025-01-01', '2025-12-31']);
    // the other-kinds leg: full-text predicate, restricted to the kinds edrsr_parties lacks
    expect(legs[1].sql).not.toContain('FROM edrsr_parties');
    expect(legs[1].sql).toContain('full_text ~*');
    expect(legs[1].sql).toContain('coalesce(d.justice_kind, 0) NOT IN (1, 3, 4)');
    expect(legs[1].params).toContain('ПриватБанк');
    for (const leg of legs) for (let i = 1; i <= leg.params.length; i++) expect(leg.sql).toContain(`$${i}`);
    expect(res).toMatchObject({
      total: 5, distinct_cases: 3,
      by_court: [{ court_code: 7, count: 4 }, { court_code: 9, count: 1 }],
    });
  });

  it('searchFulltext without a justice kind keeps kinds 2/5 on the full-text predicate in a covered leg', async () => {
    const svc = new EdsrFtsService();
    const db = makeCoveredDb([2025]);
    // no metadata filter (no dates): the documents table is consulted only for the kind
    await svc.searchFulltext('стягнення боргу', db, { party_name: 'Нова Пошта', party_role: 'plaintiff' });
    const { sql, params } = db.calls[0];
    expect(sql).toContain('FROM edrsr_parties p WHERE p.adj_year = 2025');
    expect(sql).toContain('f.full_text ~*');
    expect(sql).toContain('dk.justice_kind IN (1, 3, 4)');
    // The two branches split by kind alone: the other-kinds branch excludes exactly the kinds
    // the parties table can hold, with no date predicate that a doc with a missing or
    // different metadata date could fail — so no decision can come out of both branches.
    const notExists = sql.match(/NOT EXISTS \(SELECT 1 FROM edrsr_documents dk WHERE ([^)]*\))\)/);
    expect(notExists).not.toBeNull();
    expect(notExists![1]).toBe('dk.doc_id = f.doc_id AND dk.justice_kind IN (1, 3, 4)');
    expect(sql).not.toContain('dk.adjudication_date');
    const branches = sql.split('UNION ALL').filter((b) => b.includes('p.adj_year = 2025') || b.includes('NOT EXISTS'));
    expect(branches).toHaveLength(2);
    const [partiesBranch, otherBranch] = branches;
    expect(partiesBranch).toContain('FROM edrsr_parties p');
    expect(partiesBranch).not.toContain('NOT EXISTS');
    expect(otherBranch).not.toContain('FROM edrsr_parties');
    expect(otherBranch).toContain('f.full_text ~*');
    expect(params).toContain('Нова Пошта');
    for (let i = 1; i <= params.length; i++) expect(sql).toContain(`$${i}`);
  });

  it('searchFulltext with the documents join (dates) filters the other kinds on d.justice_kind', async () => {
    const svc = new EdsrFtsService();
    const db = makeCoveredDb([2025]);
    await svc.searchFulltext('стягнення боргу', db, {
      party_name: 'Нова Пошта', party_role: 'plaintiff', date_from: '2025-01-01', date_to: '2025-12-31',
    });
    const { sql, params } = db.calls[0];
    expect(sql).toContain('coalesce(d.justice_kind, 0) NOT IN (1, 3, 4)');
    for (let i = 1; i <= params.length; i++) expect(sql).toContain(`$${i}`);
  });

  it('filterDocIdsByConstraints checks covered years against edrsr_parties, others by regex', async () => {
    const svc = new EdsrFtsService();
    const db = makeCoveredDb([2024, 2025]);
    await svc.filterDocIdsByConstraints([1, 2, 3], { party_name: 'Нова Пошта', party_role: 'defendant' }, db);
    const { sql, params } = db.calls[0];
    expect(sql).toContain('f.adj_year = ANY($4::int[])');
    expect(sql).toContain('FROM edrsr_parties pp');
    expect(sql).toContain('f.full_text ~*');
    // in a covered year, kinds the parties table lacks are still checked by the full text
    expect(sql).toMatch(/OR \(f\.tsv @@ .* AND f\.full_text ~\* \$3 AND NOT EXISTS \(\s*SELECT 1 FROM edrsr_documents dk\s*WHERE dk\.doc_id = f\.doc_id AND dk\.justice_kind IN \(1, 3, 4\)\)\)/s);
    // structured lookup pinned to the candidate's own partition
    expect(sql).toContain('pp.doc_id = ANY($1) AND pp.adj_year = f.adj_year');
    // a candidate without adj_year stays on the full-text predicate instead of vanishing
    expect(sql).toContain('(f.adj_year IS NULL OR NOT (f.adj_year = ANY($4::int[])))');
    expect(params[3]).toEqual([2024, 2025]);
    expect(params.slice(4)).toEqual(['нова пошта', '% нова пошта', 2]);
    for (let i = 1; i <= params.length; i++) expect(sql).toContain(`$${i}`);
  });
});
