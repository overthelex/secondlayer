/**
 * CORE-21 P1.5a — IDF-weighted FTS term selection.
 * selectFtsTerms (pure ordering) + EdsrFtsService.lexemeDf (df → idf, db-backed).
 */
import { selectFtsTerms, EdsrFtsService, sanitizeFtsToken, buildPrefixTsquery } from '../edrsr-fts-service';

describe('selectFtsTerms (CORE-21 P1.5a)', () => {
  // Mimics lexemeDf output: common terms low idf, discriminative terms high.
  const idf = new Map<string, number>([
    ['податок', 0.2], ['нерухоме', 1.0], ['майно', 0.3],
    ['окупована', 4.0], ['територія', 2.0], ['донецьк', 5.0],
  ]);
  const reproTokens = ['податок', 'нерухоме', 'майно', 'окупована', 'територія', 'Донецьк'];

  it('orders discriminative (rare) terms first, common last', () => {
    const out = selectFtsTerms(reproTokens, idf);
    expect(out.slice(0, 3)).toEqual(['Донецьк', 'окупована', 'територія']);
    expect(out.slice(-2)).toEqual(['майно', 'податок']); // commonest → relaxation drops these first
  });

  it('keeps the rare occupation/ДРРП terms across relaxation', () => {
    // Relaxation pops from the tail; dropping the 3 commonest still leaves the rare ones.
    const ranked = selectFtsTerms(reproTokens, idf);
    expect(ranked.slice(0, 3)).toEqual(expect.arrayContaining(['Донецьк', 'окупована']));
    expect(ranked.indexOf('податок')).toBeGreaterThan(ranked.indexOf('Донецьк'));
  });

  it('falls back to the original positional order when the idf map is empty', () => {
    expect(selectFtsTerms(['a', 'b', 'c'], new Map())).toEqual(['a', 'b', 'c']);
  });

  it('is a stable sort on equal idf (input order preserved)', () => {
    const flat = new Map([['x', 1], ['y', 1], ['z', 1]]);
    expect(selectFtsTerms(['x', 'y', 'z'], flat)).toEqual(['x', 'y', 'z']);
  });

  it('matches tokens case-insensitively but returns original casing', () => {
    expect(selectFtsTerms(['Донецьк', 'податок'], idf)).toEqual(['Донецьк', 'податок']);
  });
});

describe('selectFtsTerms — anchor-floor demotion (LEXAI Cause-A)', () => {
  // sample 3.0M → floor = 3.0M * 1e-4 = 300 docs. "сумування"/"дррп" sub-floor (junk);
  // "окупована"/"нерухоме" well above. Junk has HIGH idf (rare) yet must NOT lead.
  const sampleDocs = 3_000_000;
  const idf = new Map<string, number>([
    ['окупована', Math.log(sampleDocs / 41321)],
    ['нерухоме', Math.log(sampleDocs / 193320)],
    ['сумування', Math.log(sampleDocs / 80)],   // rarest → highest idf
    ['дррп', Math.log(sampleDocs / 526)],        // just above floor
  ]);
  const df = new Map<string, number>([
    ['окупована', 41321], ['нерухоме', 193320], ['сумування', 80], ['дррп', 526],
  ]);
  const tokens = ['сумування', 'окупована', 'дррп', 'нерухоме'];

  it('demotes sub-floor junk to the tail even though it has the highest idf', () => {
    const out = selectFtsTerms(tokens, idf, { df, sampleDocs });
    // anchors (df ≥ 300) first, ordered by idf desc: окупована (rarer) before нерухоме;
    // дррп (526) is an anchor too. сумування (80 < 300) is demoted to LAST.
    expect(out[out.length - 1]).toBe('сумування');
    expect(out.indexOf('окупована')).toBeLessThan(out.indexOf('сумування'));
    expect(out.indexOf('нерухоме')).toBeLessThan(out.indexOf('сумування'));
  });

  it('keeps idf-only behaviour (junk leads) when df is NOT supplied — proves the regression', () => {
    const out = selectFtsTerms(tokens, idf);            // no df → old behaviour
    expect(out[0]).toBe('сумування');                   // rarest leads → this is the bug
  });

  it('never empties an all-junk query — returns least-rare junk first', () => {
    const jIdf = new Map([['сумування', 5.0], ['ввп', 6.0]]);
    const jDf = new Map([['сумування', 80], ['ввп', 20]]);
    const out = selectFtsTerms(['ввп', 'сумування'], jIdf, { df: jDf, sampleDocs });
    expect(out).toEqual(['сумування', 'ввп']);          // both weak → df desc (80 before 20)
  });
});

describe('EdsrFtsService.lexemeDf (CORE-21 P1.5a)', () => {
  const svc = new EdsrFtsService();

  function dbReturning(rows: any[], probeRows: any[] = []) {
    return {
      query: jest.fn().mockImplementation((sql: string) =>
        Promise.resolve({ rows: /LIMIT 1/.test(sql) ? probeRows : rows })),
    };
  }

  it('computes idf for matched lexemes and max idf for absent ones (table populated)', async () => {
    const db = dbReturning([
      { lexeme: 'податок', df: 900, sample_docs: 1000 },
      { lexeme: 'донецьк', df: 10, sample_docs: 1000 },
    ]);
    const m = await svc.lexemeDf(['податок', 'донецьк', 'окупована'], db);
    expect(m.get('податок')!).toBeCloseTo(Math.log(1000 / 900));
    expect(m.get('донецьк')!).toBeCloseTo(Math.log(1000 / 10));
    expect(m.get('окупована')!).toBeCloseTo(Math.log(1000)); // absent + populated → max idf
    expect(m.get('донецьк')!).toBeGreaterThan(m.get('податок')!);
  });

  it('returns an empty map when the df table is empty (positional fallback)', async () => {
    const m = await svc.lexemeDf(['податок', 'донецьк'], dbReturning([], []));
    expect(m.size).toBe(0);
  });

  it('never throws — returns an empty map on db error', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('relation does not exist')) };
    const m = await svc.lexemeDf(['x'], db);
    expect(m.size).toBe(0);
  });

  it('lowercases tokens before lookup', async () => {
    const db = dbReturning([{ lexeme: 'донецьк', df: 10, sample_docs: 1000 }]);
    const m = await svc.lexemeDf(['Донецьк'], db);
    expect(m.get('донецьк')!).toBeCloseTo(Math.log(1000 / 10));
  });

  it('lexemeStats returns raw df (0 for absent) and the sample size (LEXAI Cause-A)', async () => {
    const db = dbReturning([
      { lexeme: 'окупована', df: 41321, sample_docs: 3_000_000 },
      { lexeme: 'сумування', df: 80, sample_docs: 3_000_000 },
    ]);
    const s = await svc.lexemeStats(['Окупована', 'сумування', 'абракадабра'], db);
    expect(s.sampleDocs).toBe(3_000_000);
    expect(s.df.get('окупована')).toBe(41321);
    expect(s.df.get('сумування')).toBe(80);
    expect(s.df.get('абракадабра')).toBe(0);                 // absent → 0, the junk signal
    expect(s.idf.get('окупована')!).toBeCloseTo(Math.log(3_000_000 / 41321));
  });

  it('lexemeStats degrades to empty maps + 0 sample on db error', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('relation does not exist')) };
    const s = await svc.lexemeStats(['x'], db);
    expect(s.idf.size).toBe(0);
    expect(s.df.size).toBe(0);
    expect(s.sampleDocs).toBe(0);
  });
});

describe('prefix tsquery helpers (LEXAI Cause-A.2)', () => {
  it('sanitizeFtsToken lowercases and strips tsquery metacharacters', () => {
    expect(sanitizeFtsToken('Окупована:*')).toBe('окупована');
    expect(sanitizeFtsToken('60-кв.м')).toBe('60квм');
    expect(sanitizeFtsToken('a&b|c!')).toBe('abc');
  });

  it('buildPrefixTsquery ANDs stems with :* prefix', () => {
    expect(buildPrefixTsquery(['окупован', 'нерухом'])).toBe('окупован:* & нерухом:*');
  });

  it('buildPrefixTsquery returns null when nothing usable', () => {
    expect(buildPrefixTsquery([])).toBeNull();
    expect(buildPrefixTsquery(['', '  '])).toBeNull();
  });
});

describe('EdsrFtsService.snapTokensToStems (LEXAI Cause-A.2)', () => {
  const svc = new EdsrFtsService();
  // floor at sampleDocs 3.0M = max(8, 3.0M*1e-4) = 300.
  function db(prefixDf: Record<string, number>, sampleDocs = 3_000_000) {
    return {
      query: jest.fn().mockImplementation((sql: string) => {
        if (/LIMIT 1/.test(sql)) return Promise.resolve({ rows: [{ sample_docs: sampleDocs }] });
        // unnest candidates query → return df for known prefixes, 0 otherwise
        return Promise.resolve({ rows: Object.entries(prefixDf).map(([cand, d]) => ({ cand, df: d })) });
      }),
    };
  }

  it('snaps a declined token to the SHORTEST above-floor stem (inflection-tolerant)', async () => {
    // shortest valid prefix wins so the :* query catches all declensions. "нерух" (≥floor)
    // is chosen over the longer "нерухом"/"нерухомість".
    const m = await svc.snapTokensToStems(['нерухомість'], db({ 'нерух': 193320, 'нерухом': 193000, 'нерухомість': 5000 }));
    expect(m.get('нерухомість')).toBe('нерух');
  });

  it('skips below-floor short prefixes and snaps to the first above-floor one', async () => {
    // "окуп"/"окупо" sub-floor here; "окупов" clears it → snapped (not the full form).
    const m = await svc.snapTokensToStems(['окупована'], db({ 'окупо': 50, 'окупов': 41321, 'окупован': 41000 }));
    expect(m.get('окупована')).toBe('окупов');
  });

  it('drops junk with no above-floor corpus stem', async () => {
    const m = await svc.snapTokensToStems(['сумування'], db({ 'сумування': 80, 'сумуван': 80, 'сумув': 90 }));
    expect(m.has('сумування')).toBe(false);
  });

  it('returns empty map when the df table is empty (plainto fallback)', async () => {
    const m = await svc.snapTokensToStems(['окупована'], db({}, 0));
    expect(m.size).toBe(0);
  });

  it('never throws — empty map on db error', async () => {
    const errDb = { query: jest.fn().mockRejectedValue(new Error('boom')) };
    expect((await svc.snapTokensToStems(['окупована'], errDb)).size).toBe(0);
  });
  /**
   * The prefix-df lookup must be written so Postgres can use
   * edrsr_lexeme_df_lexeme_prefix (btree text_pattern_ops).
   *
   * A correlated `lexeme LIKE u.cand || '%'` CANNOT: the planner only derives range
   * bounds from a LIKE whose pattern is known at plan time, so a pattern built from
   * an unnest column falls back to a Seq Scan of the whole 987k-row table — once per
   * candidate. Measured on prod 2026-08-20 for one chat search (46 candidates):
   * 398,544 shared-buffer hits and 4.0s warm, 90-120s cold, which is what pushed
   * search_court_decisions / find_similar_fact_pattern_cases into the 120s tool
   * timeout. Rewritten as an explicit range: Bitmap Index Scan, 18 buffers, 0.5ms.
   *
   * The LIKE stays as a redundant filter so results are provably identical
   * (verified against prod data: 20 candidates, 0 mismatches).
   */
  describe('prefix-df lookup is index-usable', () => {
    function capturingDb() {
      const sqls: string[] = [];
      return {
        sqls,
        query: jest.fn().mockImplementation((sql: string) => {
          sqls.push(sql);
          if (/LIMIT 1/.test(sql)) return Promise.resolve({ rows: [{ sample_docs: 3_000_000 }] });
          return Promise.resolve({ rows: [] });
        }),
      };
    }

    function candidateSql(db: { sqls: string[] }) {
      return db.sqls.find(s => /unnest/i.test(s) && !/LIMIT 1/.test(s)) || '';
    }

    it('bounds lexeme by a range against the candidate, not by a bare correlated LIKE', async () => {
      const db = capturingDb();
      await svc.snapTokensToStems(['нерухомість'], db);
      const sql = candidateSql(db);
      expect(sql).toMatch(/~>=~/);
      expect(sql).toMatch(/~<~/);
    });

    it('keeps the LIKE filter so the rewrite cannot change which lexemes match', async () => {
      const db = capturingDb();
      await svc.snapTokensToStems(['нерухомість'], db);
      expect(candidateSql(db)).toMatch(/LIKE/i);
    });

    it('still snaps correctly through the rewritten query', async () => {
      // Behaviour must be untouched: shortest above-floor prefix still wins.
      const db = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (/LIMIT 1/.test(sql)) return Promise.resolve({ rows: [{ sample_docs: 3_000_000 }] });
          return Promise.resolve({ rows: [{ cand: 'нерух', df: 193320 }, { cand: 'нерухом', df: 193000 }] });
        }),
      };
      expect((await svc.snapTokensToStems(['нерухомість'], db)).get('нерухомість')).toBe('нерух');
    });
  });
});

describe('selectFtsTerms — status-vocabulary demotion + geo promotion (CORE-106)', () => {
  // Repro chat-98f8472e / chat-5340fe5c: «внутрішньо переміщені» (df 1095, corpus-rare →
  // top idf) won cap slots over «донецьк»/«площа», producing a satisfiable-but-wrong
  // AND-query the target decision can never match. Party-status vocabulary describes the
  // person, not the legal issue — it must not enter the capped AND-set while operative
  // anchors exist. The semantic leg still sees the full query, so no meaning is lost.
  const idf = new Map<string, number>([
    ['податок', 0.2], ['нерухомість', 1.0], ['окупована', 4.0], ['територія', 2.0],
    ['площа', 1.5], ['донецьк', 3.0],
    ['внутрішньо', 6.0], ['переміщені', 6.5],   // rarest of all — old logic put them FIRST
  ]);
  const df = new Map<string, number>([
    ['податок', 2_000_000], ['нерухомість', 400_000], ['окупована', 30_000],
    ['територія', 900_000], ['площа', 600_000], ['донецьк', 120_000],
    ['внутрішньо', 1_095], ['переміщені', 1_095],   // healthy df → NOT weak-tier
  ]);
  const opts = { df, sampleDocs: 3_000_000 };
  const reproTokens = ['податок', 'нерухомість', 'окупована', 'територія', 'внутрішньо', 'переміщені', 'Донецьк', 'площа'];

  it('demotes status terms below every operative anchor (repro: they left the top-6 cap)', () => {
    const out = selectFtsTerms(reproTokens, idf, opts);
    const top6 = out.slice(0, 6);
    expect(top6).not.toContain('внутрішньо');
    expect(top6).not.toContain('переміщені');
    expect(top6).toEqual(expect.arrayContaining(['Донецьк', 'окупована', 'площа', 'податок']));
  });

  it('demotes status terms below the weak tier (relaxation drops status FIRST)', () => {
    // Weak junk produces 0 results → relaxation recovers; a satisfiable-but-wrong status
    // conjunct never triggers relaxation — so status must sit further in the tail.
    const withJunk = [...reproTokens, 'сумування'];
    const dfJunk = new Map(df); dfJunk.set('сумування', 3);   // sub-floor → weak
    const idfJunk = new Map(idf); idfJunk.set('сумування', 9.0);
    const out = selectFtsTerms(withJunk, idfJunk, { df: dfJunk, sampleDocs: 3_000_000 });
    expect(out.indexOf('переміщені')).toBeGreaterThan(out.indexOf('сумування'));
  });

  it('keeps status terms in place when the query is genuinely status-centric (<3 anchors)', () => {
    const tokens = ['переселенців', 'пільги'];
    const idf2 = new Map([['переселенців', 5.0], ['пільги', 1.0]]);
    const out = selectFtsTerms(tokens, idf2, opts);
    expect(out[0]).toBe('переселенців');   // no demotion — status IS the subject
  });

  it('promotes a geo anchor into the head even when rarer legal terms outrank it by idf', () => {
    const tokens = ['стягнення', 'апеляційний', 'провадження', 'касаційний', 'зобов’язання', 'оскарження', 'Донецьк'];
    const idf3 = new Map<string, number>([
      ['стягнення', 7.0], ['апеляційний', 6.8], ['провадження', 6.5], ['касаційний', 6.2],
      ['зобов’язання', 6.0], ['оскарження', 5.8], ['донецьк', 3.0],
    ]);
    const df3 = new Map<string, number>([
      ['стягнення', 5_000], ['апеляційний', 6_000], ['провадження', 7_000], ['касаційний', 8_000],
      ['зобов’язання', 9_000], ['оскарження', 10_000], ['донецьк', 120_000],
    ]);
    const out = selectFtsTerms(tokens, idf3, { df: df3, sampleDocs: 3_000_000 });
    expect(out.slice(0, 6)).toContain('Донецьк');   // survives the 6-cap despite lowest idf
  });

  it('handles declined forms via prefix matching (Донецьку, переміщених)', () => {
    const tokens = ['податок', 'нерухомість', 'окупована', 'переміщених', 'Донецьку'];
    const idf4 = new Map<string, number>([
      ['податок', 0.2], ['нерухомість', 1.0], ['окупована', 4.0],
      ['переміщених', 6.5], ['донецьку', 3.0],
    ]);
    const df4 = new Map<string, number>([
      ['податок', 2_000_000], ['нерухомість', 400_000], ['окупована', 30_000],
      ['переміщених', 1_095], ['донецьку', 120_000],
    ]);
    const out = selectFtsTerms(tokens, idf4, { df: df4, sampleDocs: 3_000_000 });
    expect(out[0]).toBe('Донецьку');
    expect(out[out.length - 1]).toBe('переміщених');
  });

  it('does not change behaviour for queries without status/geo vocabulary', () => {
    const tokens = ['податок', 'нерухомість', 'окупована', 'територія'];
    const out = selectFtsTerms(tokens, idf, opts);
    expect(out).toEqual(['окупована', 'територія', 'нерухомість', 'податок']);
  });
});
