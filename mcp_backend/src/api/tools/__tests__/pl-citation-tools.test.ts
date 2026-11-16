/** pl_find_decisions_by_article: consolidation folding, filters, counts and paging; db mocked. */

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { PlCitationTools, courtTypeKey, normalizeEli } from '../pl-citation-tools.js';
import { V2_TOOL_NAMES } from '../../curated-mcp-tools.js';

function mockDb(answers: Array<(sql: string, params: unknown[]) => any[]>) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    transaction: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        if (/^SET LOCAL/.test(sql)) return { rows: [] };
        seen.push({ sql, params });
        const next = answers.shift();
        return { rows: next ? next(sql, params) : [] };
      },
    }),
  };
  return { db, seen };
}

const parse = (r: any) => JSON.parse(r.content[0].text);
const KC = { eli: 'DU/1964/93', title: 'Kodeks cywilny', in_force: 'IN_FORCE', is_consolidation: false, consolidates_eli: null };

describe('helpers', () => {
  it('normalizes ELI and folds court labels', () => {
    expect(normalizeEli(' du/1964/093 ')).toBe('DU/1964/93');
    expect(normalizeEli('Kodeks')).toBeNull();
    expect(courtTypeKey('administrative court')).toBe('administrative');
    expect(courtTypeKey('ordinary_court')).toBe('common');
    expect(courtTypeKey(null)).toBe('unknown');
  });
});

describe('pl_find_decisions_by_article', () => {
  it('is a read-only curated tool with a Ukrainian description', () => {
    const [def] = new PlCitationTools({}).getToolDefinitions();
    expect(def.name).toBe('pl_find_decisions_by_article');
    expect(def.annotations?.readOnlyHint).toBe(true);
    expect(def.description).toMatch(/практика/i);
    expect(V2_TOOL_NAMES.has(def.name)).toBe(true);
  });

  it('counts by court and year and pages the newest decisions', async () => {
    const { db, seen } = mockDb([
      () => [KC],
      () => [
        { court_type: 'COMMON', year: 2020, n: 7 },
        { court_type: 'ordinary_court', year: 2019, n: 2 },
        { court_type: 'SUPREME', year: 2020, n: 1 },
      ],
      () => [
        { id: 'saos-1', case_number: 'I C 1/20', court_name: 'Sąd Rejonowy', court_type: 'COMMON', decision_date: '2020-05-01',
          citations: [{ cited_eli: 'DU/1964/93', art_no: '415', raw: 'art. 415' }] },
        { id: 'saos-2', case_number: 'I C 2/20', court_name: 'Sąd Okręgowy', court_type: 'COMMON', decision_date: '2020-04-01', citations: [] },
      ],
    ]);
    const r = parse(await new PlCitationTools(db).executeTool('pl_find_decisions_by_article',
      { eli: 'DU/1964/93', article: 'art. 415', court_type: 'common', date_from: '2019-01-01', limit: 1 }));
    expect(seen[1].params).toEqual(['DU/1964/93', '415', ['COMMON', 'ordinary_court'], '2019-01-01']);
    expect(seen[1].sql).toMatch(/court_type = ANY\(\$3::text\[\]\)/);
    expect(seen[2].sql).toMatch(/LIMIT 10\b/); // (0 + 1 + 1) * 5 rows scanned for a page of 1
    expect(r.total_decisions).toBe(10);
    expect(r.by_court_type).toEqual([{ court_type: 'common', decisions: 9 }, { court_type: 'supreme', decisions: 1 }]);
    expect(r.by_year).toEqual([{ year: 2020, decisions: 8 }, { year: 2019, decisions: 2 }]);
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]).toMatchObject({ id: 'saos-1', court_type: 'common' });
    expect(r.has_more).toBe(true);
  });

  it('folds a consolidated text onto its base act', async () => {
    const { db, seen } = mockDb([
      () => [{ eli: 'DU/2024/1061', title: 'Obwieszczenie', is_consolidation: true, consolidates_eli: 'DU/1964/93' }],
      () => [KC],
      () => [],
      () => [],
    ]);
    const r = parse(await new PlCitationTools(db).executeTool('pl_find_decisions_by_article', { eli: 'DU/2024/1061', article: '22¹' }));
    expect(r.act.eli).toBe('DU/1964/93');
    expect(r.resolved_from).toBe('DU/2024/1061');
    expect(seen[2].params).toEqual(['DU/1964/93', '22^1']);
    expect(r.total_decisions).toBe(0);
  });

  it('without article queries the whole act', async () => {
    const { db, seen } = mockDb([() => [KC], () => [], () => []]);
    await new PlCitationTools(db).executeTool('pl_find_decisions_by_article', { eli: 'DU/1964/93' });
    expect(seen[1].params).toEqual(['DU/1964/93']);
    expect(seen[1].sql).not.toMatch(/art_no/);
  });

  it('validates input before querying the citations', async () => {
    for (const args of [{}, { eli: 'x' }, { eli: 'DU/1964/93', court_type: 'nope' }, { eli: 'DU/1964/93', date_to: '2020-13-01' }]) {
      const { db, seen } = mockDb([() => [KC]]);
      const r: any = await new PlCitationTools(db).executeTool('pl_find_decisions_by_article', args);
      expect(r.isError).toBe(true);
      expect(seen.filter((q) => /pl_decision_citations/.test(q.sql))).toHaveLength(0);
    }
  });

  it('turns a statement timeout into a hint to narrow the query', async () => {
    const db = { transaction: async () => { throw new Error('canceling statement due to statement timeout'); } };
    const r: any = await new PlCitationTools(db).executeTool('pl_find_decisions_by_article', { eli: 'DU/1964/93' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Звузьте/);
  });

  it('ignores other tool names', async () => {
    expect(await new PlCitationTools({}).executeTool('pl_get_act', {})).toBeNull();
  });
});
