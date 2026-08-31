/**
 * EdsrFtsService.searchFulltext — party filter SQL construction
 *
 * Verifies that party_name / party_role are anchored into the tsquery match
 * (phraseto_tsquery + to_tsquery role forms), not appended as bag-of-words.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EdsrFtsService, buildPartyRoleRegex } from '../edrsr-fts-service';

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

describe('EdsrFtsService.countByParty', () => {
  it('counts + groups by court with phrase + role anchor', async () => {
    const svc = new EdsrFtsService();
    const db = {
      calls: [] as any[],
      query: jest.fn((sql: string, params: any[]) => {
        (db as any).calls.push({ sql, params });
        return Promise.resolve({ rows: [{ court_code: 1690, n: 7 }, { court_code: 2605, n: 3 }] });
      }),
    };
    const res = await svc.countByParty('Нова Пошта', 'defendant', db);

    const sql = db.calls[0].sql;
    expect(sql).toContain('phraseto_tsquery');
    expect(sql).toContain('відповідач');
    expect(sql).toContain('GROUP BY d.court_code');
    expect(db.calls[0].params).toContain('Нова Пошта');
    expect(res.total).toBe(10);
    expect(res.by_court).toHaveLength(2);
    expect(res.sample).toBeUndefined(); // sampleLimit defaults to 0
  });

  it('separates distinct cases from documents (ЕВЕРЛІҐАЛ read 684 "справ" against 591 real)', async () => {
    const svc = new EdsrFtsService();
    const db = {
      calls: [] as any[],
      query: jest.fn((sql: string, params: any[]) => {
        (db as any).calls.push({ sql, params });
        // Every row carries the same global distinct_cases via CROSS JOIN; by_court counts
        // DOCUMENTS, so summing it must NOT be what ends up labelled as cases.
        return Promise.resolve({
          rows: [
            { candidates: 684, distinct_cases: 591, court_code: 4824, n: 400 },
            { candidates: 684, distinct_cases: 591, court_code: 1003, n: 284 },
          ],
        });
      }),
    };
    const res = await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db);

    // documents: the sum of by_court
    expect(res.total).toBe(684);
    // cases: the global count(DISTINCT cause_num), never the sum — a case appears once per
    // instance it passed through, so summing per-court counts double-counts it
    expect(res.distinct_cases).toBe(591);
    expect(res.distinct_cases).toBeLessThan(res.total);
    const sql = db.calls[0].sql;
    expect(sql).toContain('count(DISTINCT d.cause_num)');
    // Structural guard: a mocked db never executes the SQL, so a missing comma between CTEs
    // passes every behavioural assertion and only fails in production. That exact bug shipped
    // once — 'syntax error at or near "tot"'.
    expect(sql).toMatch(/\)\s*,\s*tot AS \(/);
    // No CTE may follow another without a comma: `) name AS (` is always malformed here.
    expect(sql).not.toMatch(/\)\s*\n\s*[a-z_]+ AS \(/);
  });

  it('applies date/justice filters and fetches a sample when requested', async () => {
    const svc = new EdsrFtsService();
    const db = {
      calls: [] as any[],
      query: jest.fn((sql: string, params: any[]) => {
        (db as any).calls.push({ sql, params });
        if (sql.includes('GROUP BY')) return Promise.resolve({ rows: [{ court_code: 1, n: 2 }] });
        return Promise.resolve({ rows: [{ doc_id: 5, cause_num: '1/2', court_code: 1, justice_kind: 3, adjudication_date: '2024-01-01' }] });
      }),
    };
    const res = await svc.countByParty('Нова Пошта', 'plaintiff', db, { date_from: '2023-01-01', justice_kind: 3 }, 50);

    const countSql = db.calls[0].sql;
    expect(countSql).toContain('позивач');
    expect(countSql).toContain('d.adjudication_date >=');
    expect(countSql).toContain('d.justice_kind =');
    expect(db.calls).toHaveLength(2); // count + sample
    expect(db.calls[1].sql).toContain('LIMIT 50');
    expect(res.sample).toHaveLength(1);
    expect(res.sample![0].doc_id).toBe(5);
  });

  /**
   * Plan-shape guards. Each of these three details was measured on prod and each one,
   * on its own, is the difference between ~1s and a tool timeout — none of them is
   * visible from the result, so a refactor can drop one and only production notices.
   */
  it('resolves candidates in a MATERIALIZED CTE before joining edrsr_documents', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db);

    const sql = db.calls[0].sql;
    // Without MATERIALIZED the planner hash-joins a full seq scan of all 136M
    // edrsr_documents rows (59.4s measured) instead of doing doc_id index lookups.
    expect(sql).toContain('cand AS MATERIALIZED');
    expect(sql).toContain('JOIN edrsr_documents d ON d.doc_id = cand.doc_id');
  });

  it('caps candidates at 25000 — a smaller cap flips the planner off the GIN scan', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db, {}, 10);

    // Counter-intuitive but measured: on the ordered leg, LIMIT 2000 or 5000 times out
    // (>90s) where LIMIT 25000 returns in ~1.5s, because the small limit tempts the
    // planner into walking idx_ef_p_*_docid backwards. Both paths use the same cap.
    for (const call of db.calls) {
      expect(call.sql).toContain('ORDER BY f.doc_id DESC');
      expect(call.sql).toContain('LIMIT 25000');
    }
    // One ORDER BY per candidate leg — see the three-leg test for why each leg keeps it.
    for (const call of db.calls) {
      expect(call.sql.match(/ORDER BY f\.doc_id DESC/g)).toHaveLength(3);
    }
    // The sample must materialize the join too, or ORDER BY adjudication_date DESC
    // LIMIT n walks the date index probing for matches (111s measured).
    expect(db.calls[1].sql).toContain('joined AS MATERIALIZED');
  });

  it('pushes the requested period into the CTE as an adj_year band', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.countByParty('НАФТОГАЗ', undefined, db, { date_from: '2024-01-01', date_to: '2026-12-31' });

    // With both bounds set, countByPartyFast probes edrsr_parties_coverage first, so the
    // count is not necessarily calls[0] — pick it by shape.
    const countCall = db.calls.find((c: any) => c.sql.includes('cand AS MATERIALIZED'));
    if (!countCall) throw new Error('no candidate-CTE query was issued');
    const sql = countCall.sql;
    const params = countCall.params;
    // edrsr_fulltext is LIST-partitioned by adj_year, so this prunes the GIN scan
    // itself (50.5s → 1.2s). Filtering only on d.adjudication_date after the join
    // leaves the scan just as wide, which made "narrow the period" useless advice.
    expect(sql).toContain('f.adj_year >=');
    expect(sql).toContain('f.adj_year <=');
    // Band widened by a year on each side; exact bounds are still enforced on d.
    expect(params).toContain(2023);
    expect(params).toContain(2027);
    expect(sql).toContain('d.adjudication_date >=');
    expect(sql).toContain('d.adjudication_date <=');
  });

  it('flags a truncated count as capped instead of reporting a floor as exact', async () => {
    const svc = new EdsrFtsService();
    const db = {
      calls: [] as any[],
      query: jest.fn((sql: string, params: any[]) => {
        (db as any).calls.push({ sql, params });
        return Promise.resolve({ rows: [{ candidates: 25000, court_code: 1, n: 25000 }] });
      }),
    };
    const res = await svc.countByParty('ПРИВАТБАНК', undefined, db);

    expect(res.capped).toBe(true);
    expect(res.candidate_cap).toBe(25000);
  });

  it('takes candidates newest-year-first across three ordered legs', async () => {
    const svc = new EdsrFtsService();
    const db = makeDb();
    await svc.countByParty('ПРИВАТБАНК', undefined, db);

    const sql = db.calls[0].sql;
    // Per-year legs are the whole fix: each prunes to one partition, so it sorts only that
    // partition instead of the corpus (>90s timeout -> 2.41s for a 400k-document party).
    expect(sql).toContain('r0 AS MATERIALIZED');
    expect(sql).toContain('r1 AS MATERIALIZED');
    expect(sql).toContain('older AS MATERIALIZED');
    // Every leg stays ordered. Dropping the sort on the recent leg is faster still, but it
    // returns physical heap order, so a capped party's "newest" decisions were whatever the
    // scan hit first — measured as a sample topping out at 2025-12-31 while the corpus ran
    // to 2026-07-13. Ordering every leg is what makes the union exactly the newest N.
    expect(sql.match(/ORDER BY f\.doc_id DESC/g)).toHaveLength(3);
    // Each later leg only takes what its predecessors left; at 0 Postgres skips the scan.
    expect(sql).toContain('GREATEST(0, 25000 - (SELECT count(*) FROM r0))');
    expect(sql).toContain('GREATEST(0, 25000 - (SELECT count(*) FROM r0) - (SELECT count(*) FROM r1))');
    expect(sql).toContain('SELECT doc_id FROM r0');
    expect(sql).toContain('SELECT doc_id FROM r1');
    expect(sql).toContain('SELECT doc_id FROM older');
    // Year boundaries are bound, never interpolated.
    expect(db.calls[0].params).toContain(new Date().getFullYear());
    expect(db.calls[0].params).toContain(new Date().getFullYear() - 1);
  });

  it('still reports capped when doc-side filters drop every candidate', async () => {
    // A doc-side filter with no CTE counterpart (justice_kind) can eliminate all of the
    // newest candidates, leaving `agg` empty. The candidate count has to survive that,
    // or the caller gets total 0 presented as exact while older matches exist.
    const svc = new EdsrFtsService();
    const db = {
      calls: [] as any[],
      query: jest.fn((sql: string, params: any[]) => {
        (db as any).calls.push({ sql, params });
        // LEFT JOIN against an empty agg: one row, candidates set, court_code null.
        return Promise.resolve({ rows: [{ candidates: 25000, court_code: null, n: null }] });
      }),
    };
    const res = await svc.countByParty('ПРИВАТБАНК', undefined, db, { justice_kind: 1 });

    expect(res.by_court).toHaveLength(0);   // the synthetic row is not a court
    expect(res.total).toBe(0);
    expect(res.capped).toBe(true);          // ...but never an *exact* zero
    expect(res.candidate_cap).toBe(25000);
  });

  it('leaves capped unset when the party fits under the cap', async () => {
    const svc = new EdsrFtsService();
    const db = {
      calls: [] as any[],
      query: jest.fn((sql: string, params: any[]) => {
        (db as any).calls.push({ sql, params });
        return Promise.resolve({ rows: [{ candidates: 684, court_code: 1, n: 684 }] });
      }),
    };
    const res = await svc.countByParty('ЕВЕРЛІҐАЛ', undefined, db);

    expect(res.capped).toBeUndefined();
    expect(res.total).toBe(684);
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
