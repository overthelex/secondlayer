/**
 * UkJudgmentTools — uk_search_judgments over the Find Case Law holding.
 *
 * The assertions follow the licence answers rather than the plumbing: an extract and
 * a link but never the whole judgment, no way to search by judge, and the coverage
 * gaps stated on every response — above all on an empty one, where a lawyer would
 * otherwise read "no result" as "no such case".
 */

import { UkJudgmentTools } from '../tools/uk-judgment-tools.js';
import { ToolRegistry } from '../tool-registry.js';
import { runWithJudgmentAccess } from '../../services/uk-judgment-access.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

function mockDb(routes: Array<{ match: RegExp; rows: any[] }>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      for (const r of routes) if (r.match.test(sql)) return { rows: r.rows };
      return { rows: [] };
    }),
  };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

const HIT = {
  _total_count: 516,
  neutral_citation: '[2024] EWHC 2789 (Ch)',
  case_name: 'Joanne Brierley v Christopher Howe & Anor',
  court_code: 'ewhc/ch',
  court_name: 'High Court (Chancery Division)',
  decision_date: '2024-11-06',
  case_number: 'CR-2023-000123',
  source_url: 'https://caselaw.nationalarchives.gov.uk/ewhc/ch/2024/2789',
  extract: '«unfair» «prejudice» «petition» brought in the context of a quasi-partnership',
};

describe('uk_search_judgments', () => {
  it('ranks over the stored vectors and returns an extract with a link, never full text', async () => {
    const db = mockDb([
      { match: /WITH page AS/, rows: [HIT] },
      { match: /uk_court_decision_fts\) AS n/, rows: [{ n: 0 }] },
    ]);
    const out = parse(await new UkJudgmentTools(db).executeTool('uk_search_judgments', {
      query: 'unfair prejudice petition',
    }));

    expect(out.total_count).toBe(516);
    expect(out.results[0].neutral_citation).toBe('[2024] EWHC 2789 (Ch)');
    expect(out.results[0].extract).toContain('«unfair»');
    expect(out.results[0].source_url).toMatch(/^https:\/\/caselaw\.nationalarchives\.gov\.uk\//);
    expect(out.results[0]).not.toHaveProperty('full_text');
    expect(out.licence).toMatch(/Open Justice/);
    expect(out.coverage).toMatch(/Відсутність результату НЕ означає/);
    expect(out.index_incomplete).toBeUndefined();

    const { sql, params } = db.calls.find((c) => /WITH page AS/.test(c.sql))!;
    expect(sql).toMatch(/JOIN uk_court_decision_fts f/);
    expect(sql).toMatch(/ts_rank_cd\(f\.fts/);
    // Headline only for the page, never computed over every hit.
    expect(sql.indexOf('ts_headline')).toBeGreaterThan(sql.indexOf('LIMIT'));
    // Only the result columns leave the database; full_text is read solely for the headline.
    expect(sql).not.toMatch(/d\.full_text AS|,\s*d\.full_text\s*,/);
    expect(params).toEqual(['unfair prejudice petition']);
  });

  it('states the coverage gaps on an empty result too', async () => {
    const db = mockDb([{ match: /uk_court_decision_fts\) AS n/, rows: [{ n: 0 }] }]);
    const out = parse(await new UkJudgmentTools(db).executeTool('uk_search_judgments', {
      query: 'murder conviction appeal',
    }));
    expect(out.total_count).toBe(0);
    expect(out.coverage).toMatch(/Court of Appeal \(Criminal Division\)/);
  });

  it('says so when the vector backfill has not caught up', async () => {
    const db = mockDb([
      { match: /WITH page AS/, rows: [HIT] },
      { match: /uk_court_decision_fts\) AS n/, rows: [{ n: 1200 }] },
    ]);
    const out = parse(await new UkJudgmentTools(db).executeTool('uk_search_judgments', { query: 'x' }));
    expect(out.index_incomplete).toMatch(/1200/);
  });

  it('looks up a citation without a text query, newest first, and binds no unused parameter', async () => {
    const db = mockDb([{ match: /WITH page AS/, rows: [{ ...HIT, _total_count: 1 }] }]);
    await new UkJudgmentTools(db).executeTool('uk_search_judgments', {
      citation: '[2021] UKSC 20', court: 'UKSC',
    });
    const { sql, params } = db.calls.find((c) => /WITH page AS/.test(c.sql))!;
    expect(sql).not.toMatch(/uk_court_decision_fts|websearch_to_tsquery/);
    // No rank without a query, so the order falls through to newest first.
    expect(sql).toMatch(/NULL::real AS rank/);
    expect(sql).toMatch(/ORDER BY rank DESC NULLS LAST, d\.decision_date DESC/);
    expect(params).toEqual(['%[2021] UKSC 20%', 'uksc']);
    // Every $n in the statement has a value, or Postgres rejects it outright.
    const used = new Set((sql.match(/\$\d+/g) || []).map((p) => Number(p.slice(1))));
    expect(Math.max(...used)).toBe(params.length);
  });

  it('escapes LIKE wildcards in citation and parties', async () => {
    const db = mockDb([]);
    await new UkJudgmentTools(db).executeTool('uk_search_judgments', { parties: '100%_x' });
    expect(db.calls[0].params).toEqual(['%100\\%\\_x%']);
  });

  it('never serves a hidden placeholder, on the text path or the citation path', async () => {
    const db = mockDb([]);
    const tools = new UkJudgmentTools(db);
    await tools.executeTool('uk_search_judgments', { query: 'x' });
    await tools.executeTool('uk_search_judgments', { citation: '[2016] EWHC 3256 (Fam)' });
    for (const c of db.calls.filter((c) => /WITH page AS/.test(c.sql))) {
      expect(c.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM uk_court_decision_hidden h WHERE h\.id = d\.id\)/);
    }
  });

  it('has no judge filter (licence principle 2)', () => {
    const def = new UkJudgmentTools(mockDb([])).getToolDefinitions()[0];
    expect(Object.keys((def.inputSchema as any).properties)).not.toContain('judge');
  });

  it('refuses a call with nothing to search on, and a malformed date', async () => {
    const tools = new UkJudgmentTools(mockDb([]));
    expect(parse(await tools.executeTool('uk_search_judgments', {})).error).toBe('missing_query');
    expect(parse(await tools.executeTool('uk_search_judgments', {
      query: 'x', date_from: '2024/01/01',
    })).error).toBe('bad_date');
  });

  it('rejects a date that has the right shape but does not exist', async () => {
    const tools = new UkJudgmentTools(mockDb([]));
    expect(parse(await tools.executeTool('uk_search_judgments', {
      query: 'x', date_to: '2024-02-31',
    })).error).toBe('bad_date');
  });

  it('turns fractional pagination into integers', async () => {
    const db = mockDb([]);
    await new UkJudgmentTools(db).executeTool('uk_search_judgments', { query: 'x', limit: 5.7, offset: 2.5 });
    expect(db.calls[0].sql).toMatch(/LIMIT 5 OFFSET 2/);
  });

  it('keeps the real total when the offset runs past the last match', async () => {
    const db = mockDb([
      { match: /SELECT count\(\*\) AS n FROM uk_court_decisions d/, rows: [{ n: 37 }] },
      { match: /uk_court_decision_fts\) AS n/, rows: [{ n: 0 }] },
    ]);
    const out = parse(await new UkJudgmentTools(db).executeTool('uk_search_judgments', {
      query: 'x', offset: 40,
    }));
    expect(out.results).toEqual([]);
    expect(out.total_count).toBe(37);
  });

  it('warns when index completeness cannot be checked, rather than implying it is complete', async () => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (/uk_court_decision_fts\) AS n/.test(sql)) throw new Error('boom');
        return { rows: [HIT] };
      }),
    };
    const out = parse(await new UkJudgmentTools(db).executeTool('uk_search_judgments', { query: 'x' }));
    expect(out.results).toHaveLength(1);
    expect(out.index_incomplete).toMatch(/Не вдалося перевірити/);
  });

  it('says what the extract is: highlighted matches with a query, the opening without one', async () => {
    const db = mockDb([{ match: /WITH page AS/, rows: [HIT] }]);
    const tools = new UkJudgmentTools(db);
    expect(parse(await tools.executeTool('uk_search_judgments', { query: 'x' })).extract_note)
      .toMatch(/навколо збігів/);
    expect(parse(await tools.executeTool('uk_search_judgments', { citation: '[2024]' })).extract_note)
      .toMatch(/перші 400 символів/);
  });

  it('bounds the extract in the database, not in the caller', async () => {
    const db = mockDb([]);
    await new UkJudgmentTools(db).executeTool('uk_search_judgments', { query: 'x' });
    await new UkJudgmentTools(db).executeTool('uk_search_judgments', { parties: 'x' });
    expect(db.calls[0].sql).toMatch(/MaxFragments=3,MaxWords=35/);
    expect(db.calls[db.calls.length - 1].sql).toMatch(/left\(COALESCE\(d\.full_text, ''\), 400\)/);
  });

  it('caps limit at 20', async () => {
    const db = mockDb([]);
    await new UkJudgmentTools(db).executeTool('uk_search_judgments', { query: 'x', limit: 500 });
    expect(db.calls[0].sql).toMatch(/LIMIT 20 OFFSET 0/);
  });
});

describe('ToolRegistry licence backstop', () => {
  const registryWith = (db: any) => {
    const registry = new ToolRegistry();
    registry.registerHandler(new UkJudgmentTools(db));
    return registry;
  };

  it('refuses the judgments to a path that never ran the access check', async () => {
    const db = mockDb([{ match: /WITH page AS/, rows: [HIT] }]);
    const out: any = await registryWith(db).executeTool('uk_search_judgments', { query: 'x' });
    expect(out.isError).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('refuses the streaming dispatch too', async () => {
    const out: any = await registryWith(mockDb([])).executeToolStream('uk_search_judgments', { query: 'x' }, () => {});
    expect(out.isError).toBe(true);
  });

  it('serves them once the transport has granted access on this request', async () => {
    const db = mockDb([{ match: /WITH page AS/, rows: [HIT] }]);
    const out: any = await runWithJudgmentAccess(() =>
      registryWith(db).executeTool('uk_search_judgments', { query: 'x' }));
    expect(out.isError).toBeUndefined();
    expect(parse(out).results).toHaveLength(1);
  });
});
