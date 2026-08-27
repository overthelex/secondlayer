/**
 * Unit tests for the `canton` parameter on ChLegislationTools (mocked db.query).
 *
 * A mocked db.query cannot validate SQL; these tests pin the contract that is visible
 * at the call boundary: which jurisdiction value is bound, that an invalid canton is
 * rejected before any query runs, that 'all' is accepted by search only, and that the
 * jurisdiction column travels through to the output. The SQL itself is exercised by
 * ch-legislation-tools.pg.test.ts against a real PostgreSQL.
 */

import { ChLegislationTools } from '../ch-legislation-tools';

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

type QueryCall = { sql: string; params: unknown[] | undefined };

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function text(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

function makeDb(responses: Array<{ rows: any[] }>) {
  const calls: QueryCall[] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected query #${calls.length}: ${sql.slice(0, 80)}`);
    return next;
  });
  return { db: { query }, calls, query };
}

const ACT_ROW = {
  act_id: 'act-1',
  sr_number: '220',
  abbreviation: 'OR',
  title_de: 'Obligationenrecht',
  title_fr: 'Code des obligations',
  title_it: 'Codice delle obbligazioni',
  jurisdiction: 'CH',
};

const SEARCH_ROW = {
  act_id: 'act-1',
  sr_number: '220',
  abbreviation: 'OR',
  title: 'Obligationenrecht',
  title_de: 'Obligationenrecht',
  title_fr: 'Code des obligations',
  title_it: 'Codice delle obbligazioni',
  date_entry_force: '1912-01-01',
  date_no_longer_in_force: null,
  in_force: true,
  eli_work_uri: 'https://fedlex.data.admin.ch/eli/cc/27/317_321_377',
  jurisdiction: 'CH',
  editions_count: 3,
  latest_edition_date: '2024-01-01',
  _total_count: 1,
};

describe('ChLegislationTools canton parameter', () => {
  describe('tool definitions', () => {
    it('every tool exposes an optional canton argument and mentions cantonal legislation', () => {
      const tools = new ChLegislationTools({ query: jest.fn() });
      const defs = tools.getToolDefinitions();
      expect(defs.map((d) => d.name)).toEqual([
        'ch_search_legislation', 'ch_get_act_article', 'ch_get_act_history', 'ch_get_act_text',
      ]);
      // ch_get_act_text has no canton argument: unlike the other three, it always
      // resolves sr_number against the federal jurisdiction (see its own describe block).
      const cantonAware = defs.filter((d) => d.name !== 'ch_get_act_text');
      for (const def of cantonAware) {
        expect(def.inputSchema.properties.canton).toBeDefined();
        expect(def.inputSchema.required).not.toContain('canton');
        expect(def.description).toContain('кантонального');
      }

      const actText = defs.find((d) => d.name === 'ch_get_act_text')!;
      expect(actText.inputSchema.properties.canton).toBeUndefined();
      expect(actText.description).toContain('Обов\'язково рівно один з act_id або sr_number');
      expect(actText.description).toContain('для кантональних актів використовуйте act_id');
      expect(actText.description).toContain('nearest_earlier_edition');
      expect(actText.description).toContain('nearest_later_edition');
    });

    it('ch_search_legislation chains to ch_get_act_text in its "Далі:" line', () => {
      const tools = new ChLegislationTools({ query: jest.fn() });
      const search = tools.getToolDefinitions().find((d) => d.name === 'ch_search_legislation')!;
      expect(search.description).toContain('ch_get_act_text');
    });
  });

  describe('ch_search_legislation', () => {
    it('binds the default jurisdiction CH, keeps aliases federal, and returns jurisdiction on rows', async () => {
      const { db, calls } = makeDb([
        { rows: [{ alias_table_exists: true }] },
        { rows: [SEARCH_ROW] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_search_legislation', { query: '220' }) as any);

      expect(calls).toHaveLength(2);
      const search = calls[1];
      expect(search.params).toContain('CH');
      expect(search.sql).toMatch(/a\.jurisdiction = \$\d+/);
      expect(search.sql).toContain("AND a.jurisdiction = 'CH'");
      expect(search.sql).toMatch(/SELECT[\s\S]*jurisdiction[\s\S]*FROM ch_act a/);
      expect(result.results[0].jurisdiction).toBe('CH');
    });

    it('binds a canton code when given', async () => {
      const { db, calls } = makeDb([
        { rows: [{ alias_table_exists: false }] },
        { rows: [{ ...SEARCH_ROW, sr_number: '131.1', jurisdiction: 'ZH' }] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_search_legislation', { query: '131.1', canton: 'ZH' }) as any);

      expect(calls[1].params).toContain('ZH');
      expect(calls[1].params).not.toContain('CH');
      expect(result.results[0].jurisdiction).toBe('ZH');
    });

    it("accepts 'all' and binds it so the jurisdiction filter is disabled", async () => {
      const { db, calls } = makeDb([
        { rows: [{ alias_table_exists: true }] },
        { rows: [SEARCH_ROW, { ...SEARCH_ROW, act_id: 'act-2', jurisdiction: 'BE' }] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_search_legislation', { query: 'OR', canton: 'all' }) as any);

      const search = calls[1];
      expect(search.params).toContain('all');
      expect(search.sql).toMatch(/\$(\d+) = 'all' OR a\.jurisdiction = \$\1/);
      expect(result.results.map((r: any) => r.jurisdiction)).toEqual(['CH', 'BE']);
    });

    it('rejects an invalid canton with a Ukrainian message before any query runs', async () => {
      const { db, query } = makeDb([]);
      const tools = new ChLegislationTools(db);

      const result = await tools.executeTool('ch_search_legislation', { query: '220', canton: 'xx' }) as any;

      expect(query).not.toHaveBeenCalled();
      expect(text(result)).toMatch(/canton/);
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
      expect(result.isError).toBeUndefined();
    });

    it('leaves the query shape unchanged for callers that do not pass canton', async () => {
      const { db, calls } = makeDb([
        { rows: [{ alias_table_exists: true }] },
        { rows: [SEARCH_ROW] },
      ]);
      const tools = new ChLegislationTools(db);

      await tools.executeTool('ch_search_legislation', { query: 'Obligationenrecht', lang: 'de', limit: 5, offset: 10 });

      const search = calls[1];
      expect(search.params?.[0]).toBe('Obligationenrecht');
      expect(search.params?.[1]).toBe('de');
      expect(search.params).toEqual(expect.arrayContaining([5, 10, 'CH']));
      expect(search.sql).toContain('AND enforcement_status = 0');
      expect(search.sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    });
  });

  describe('ch_get_act_article', () => {
    function articleResponses(act = ACT_ROW) {
      return [
        { rows: [act] },
        { rows: [{ d: '2026-08-26' }] },
        { rows: [{ version_id: 'v-1', eli_consolidation_uri: 'https://fedlex.data.admin.ch/eli/cc/27/317_321_377/20240101', date_applicability: '2024-01-01', date_end_applicability: null }] },
        { rows: [{ e_id: 'art_336', article_number: '336', marginal_note: 'Kündigung', text: 'Text' }] },
        { rows: [{ total: 3, latest_date: '2024-01-01' }] },
      ];
    }

    it('resolves the act by jurisdiction CH by default and reports jurisdiction', async () => {
      const { db, calls } = makeDb(articleResponses());
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_article', { sr_number: '220', article: '336' }) as any);

      expect(calls[0].params).toEqual(['220', 'CH']);
      expect(calls[0].sql).toMatch(/jurisdiction = \$2/);
      expect(calls[0].sql).toMatch(/sr_number = \$1/);
      expect(calls[0].sql).toContain('ORDER BY enforcement_status = 0 DESC');
      expect(result.jurisdiction).toBe('CH');
      expect(result.sr_number).toBe('220');
      expect(result.article.article_number).toBe('336');
    });

    it('resolves a cantonal act when canton is given', async () => {
      const { db, calls } = makeDb(articleResponses({ ...ACT_ROW, sr_number: '131.1', abbreviation: 'KV', jurisdiction: 'ZH' }));
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_article', { sr_number: '131.1', article: '1', canton: 'ZH' }) as any);

      expect(calls[0].params).toEqual(['131.1', 'ZH']);
      expect(result.jurisdiction).toBe('ZH');
    });

    it("rejects 'all' and lowercase codes with a Ukrainian message before any query runs", async () => {
      for (const canton of ['all', 'zh', 'ZHH', '']) {
        const { db, query } = makeDb([]);
        const tools = new ChLegislationTools(db);
        const result = await tools.executeTool('ch_get_act_article', { sr_number: '220', article: '336', canton }) as any;
        if (canton === '') {
          // An empty string is not a canton either, but it must not be confused with "absent".
          expect(text(result)).toMatch(/[Ѐ-ӿ]/);
        }
        expect(query).not.toHaveBeenCalled();
        expect(text(result)).toMatch(/canton/);
        expect(text(result)).toMatch(/[Ѐ-ӿ]/);
      }
    });

    it('carries jurisdiction on the not_found payload', async () => {
      const { db } = makeDb([{ rows: [] }]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_article', { sr_number: '999', article: '1', canton: 'BE' }) as any);

      expect(result).toEqual({ error: 'not_found', entity: 'act', sr_number: '999', jurisdiction: 'BE' });
    });
  });

  describe('ch_get_act_history', () => {
    function historyResponses(act = ACT_ROW) {
      return [
        { rows: [act] },
        { rows: [{ date_applicability: '2024-01-01', date_end_applicability: null, article_count: 10 }] },
        { rows: [{ date_applicability: '2024-01-01', change_type: 'modified', article_number: '336', e_id: 'art_336' }] },
        { rows: [] },
      ];
    }

    it('resolves the act by jurisdiction CH by default and reports jurisdiction', async () => {
      const { db, calls } = makeDb(historyResponses());
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_history', { sr_number: '220' }) as any);

      expect(calls[0].params).toEqual(['220', 'CH']);
      expect(calls[0].sql).toMatch(/jurisdiction = \$2/);
      expect(calls[0].sql).toContain('ORDER BY enforcement_status = 0 DESC');
      expect(result.jurisdiction).toBe('CH');
      expect(result.editions).toHaveLength(1);
      expect(result.changes).toHaveLength(1);
    });

    it('resolves a cantonal act when canton is given', async () => {
      const { db, calls } = makeDb(historyResponses({ ...ACT_ROW, sr_number: '131.1', jurisdiction: 'BE' }));
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_history', { sr_number: '131.1', canton: 'BE' }) as any);

      expect(calls[0].params).toEqual(['131.1', 'BE']);
      expect(result.jurisdiction).toBe('BE');
    });

    it("rejects 'all' with a Ukrainian message before any query runs", async () => {
      const { db, query } = makeDb([]);
      const tools = new ChLegislationTools(db);

      const result = await tools.executeTool('ch_get_act_history', { sr_number: '220', canton: 'all' }) as any;

      expect(query).not.toHaveBeenCalled();
      expect(text(result)).toMatch(/canton/);
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
    });
  });

  describe('ch_get_act_text', () => {
    it('rejects when neither act_id nor sr_number is given, before any query runs', async () => {
      const { db, query } = makeDb([]);
      const tools = new ChLegislationTools(db);

      const result = await tools.executeTool('ch_get_act_text', { as_of: '2020-01-01' }) as any;

      expect(query).not.toHaveBeenCalled();
      expect(text(result)).toMatch(/act_id/);
      expect(text(result)).toMatch(/sr_number/);
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
    });

    it('rejects when both act_id and sr_number are given, before any query runs', async () => {
      const { db, query } = makeDb([]);
      const tools = new ChLegislationTools(db);

      const result = await tools.executeTool('ch_get_act_text', {
        act_id: 1, sr_number: '220', as_of: '2020-01-01',
      }) as any;

      expect(query).not.toHaveBeenCalled();
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
    });

    it('rejects a missing as_of, before any query runs', async () => {
      const { db, query } = makeDb([]);
      const tools = new ChLegislationTools(db);

      const result = await tools.executeTool('ch_get_act_text', { sr_number: '220' }) as any;

      expect(query).not.toHaveBeenCalled();
      expect(text(result)).toMatch(/as_of/);
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
    });

    it('rejects a calendar-invalid as_of with a YYYY-MM-DD format error, before any query runs', async () => {
      const { db, query } = makeDb([]);
      const tools = new ChLegislationTools(db);

      const result = await tools.executeTool('ch_get_act_text', { sr_number: '220', as_of: '2025-13-01' }) as any;

      expect(query).not.toHaveBeenCalled();
      expect(text(result)).toMatch(/YYYY-MM-DD/);
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
    });

    it('rejects an unsupported lang, before any query runs', async () => {
      const { db, query } = makeDb([]);
      const tools = new ChLegislationTools(db);

      const result = await tools.executeTool('ch_get_act_text', {
        sr_number: '220', as_of: '2020-01-01', lang: 'en',
      }) as any;

      expect(query).not.toHaveBeenCalled();
      expect(text(result)).toMatch(/lang/);
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
    });

    it('resolves sr_number scoped to the federal jurisdiction, ordered like the other ch_* tools', async () => {
      const { db, calls } = makeDb([
        { rows: [{ act_id: '1', sr_number: '220', jurisdiction: 'CH', title_de: 'Obligationenrecht', title_fr: null, title_it: null }] },
        { rows: [{ version_id: 'v-1', lang: 'de', source: 'fedlex', date_applicability: '2020-01-01', date_end_applicability: null }] },
        { rows: [{ text_slice: 'Text', total: 4 }] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_text', { sr_number: '220', as_of: '2020-01-01' }) as any);

      expect(calls[0].sql).toMatch(/jurisdiction = 'CH'/);
      expect(calls[0].sql).toMatch(/sr_number = \$1/);
      expect(calls[0].sql).toMatch(/ORDER BY in_force DESC/);
      expect(calls[0].params).toEqual(['220']);
      expect(result.act_id).toBe(1);
      expect(result.sr_number).toBe('220');
      expect(result.lang).toBe('de');
      expect(result.requested_lang).toBe('de');
      expect(result.retrieval_status).toBe('edition_at_date');
      expect(result.text).toBe('Text');
      expect(result.text_total_chars).toBe(4);
      expect(result.jurisdiction).toBe('CH');
    });

    it('resolves act_id directly by act_id = $1, not by sr_number', async () => {
      const { db, calls } = makeDb([
        { rows: [{ act_id: '42', sr_number: '220', jurisdiction: 'CH', title_de: 'Obligationenrecht', title_fr: null, title_it: null }] },
        { rows: [{ version_id: 'v-1', lang: 'de', source: 'fedlex_pdf', date_applicability: '1990-01-01', date_end_applicability: '1999-12-31' }] },
        { rows: [{ text_slice: 'Text', total: 4 }] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_text', { act_id: 42, as_of: '1995-01-01' }) as any);

      expect(calls[0].sql).toMatch(/WHERE act_id = \$1/);
      expect(calls[0].sql).not.toMatch(/WHERE jurisdiction = 'CH' AND sr_number/);
      expect(calls[0].params).toEqual([42]);
      expect(result.act_id).toBe(42);
      expect(result.edition.source).toBe('fedlex_pdf');
      expect(result.jurisdiction).toBe('CH');
    });

    it('echoes the real jurisdiction (ZH) for a cantonal act resolved via act_id, not a hardcoded CH', async () => {
      const { db } = makeDb([
        { rows: [{ act_id: '7', sr_number: '131.1', jurisdiction: 'ZH', title_de: 'Zuercher Erlass', title_fr: null, title_it: null }] },
        { rows: [{ version_id: 'v-zh', lang: 'de', source: 'lexwork', date_applicability: '2020-01-01', date_end_applicability: null }] },
        { rows: [{ text_slice: 'Kantonaler Text', total: 15 }] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_text', { act_id: 7, as_of: '2021-01-01' }) as any);

      expect(result.jurisdiction).toBe('ZH');
    });

    it('clamps a negative offset to 0 and binds it as the second slicing parameter', async () => {
      const { db, calls } = makeDb([
        { rows: [{ act_id: '1', sr_number: '220', jurisdiction: 'CH', title_de: 'Obligationenrecht', title_fr: null, title_it: null }] },
        { rows: [{ version_id: 'v-1', lang: 'de', source: 'fedlex', date_applicability: '2020-01-01', date_end_applicability: null }] },
        { rows: [{ text_slice: 'Text', total: 4 }] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_text', {
        sr_number: '220', as_of: '2020-01-01', offset: -50,
      }) as any);

      expect(calls[2].params).toEqual(['v-1', 0, 50000]);
      expect(result.text_offset).toBe(0);
    });

    it('caps max_chars at 200000 rather than erroring', async () => {
      const { db, calls } = makeDb([
        { rows: [{ act_id: '1', sr_number: '220', jurisdiction: 'CH', title_de: 'Obligationenrecht', title_fr: null, title_it: null }] },
        { rows: [{ version_id: 'v-1', lang: 'de', source: 'fedlex', date_applicability: '2020-01-01', date_end_applicability: null }] },
        { rows: [{ text_slice: 'Text', total: 4 }] },
      ]);
      const tools = new ChLegislationTools(db);

      await tools.executeTool('ch_get_act_text', { sr_number: '220', as_of: '2020-01-01', max_chars: 999999 });

      expect(calls[2].params).toEqual(['v-1', 0, 200000]);
    });

    it('falls back to the NEAREST edition (by ORDER BY distance, not earliest) when no edition covers as_of', async () => {
      const { db, calls } = makeDb([
        { rows: [{ act_id: '1', sr_number: '220', jurisdiction: 'CH', title_de: 'Obligationenrecht', title_fr: null, title_it: null }] },
        { rows: [] },
        { rows: [{ version_id: 'v-1', lang: 'de', source: 'fedlex', date_applicability: '2015-01-01', date_end_applicability: '2019-12-31' }] },
        { rows: [{ text_slice: 'Old text', total: 8 }] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_text', { sr_number: '220', as_of: '2000-01-01' }) as any);

      expect(calls[2].sql).toMatch(
        /ORDER BY \(v\.lang = \$3\) DESC, \(v\.lang = 'de'\) DESC,\s*\(v\.date_applicability <= \$2::date\) DESC,\s*CASE WHEN v\.date_applicability <= \$2::date/
      );
      expect(calls[2].params).toEqual(['1', '2000-01-01', 'de']);
      // Served edition (2015) starts AFTER as_of (2000) -> nearest_later_edition.
      expect(result.retrieval_status).toBe('nearest_later_edition');
      expect(result.edition.date_applicability).toBe('2015-01-01');
    });

    it('labels the served fallback row nearest_earlier_edition when its date_applicability is at or before as_of', async () => {
      const { db } = makeDb([
        { rows: [{ act_id: '1', sr_number: '220', jurisdiction: 'CH', title_de: 'Obligationenrecht', title_fr: null, title_it: null }] },
        { rows: [] },
        { rows: [{ version_id: 'v-2', lang: 'de', source: 'fedlex_pdf', date_applicability: '2003-01-01', date_end_applicability: '2007-12-31' }] },
        { rows: [{ text_slice: 'Text 2003', total: 9 }] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_text', { sr_number: '220', as_of: '2009-06-01' }) as any);

      expect(result.retrieval_status).toBe('nearest_earlier_edition');
      expect(result.edition.date_applicability).toBe('2003-01-01');
    });

    it('reports no_edition_for_date when the act has no parsed edition with usable text at all', async () => {
      const { db } = makeDb([
        { rows: [{ act_id: '1', sr_number: '220', jurisdiction: 'CH', title_de: 'Obligationenrecht', title_fr: null, title_it: null }] },
        { rows: [] },
        { rows: [] },
      ]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_text', { sr_number: '220', as_of: '2020-01-01' }) as any);

      expect(result).toEqual({ error: 'no_edition_for_date', act_id: 1, earliest_edition: null });
    });

    it('reports not_found (like the sibling ch_* tools), not no_edition_for_date, for an act_id that does not resolve at all', async () => {
      const { db, query } = makeDb([{ rows: [] }]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_text', { act_id: 999, as_of: '2020-01-01' }) as any);

      expect(query).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ error: 'not_found', entity: 'act', act_id: 999, jurisdiction: 'CH' });
    });

    it('reports not_found for an sr_number that does not resolve at all', async () => {
      const { db, query } = makeDb([{ rows: [] }]);
      const tools = new ChLegislationTools(db);

      const result = parse(await tools.executeTool('ch_get_act_text', { sr_number: '999999', as_of: '2020-01-01' }) as any);

      expect(query).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ error: 'not_found', entity: 'act', sr_number: '999999', jurisdiction: 'CH' });
    });
  });
});
