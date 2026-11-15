/** pl_get_act_relations, pl_get_act_structure, pl_count_cases_by_party: helpers and wiring, db mocked. */

import { PlLegalTools, RELATIONS, buildOutline, phraseTsQuery } from '../tools/pl-legal-tools.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

/** A db whose transaction() hands the tool a client answering queries in order. */
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
const KC = { eli: 'DU/1964/93', title: 'Kodeks cywilny', in_force: 'IN_FORCE', is_consolidation: false };

describe('phraseTsQuery', () => {
  it('joins words by their position gap and ORs the inflected forms', () => {
    expect(phraseTsQuery([
      { word: 'pkn', pos: 1, forms: [] },
      { word: 'orlen', pos: 2, forms: ['orlenu', 'orlen'] },
    ])).toBe("'pkn' <1> ('orlen' | 'orlenu')");
    expect(phraseTsQuery([{ word: 'a', pos: 1, forms: [] }, { word: 'b', pos: 3, forms: [] }])).toBe("'a' <2> 'b'");
  });

  it('escapes quotes and returns null for no words', () => {
    expect(phraseTsQuery([{ word: "o'neil", pos: 1, forms: [] }])).toBe("'o''neil'");
    expect(phraseTsQuery([])).toBeNull();
  });
});

describe('buildOutline', () => {
  const u = (ord: number, depth: number, unit_type: string, name: string | null, title: string | null = null, in_annex = false) =>
    ({ ord, depth, unit_type, name, title, in_annex });

  it('gives each heading the range of articles under it and closes headings by depth', () => {
    const { headings, articles } = buildOutline([
      u(1, 0, 'book', 'I', 'Księga I'),
      u(2, 1, 'titl', 'I', 'Tytuł I'),
      u(3, 2, 'arti', '1'), u(4, 2, 'arti', '2'),
      u(5, 1, 'titl', 'II', 'Tytuł II'),
      u(6, 2, 'arti', '43_10'),
      u(7, 0, 'book', 'II', 'Księga II'),
      u(8, 1, 'arti', '44'),
    ]);
    expect(articles).toEqual({ count: 4, first: '1', last: '44' });
    expect(headings.map((h) => [h.title, h.first_article, h.last_article, h.article_count])).toEqual([
      ['Księga I', '1', '43^10', 3],
      ['Tytuł I', '1', '2', 2],
      ['Tytuł II', '43^10', '43^10', 1],
      ['Księga II', '44', '44', 1],
    ]);
  });

  it('keeps in_annex only when the act has both annex and body headings', () => {
    expect(buildOutline([u(1, 0, 'part', null, 'A', true)]).headings[0]).not.toHaveProperty('in_annex');
    const mixed = buildOutline([u(1, 0, 'part', null, 'Body'), u(2, 0, 'part', null, 'Annex', true)]).headings;
    expect(mixed[1].in_annex).toBe(true);
  });
});

describe('PlLegalTools new tools', () => {
  it('pl_get_act_relations groups the preview by relation key in RELATIONS order', async () => {
    const { db, seen } = mockDb([
      () => [KC],
      () => [
        { category: 'Orzeczenie TK', total: 25, rn: 1, eli: 'DU/2023/2116' },
        { category: 'Akty zmieniające', total: 113, rn: 1, eli: 'DU/2026/507' },
        { category: 'Akty zmieniające', total: 113, rn: 2, eli: 'DU/2026/184' },
      ],
    ]);
    const r = parse(await new PlLegalTools(db).executeTool('pl_get_act_relations', { eli: 'du/1964/93' }));
    expect(seen[0].params).toEqual(['DU/1964/93']);
    expect(r.relations.map((g: any) => [g.relation, g.total, g.latest.length])).toEqual([
      ['amended_by', 113, 2], ['tk_rulings', 25, 1],
    ]);
    expect(r.relations[0].latest[0]).toEqual({ eli: 'DU/2026/507' });
  });

  it('pl_get_act_relations with relation pages one category and rejects unknown keys', async () => {
    const { db, seen } = mockDb([() => [KC], () => [{ eli: 'DU/2023/2116' }], () => [{ n: 25 }]]);
    const r = parse(await new PlLegalTools(db).executeTool('pl_get_act_relations', { eli: 'DU/1964/93', relation: 'tk_rulings', limit: 1 }));
    expect(seen[1].params).toEqual(['DU/1964/93', RELATIONS.tk_rulings]);
    expect(r).toMatchObject({ relation: 'tk_rulings', total: 25, has_more: false, limit: 1 });

    const bad: any = await new PlLegalTools(mockDb([() => [KC]]).db).executeTool('pl_get_act_relations', { eli: 'DU/1964/93', relation: 'nope' });
    expect(bad.isError).toBe(true);
  });

  it('pl_get_act_structure uses the newest segmented edition and warns about skipped PDF ones', async () => {
    const { db, seen } = mockDb([
      () => [KC],
      () => [
        { snapshot_eli: 'DU/2025/1071', exact_on: '2025-07-24', http_status: 906, article_count: 0, has_text: true },
        { snapshot_eli: 'DU/2024/1061', exact_on: '2024-06-19', http_status: 200, article_count: 1296, has_text: false },
      ],
      () => [{ ord: 1, depth: 0, unit_type: 'titl', name: 'I', title: 'Tytuł I', in_annex: false },
             { ord: 2, depth: 1, unit_type: 'arti', name: '1', title: 'Art. 1.', in_annex: false }],
    ]);
    const r = parse(await new PlLegalTools(db).executeTool('pl_get_act_structure', { eli: 'DU/1964/93' }));
    expect(seen[2].params[0]).toBe('DU/2024/1061');
    expect(r.snapshot.snapshot_eli).toBe('DU/2024/1061');
    expect(r.headings).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/DU\/2025\/1071/);
  });

  it('pl_count_cases_by_party builds a phrase tsquery and folds source court labels into keys', async () => {
    const { db, seen } = mockDb([
      () => [{ word: 'pkn', pos: 1, forms: [] }, { word: 'orlen', pos: 2, forms: ['orlenu'] }],
      () => [{
        total: 5,
        by_court_type: [{ court_type: 'COMMON', n: 2 }, { court_type: 'ordinary_court', n: 2 }, { court_type: 'SUPREME', n: 1 }],
        by_year: [{ year: 2020, n: 5 }],
        latest: [{ id: 'saos-1', court_type: 'SUPREME' }],
      }],
    ]);
    const r = parse(await new PlLegalTools(db).executeTool('pl_count_cases_by_party', { party: 'PKN  Orlen', court_type: 'common' }));
    expect(seen[1].params[0]).toBe("'pkn' <1> ('orlen' | 'orlenu')");
    expect(seen[1].params[1]).toEqual(['COMMON', 'ordinary_court']);
    expect(r).toMatchObject({ party: 'PKN Orlen', total: 5, by_court_type: { common: 4, supreme: 1 }, by_year: { 2020: 5 } });
    expect(r.latest[0].court_type).toBe('supreme');
  });

  it('pl_count_cases_by_party validates input before querying', async () => {
    for (const args of [{ party: 'ab' }, { party: 'PKN Orlen', court_type: 'tax' }, { party: 'PKN Orlen', date_from: '2020/01/01' }]) {
      const { db } = mockDb([() => [{ word: 'pkn', pos: 1, forms: [] }]]);
      const r: any = await new PlLegalTools(db).executeTool('pl_count_cases_by_party', args);
      expect(r.isError).toBe(true);
    }
  });
});
