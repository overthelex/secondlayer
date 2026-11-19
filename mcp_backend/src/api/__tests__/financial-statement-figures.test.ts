/**
 * Key figures parsed from financial-statement XML (opendata_financial_statements.raw_xml).
 *
 * Fixtures are real filings from the data.gov.ua dataset, trimmed (empty xsi:nil lines,
 * signatories, address and phone removed). Form 1/2: Київстар (21673832), year 2025.
 * The small- and micro-business filings have name and code replaced.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { financialStatementRow, latestFigures, parseStatementFigures, readTags } from '../tools/financial-statement-figures.js';
import { RegistrySearchTool } from '../tools/registry-search-tool.js';
import { CompanyDossierTool } from '../tools/company-dossier-tool.js';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', 'financial-statements', name), 'utf8');
const FORM1 = fx('S0100115-form1.xml');
const FORM2 = fx('S0100215-form2.xml');
const SMALL = fx('S0110014-small.xml');
const MICRO = fx('S0111007-micro.xml');

const byKey = (figs: any[]) => Object.fromEntries(figs.map((f) => [f.key, f]));

describe('parseStatementFigures', () => {
  it('Форма 1: B = end of period (current), A = start (prior); assets equal liabilities + equity', () => {
    const p = parseStatementFigures('001', FORM1)!;
    const f = byKey(p.figures);
    expect(p.report_date).toBe('2025-12-31');
    expect(p.units).toBe('тис. грн');
    expect(f.total_assets).toMatchObject({ line: '1300', current: 84939977, prior: 66444189 });
    expect(f.non_current_assets).toMatchObject({ current: 60443984, prior: 42319722 });
    expect(f.current_assets).toMatchObject({ current: 24495946, prior: 24124467 });
    expect(f.equity).toMatchObject({ line: '1495', current: 56315286, prior: 44018754 });
    expect(f.long_term_liabilities).toMatchObject({ line: '1595', current: 13527604, prior: 9721831 });
    expect(f.current_liabilities).toMatchObject({ line: '1695', current: 15097087, prior: 12703604 });
    // 1900 = 1495 + 1595 + 1695 (1700 and 1800 are zero in this filing)
    expect(f.equity.current + f.long_term_liabilities.current + f.current_liabilities.current).toBe(f.total_assets.current);
    expect(p.balance_check).toBe(true);
    expect(p.columns.balance).toEqual({ current: 'на кінець звітного періоду', prior: 'на початок звітного періоду' });
  });

  it('Форма 2: A = reporting period, B = same period last year; profit net of loss lines', () => {
    const p = parseStatementFigures('002', FORM2)!;
    const f = byKey(p.figures);
    expect(p.period_name).toBe('Рік 2025');
    expect(f.net_revenue).toMatchObject({ line: '2000', current: 43805245, prior: 36639345 });
    expect(f.gross_profit).toMatchObject({ line: '2090/2095', current: 24239249, prior: 20605430 });
    // gross profit = revenue − cost of sales (2050)
    expect(f.net_revenue.current - 19565996).toBe(f.gross_profit.current);
    expect(f.profit_before_tax).toMatchObject({ current: 15267281, prior: 13950576 });
    expect(f.net_profit).toMatchObject({ line: '2350/2355', current: 12307536, prior: 11331462 });
    expect(p.balance_check).toBeUndefined();
  });

  it('Форма 2: a loss (2355, filed positive in brackets) comes out negative', () => {
    const xml = '<DECLARBODY><A2000>100</A2000><A2095>30</A2095><A2355>45</A2355><B2090>10</B2090><B2350>5</B2350></DECLARBODY>';
    const f = byKey(parseStatementFigures('002', xml)!.figures);
    expect(f.gross_profit).toMatchObject({ current: -30, prior: 10 });
    expect(f.net_profit).toMatchObject({ current: -45, prior: 5 });
  });

  it('1-м/2-м (мале): balance A_4 current / A_3 prior, results B_3 current / B_4 prior, signed 2350', () => {
    const p = parseStatementFigures('100', SMALL)!;
    const f = byKey(p.figures);
    expect(p.form_name).toContain('малого підприємства');
    expect(f.total_assets).toMatchObject({ current: 14358.6, prior: 14274.6 });
    expect(f.equity).toMatchObject({ current: -70269.7, prior: -69586.1 });
    expect(f.long_term_liabilities).toMatchObject({ current: 82323.3, prior: 81555.7 });
    expect(f.current_liabilities).toMatchObject({ current: 2305, prior: 2305 });
    expect(Math.round((f.equity.current + f.long_term_liabilities.current + f.current_liabilities.current) * 10) / 10).toBe(f.total_assets.current);
    expect(p.balance_check).toBe(true);
    expect(f.net_revenue).toMatchObject({ line: '2000', current: 1346.5, prior: 1286.8 });
    expect(f.net_profit).toMatchObject({ line: '2350', current: -683.6, prior: -8001.3 });
    expect(f.gross_profit).toBeUndefined();
    expect(p.columns.income).toEqual({ current: 'за звітний період', prior: 'за попередній період' });
  });

  it('1-мс/2-мс (мікро): same tag scheme as 1-м', () => {
    const p = parseStatementFigures('110', MICRO)!;
    const f = byKey(p.figures);
    expect(p.form_name).toContain('мікропідприємства');
    expect(f.total_assets).toMatchObject({ current: 416.9, prior: 46.7 });
    expect(f.equity).toMatchObject({ current: 410, prior: 1.4 });
    expect(f.current_liabilities).toMatchObject({ current: 6.9, prior: 45.3 });
    expect(f.long_term_liabilities).toMatchObject({ current: null, prior: 0 });
    expect(f.net_revenue).toMatchObject({ current: 866.7, prior: 885.7 });
    expect(f.profit_before_tax).toMatchObject({ current: 10.5, prior: 3.6 });
    expect(f.net_profit).toMatchObject({ current: 8.6, prior: 3 });
    expect(p.balance_check).toBe(true);
  });

  it('forms without key figures and nil-only filings', () => {
    expect(parseStatementFigures('003', FORM1)).toBeNull();
    expect(parseStatementFigures('040', '<A4000>1</A4000>')).toBeNull();
    expect(parseStatementFigures('001', null)).toBeNull();
    const empty = parseStatementFigures('110', '<DECLARBODY><A1300_3 xsi:nil="true" /><B2000_3 xsi:nil="true"></B2000_3></DECLARBODY>')!;
    expect(empty.figures).toEqual([]);
  });

  it('readTags skips nil and empty values and reads decimals', () => {
    const t = readTags('<A1300_4>1.4</A1300_4><A1300_3 xsi:nil="true" /><B1300></B1300><A1495>-6 858</A1495>');
    expect(t.get('A1300_4')).toBe(1.4);
    expect(t.has('A1300_3')).toBe(false);
    expect(t.has('B1300')).toBe(false);
    expect(t.get('A1495')).toBe(-6858);
  });
});

const row = (sub: string, form: string, xml: string | null, year = 2025, month = 12) => ({
  tin: '21673832', c_doc: 'S01', c_doc_sub: sub, period_year: year, period_month: month, form_type: form, raw_xml: xml,
});

describe('financialStatementRow / latestFigures', () => {
  it('drops raw_xml and adds labelled figures', () => {
    const r = financialStatementRow(row('001', 'S0100115', FORM1));
    expect(r.raw_xml).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('DECLAR');
    expect(r.period).toBe('рік 2025');
    expect(r.figures.length).toBeGreaterThan(0);
    const other = financialStatementRow(row('040', 'S0104010', null));
    expect(other.raw_xml).toBeUndefined();
    expect(other.figures).toBeUndefined();
    expect(other.form_name).toContain('власний капітал');
  });

  it('merges balance and results of the latest annual period, ignoring a newer interim one', () => {
    const rows = [
      row('001', 'S0100115', FORM1, 2026, 3),
      row('001', 'S0100115', FORM1),
      row('002', 'S0100215', FORM2),
      row('001', 'S0100114', FORM1, 2024),
    ].map(financialStatementRow);
    const l = latestFigures(rows)!;
    expect(l.period).toBe('рік 2025');
    expect(l.forms).toHaveLength(2);
    const f = byKey(l.figures);
    expect(f.total_assets.current).toBe(84939977);
    expect(f.net_profit.current).toBe(12307536);
    expect(l.columns.balance && l.columns.income).toBeTruthy();
    expect(latestFigures([financialStatementRow(row('040', 'S0104010', null))])).toBeNull();
  });
});

describe('search_registry financial_statements', () => {
  it('selects raw_xml only for figure forms and never returns it', async () => {
    const sqls: string[] = [];
    const db = {
      query: async (sql: string) => {
        sqls.push(sql);
        if (sql.includes('COUNT(*)')) return { rows: [{ total: '2' }] };
        return { rows: [row('001', 'S0100115', FORM1), row('002', 'S0100215', FORM2)] };
      },
    };
    const res = await new RegistrySearchTool(db).executeTool('search_registry', { registry: 'financial_statements', filters: { tin: '21673832' } });
    const text = res!.content[0].text as string;
    expect(text).not.toContain('DECLAR');
    const body = JSON.parse(text);
    expect(body.results).toHaveLength(2);
    expect(byKey(body.results[1].figures).net_revenue.current).toBe(43805245);
    expect(sqls[0]).toMatch(/CASE WHEN c_doc_sub IN \('001', '002', '100', '110'\) AND NOT EXISTS \(SELECT 1 FROM financial_figures f /);
    expect(sqls[0]).toContain('AS stored_figures');
    expect(sqls[0]).toContain('period_month DESC');
  });
});

describe('get_company_dossier financial_statements', () => {
  it('shows latest-year figures with source, period and a fact', async () => {
    const ok = (data: any) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
    const results = [row('001', 'S0100115', FORM1), row('002', 'S0100215', FORM2)].map(financialStatementRow);
    const reg = {
      executeTool: async (name: string, args: any) => {
        if (name === 'get_financial_statements' && args.edrpou === '21673832') return ok({ results, total_count: 2 });
        if (name === 'openreyestr_get_by_edrpou') return ok({ edrpou: '21673832', name: 'ПрАТ «Київстар»', stan: 'зареєстровано' });
        return ok([]);
      },
    };
    const res = await new CompanyDossierTool(reg).executeTool('get_company_dossier', { edrpou: '21673832' });
    const d = JSON.parse(res!.content[0].text);
    const s = d.sections.financial_statements;
    expect(s.status).toBe('found');
    expect(s.items[0]).not.toHaveProperty('figures');
    expect(s.latest.period).toBe('рік 2025');
    expect(s.latest.source).toContain('Форма № 1');
    expect(s.latest.source).toContain('за рік 2025');
    expect(byKey(s.latest.figures).equity.current).toBe(56315286);
    const fact = d.facts.find((f: any) => f.section === 'financial_statements' && f.fact.startsWith('Фінансова звітність за'));
    expect(fact.fact).toContain('тис. грн');
    expect(fact.fact).toContain('84');
  });
});
