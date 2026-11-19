/**
 * financial_figures against a real PostgreSQL: migration 278, the later-filing-wins
 * upsert, the stale-row check of get_financial_statements and the search_registry
 * financial_statements query. Synthetic data only.
 *
 * Skipped unless FINFIG_TEST_PG_URL points at a THROWAWAY database (tables are dropped
 * and recreated), e.g. a `docker run postgres:15-alpine` container.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { figureRowFromFiling } from '../tools/financial-statement-figures.js';
import { upsertFigureRows } from '../../services/financial-figures-store.js';
import { FinancialStatementsTool } from '../tools/financial-statements-tool.js';
import { RegistrySearchTool } from '../tools/registry-search-tool.js';

const URL = process.env.FINFIG_TEST_PG_URL;
const d = URL ? describe : describe.skip;

const xml = (dFill: string, assets: number) => `<DECLAR><DECLARHEAD><TIN>1234</TIN><C_DOC_SUB>001</C_DOC_SUB><D_FILL>${dFill}</D_FILL></DECLARHEAD>`
  + `<DECLARBODY><FIRM_NAME>ТОВ ТЕСТ</FIRM_NAME><MY_DATE>31122024</MY_DATE><A1300>1</A1300><B1300>${assets}</B1300>`
  + `<B1495>1</B1495><B1900>${assets}</B1900></DECLARBODY></DECLAR>`;
const filing = (id: number, dFill: string, assets: number, tin = '1234') =>
  ({ id, tin, c_doc_sub: '001', period_year: 2024, period_month: 12, raw_xml: xml(dFill, assets) });

d('financial_figures on PostgreSQL', () => {
  let pool: Pool;
  const assets = async () => Number((await pool.query(`SELECT assets FROM financial_figures WHERE edrpou = '00001234'`)).rows[0].assets);

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 2 });
    await pool.query(`
      DROP TABLE IF EXISTS financial_figures, financial_figures_progress, opendata_financial_statements, tool_pricing;
      CREATE TABLE tool_pricing (tool_name TEXT PRIMARY KEY, service TEXT, display_name TEXT, base_cost_usd NUMERIC,
        markup_percent NUMERIC, notes TEXT, updated_by TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE opendata_financial_statements (id BIGSERIAL PRIMARY KEY, tin TEXT NOT NULL, c_doc TEXT, c_doc_sub TEXT,
        c_doc_ver TEXT, period_year INT, period_month INT, period_type INT, c_reg TEXT, c_raj TEXT, form_type TEXT,
        raw_xml TEXT, imported_at TIMESTAMPTZ DEFAULT NOW());`);
    const migration = readFileSync(join(__dirname, '..', '..', 'migrations', '278_financial_figures.sql'), 'utf8');
    await pool.query(migration);
    await pool.query(migration); // idempotent
  });
  afterAll(async () => { await pool?.end(); });

  it('upsert: an older filing does not replace a newer one; a later or equal one does', async () => {
    await upsertFigureRows(pool, [figureRowFromFiling(filing(10, '20022025', 120))!]);
    expect(await assets()).toBe(120);
    // Older D_FILL, higher id: kept out.
    await upsertFigureRows(pool, [figureRowFromFiling(filing(11, '01022025', 999))!]);
    expect(await assets()).toBe(120);
    // Later D_FILL, lower id: wins.
    await upsertFigureRows(pool, [figureRowFromFiling(filing(5, '15042025', 130))!]);
    expect(await assets()).toBe(130);
    // Same filing again (rerun): refreshed.
    await upsertFigureRows(pool, [figureRowFromFiling(filing(5, '15042025', 131))!]);
    expect(await assets()).toBe(131);
    // C_DOC_STAN breaks a D_FILL tie.
    const restated = figureRowFromFiling(filing(4, '15042025', 140))!;
    await upsertFigureRows(pool, [{ ...restated, doc_stan: 3 }]);
    expect(await assets()).toBe(140);
    const row = (await pool.query(`SELECT cur, prev, to_char(filed_on, 'YYYY-MM-DD') f FROM financial_figures`)).rows[0];
    expect(row.cur['1300']).toBe(140);
    expect(row.prev).toEqual({ '1300': 1 });
    expect(row.f).toBe('2025-04-15');
  });

  it('get_financial_statements parses a filing refreshed after its figures row', async () => {
    await pool.query('TRUNCATE financial_figures, opendata_financial_statements');
    await pool.query(`INSERT INTO opendata_financial_statements (id, tin, c_doc_sub, period_year, period_month, form_type, raw_xml, imported_at)
      VALUES (20, '1234', '001', 2024, 12, 'S0100115', $1, NOW() - interval '1 day')`, [xml('20022025', 120)]);
    await upsertFigureRows(pool, [figureRowFromFiling(filing(20, '20022025', 120))!]);
    const tool = new FinancialStatementsTool(pool);
    const read = async () => JSON.parse((await tool.executeTool('get_financial_statements', { edrpou: '1234' }))!.content[0].text);
    let body = await read();
    expect(body.parsed_on_the_fly).toBeUndefined();
    expect(body.periods[0].key_figures.find((k: any) => k.key === 'assets').value).toBe(120);
    // The importer replaces the XML in place (same id) and bumps imported_at.
    await pool.query(`UPDATE opendata_financial_statements SET raw_xml = $1, imported_at = NOW() + interval '1 second' WHERE id = 20`, [xml('20022025', 125)]);
    body = await read();
    expect(body.parsed_on_the_fly).toBe(true);
    expect(body.periods[0].key_figures.find((k: any) => k.key === 'assets').value).toBe(125);
  });

  it('search_registry financial_statements: stored figures when fresh, never personal tax numbers', async () => {
    await pool.query('TRUNCATE financial_figures, opendata_financial_statements');
    await pool.query(`INSERT INTO opendata_financial_statements (id, tin, c_doc_sub, period_year, period_month, form_type, raw_xml, imported_at)
      VALUES (30, '1234', '001', 2024, 12, 'S0100115', $1, NOW() - interval '1 day'),
             (31, '1234567890', '001', 2024, 12, 'S0100115', $2, NOW() - interval '1 day')`, [xml('20022025', 120), xml('20022025', 7)]);
    // Stored cells differ from the XML on purpose, to see which path served the row.
    const stored = figureRowFromFiling(filing(30, '20022025', 150))!;
    await upsertFigureRows(pool, [stored]);
    const reg = new RegistrySearchTool(pool);
    const search = async (tin: string) => {
      const text = (await reg.executeTool('search_registry', { registry: 'financial_statements', filters: { tin } }))!.content[0].text;
      try { return JSON.parse(text); } catch { return { results: [], message: text }; }
    };
    const body = await search('1234');
    expect(body.results).toHaveLength(1);
    expect(body.results[0].figures.find((f: any) => f.key === 'total_assets').current).toBe(150);
    expect(JSON.stringify(body)).not.toContain('DECLAR');
    const personal = await search('1234567890');
    expect(personal.results ?? []).toHaveLength(0);
  });
});
