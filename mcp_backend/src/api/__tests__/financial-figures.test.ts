/**
 * Normalized financial figures (financial_figures, migration 278): cell extraction per
 * form, summary amounts, the later-filing-wins rule, the ДПС 2020 CSV path and
 * get_financial_statements. All fixtures are synthetic (made-up codes and names).
 */
import {
  cellsFromGraphs, cellsFromTags, dedupeFigureRows, figureRowFromFiling, financialStatementRow, keyAmounts,
  newerFiling, normalizeEdrpou, parseStatementFigures, readHeader, readTags, statementFromStored,
} from '../tools/financial-statement-figures.js';
import { buildFinancialStatements, FinancialStatementsTool } from '../tools/financial-statements-tool.js';
import { csvNumber, csvRecords, dmyDots, dpsRow } from '../../services/dps2020-financial-csv.js';
import { UPSERT_SQL, statementTimeoutLiteral, upsertFigureRows } from '../../services/financial-figures-store.js';

const head = (sub: string, extra = '') => `<DECLARHEAD><TIN>1234</TIN><C_DOC>S01</C_DOC><C_DOC_SUB>${sub}</C_DOC_SUB>`
  + `<PERIOD_MONTH>12</PERIOD_MONTH><PERIOD_TYPE>5</PERIOD_TYPE><PERIOD_YEAR>2024</PERIOD_YEAR><D_FILL>20022025</D_FILL>${extra}</DECLARHEAD>`;
const doc = (sub: string, body: string, extra = '') => `<?xml version="1.0" encoding="UTF-8"?><DECLAR>${head(sub, extra)}<DECLARBODY>`
  + `<FIRM_EDRPOU>00001234</FIRM_EDRPOU><FIRM_NAME>ТОВ &quot;ТЕСТОВА КОМПАНІЯ&quot;</FIRM_NAME><FIRM_KVED>62.01</FIRM_KVED>`
  + `<MY_DATE>31122024</MY_DATE><REP_PERNM>Рік 2024</REP_PERNM>${body}</DECLARBODY></DECLAR>`;

// Форма 1: A = start of period, B = end. 1300 = 1900 = 1495 + 1595 + 1695.
const FORM1 = doc('001', '<A1095>40</A1095><B1095>50</B1095><A1195>60</A1195><B1195>70</B1195>'
  + '<A1300>100</A1300><B1300>120</B1300><A1495>30</A1495><B1495>45</B1495><A1595>20</A1595><B1595>25</B1595>'
  + '<A1695>50</A1695><B1695>50</B1695><A1900>100</A1900><B1900>120</B1900><B1000 xsi:nil="true"/>');
// Форма 2: A = reporting period, B = last year; a loss in 2355 is filed positive.
const FORM2 = doc('002', '<A2000>500</A2000><B2000>400</B2000><A2090>80</A2090><B2095>10</B2095>'
  + '<A2290>30</A2290><B2295>12</B2295><A2350>25</A2350><B2355>12</B2355>');
// 1-м: balance A_3 start / A_4 end, results B_3 current / B_4 prior, signed 2350.
const SMALL = doc('100', '<A1300_3>10.5</A1300_3><A1300_4>12.5</A1300_4><A1495_3>-3</A1495_3><A1495_4>-4.5</A1495_4>'
  + '<A1595_4>10</A1595_4><A1695_4>7</A1695_4><A1900_3>10.5</A1900_3><A1900_4>12.5</A1900_4>'
  + '<B2000_3>80.4</B2000_3><B2000_4>70</B2000_4><B2290_3>-1.5</B2290_3><B2350_3>-1.5</B2350_3><B2350_4>2</B2350_4>'
  // stray shapes that the form does not define: ignored
  + '<A2000_3>999</A2000_3><B1300_4>999</B1300_4><A1300>999</A1300>');
// 1-мс: same scheme as 1-м.
const MICRO = doc('110', '<A1300_3>1</A1300_3><A1300_4>2</A1300_4><A1495_4>1.2</A1495_4><A1900_4>2</A1900_4>'
  + '<B2000_3>5</B2000_3><B2000_4>4</B2000_4><B2350_3>0.3</B2350_3>');

const filing = (id: number, sub: string, xml: string, tin = '1234', year = 2024, month = 12) =>
  ({ id, tin, c_doc_sub: sub, period_year: year, period_month: month, raw_xml: xml });

describe('cellsFromTags', () => {
  it('Форма 1: B → cur, A → prev; nil skipped', () => {
    const c = cellsFromTags('001', readTags(FORM1));
    expect(c.cur['1300']).toBe(120);
    expect(c.prev['1300']).toBe(100);
    expect(c.cur).not.toHaveProperty('1000');
  });
  it('Форма 2: A → cur, B → prev', () => {
    const c = cellsFromTags('002', readTags(FORM2));
    expect(c.cur).toMatchObject({ '2000': 500, '2090': 80, '2290': 30, '2350': 25 });
    expect(c.prev).toMatchObject({ '2000': 400, '2095': 10, '2295': 12, '2355': 12 });
  });
  it('1-м: A_4 / B_3 → cur, A_3 / B_4 → prev, stray tags ignored', () => {
    const c = cellsFromTags('100', readTags(SMALL));
    expect(c.cur).toMatchObject({ '1300': 12.5, '1495': -4.5, '2000': 80.4, '2350': -1.5 });
    expect(c.prev).toMatchObject({ '1300': 10.5, '1495': -3, '2000': 70, '2350': 2 });
    expect(Object.values(c.cur)).not.toContain(999);
    expect(Object.values(c.prev)).not.toContain(999);
  });
  it('1-мс: same scheme', () => {
    const c = cellsFromTags('110', readTags(MICRO));
    expect(c.cur).toMatchObject({ '1300': 2, '2000': 5, '2350': 0.3 });
    expect(c.prev).toMatchObject({ '1300': 1, '2000': 4 });
  });
  it('the refactored parser gives the same figures as the stored cells', () => {
    for (const [sub, xml] of [['001', FORM1], ['002', FORM2], ['100', SMALL], ['110', MICRO]]) {
      const parsed = parseStatementFigures(sub, xml)!;
      const cells = cellsFromTags(sub, readTags(xml));
      const stored = statementFromStored(sub, { ...cells, report_date: parsed.report_date, period_name: parsed.period_name })!;
      expect(stored).toEqual(parsed);
    }
  });
});

describe('keyAmounts', () => {
  it('Форма 1: assets, equity, liabilities = 1900 − 1495; no income side', () => {
    expect(keyAmounts(cellsFromTags('001', readTags(FORM1)))).toEqual({ assets: 120, equity: 45, liabilities: 75, revenue: null, net_profit: null });
  });
  it('Форма 2: revenue, net profit = 2350 − 2355; no balance side', () => {
    const k = keyAmounts(cellsFromTags('002', readTags(FORM2)));
    expect(k).toEqual({ assets: null, equity: null, liabilities: null, revenue: 500, net_profit: 25 });
    const loss = keyAmounts({ cur: { '2000': 1, '2355': 7 }, prev: {} });
    expect(loss.net_profit).toBe(-7);
  });
  it('1-м: both sides from one filing, negative equity, decimals kept', () => {
    expect(keyAmounts(cellsFromTags('100', readTags(SMALL)))).toEqual({ assets: 12.5, equity: -4.5, liabilities: 17, revenue: 80.4, net_profit: -1.5 });
  });
  it('assets fall back to 1900; an empty line on a filed side is zero', () => {
    expect(keyAmounts({ cur: { '1900': 9, '2350': 1 }, prev: {} })).toEqual({ assets: 9, equity: 0, liabilities: 9, revenue: 0, net_profit: 1 });
  });
});

describe('figureRowFromFiling', () => {
  it('reads the header and pads the code', () => {
    const r = figureRowFromFiling(filing(7, '001', FORM1))!;
    expect(r).toMatchObject({
      edrpou: '00001234', year: 2024, period: 12, form: '1', source: 'dssu', name: 'ТОВ "ТЕСТОВА КОМПАНІЯ"', kved: '62.01',
      filed_on: '2025-02-20', report_date: '2024-12-31', period_name: 'Рік 2024', doc_stan: null,
      assets: 120, source_id: 7, source_ref: 'opendata_financial_statements:7',
    });
    expect(figureRowFromFiling(filing(8, '100', SMALL))!.form).toBe('1-m');
    expect(figureRowFromFiling(filing(9, '110', MICRO))!.form).toBe('1-ms');
  });
  it('skips personal tax numbers, other forms, nil-only filings and unknown periods', () => {
    expect(figureRowFromFiling(filing(1, '001', FORM1, '1234567890'))).toBeNull();
    expect(figureRowFromFiling(filing(1, '040', FORM1))).toBeNull();
    expect(figureRowFromFiling(filing(1, '110', doc('110', '<A1300_3 xsi:nil="true"/>')))).toBeNull();
    expect(figureRowFromFiling(filing(1, '001', FORM1, '1234', 2024, 0))).toBeNull();
  });
  it('reads C_DOC_STAN when present', () => {
    expect(readHeader(doc('001', '', '<C_DOC_STAN>3</C_DOC_STAN>')).doc_stan).toBe(3);
  });
  it('normalizeEdrpou', () => {
    expect(normalizeEdrpou('376372')).toBe('00376372');
    expect(normalizeEdrpou(' 12345678 ')).toBe('12345678');
    expect(normalizeEdrpou('123456789')).toBeNull();
    expect(normalizeEdrpou('12a4')).toBeNull();
  });
});

describe('corrected reports: the later filing wins', () => {
  const original = figureRowFromFiling(filing(10, '001', FORM1))!;
  const corrected = figureRowFromFiling(filing(5, '001',
    FORM1.replace('<D_FILL>20022025</D_FILL>', '<D_FILL>15042025</D_FILL>').replace('<B1300>120</B1300>', '<B1300>130</B1300>')))!;
  const restated = figureRowFromFiling(filing(4, '001', FORM1.replace('</D_FILL>', '</D_FILL><C_DOC_STAN>3</C_DOC_STAN>')))!;

  it('a later D_FILL beats a higher id', () => {
    expect(newerFiling(corrected, original)).toBe(true);
    const [kept] = dedupeFigureRows([original, corrected]);
    expect(kept.assets).toBe(130);
    expect(dedupeFigureRows([corrected, original])[0].assets).toBe(130);
  });
  it('same date: a correction (C_DOC_STAN 3) beats the original; then the newer import', () => {
    expect(newerFiling(restated, original)).toBe(true);
    expect(newerFiling(original, { ...original, source_id: 3 })).toBe(true);
    expect(dedupeFigureRows([original, restated, corrected])).toHaveLength(1);
  });
  it('different periods and forms are kept apart', () => {
    const q3 = figureRowFromFiling(filing(11, '001', FORM1, '1234', 2024, 9))!;
    const f2 = figureRowFromFiling(filing(12, '002', FORM2))!;
    expect(dedupeFigureRows([original, q3, f2])).toHaveLength(3);
  });
  it('the upsert applies the same order against the table', async () => {
    expect(UPSERT_SQL).toMatch(/ON CONFLICT \(edrpou, year, period, form, source\) DO UPDATE/);
    expect(UPSERT_SQL).toMatch(/WHERE \(COALESCE\(EXCLUDED\.filed_on.*>= \(COALESCE\(financial_figures\.filed_on/s);
    const calls: any[] = [];
    const n = await upsertFigureRows({ query: async (sql, params) => { calls.push(params); return { rows: [], rowCount: 1 }; } }, [original, corrected]);
    expect(n).toBe(1);
    const sent = JSON.parse(calls[0][0]);
    expect(sent).toHaveLength(1);
    expect(sent[0].assets).toBe(130);
    expect(await upsertFigureRows({ query: async () => { throw new Error('no call expected'); } }, [])).toBe(0);
  });
  it('statement timeout literal is validated', () => {
    expect(statementTimeoutLiteral('120s')).toBe('120s');
    expect(() => statementTimeoutLiteral("1'; DROP TABLE x; --")).toThrow();
  });
});

describe('ДПС 2020 CSV', () => {
  it('cellsFromGraphs: graph 3 = start (balance) / reporting year (income)', () => {
    const c = cellsFromGraphs([['1300', 3, 10], ['1300', 4, 12], ['2000', 3, 50], ['2000', 4, 40]]);
    expect(c).toEqual({ cur: { '1300': 12, '2000': 50 }, prev: { '1300': 10, '2000': 40 } });
  });
  it('parses quoted fields, decimal commas, null and zero', () => {
    const text = '﻿TIN;FULL_NAME;FORM_CODE;PERIOD_MONTH;PERIOD_YEAR;D_GET;R1300G3;R1300G4;R1495G4;R1900G4;R2000G3;R2350G3\r\n'
      + '1234;"ТОВ ""ТЕСТ; СЕРВІС""";"S0111005";12;2020;"24.02.2021";1,5;2 000,5;0;2000,5;null;-3,25\r\n'
      + '1234567890;"ФОП";"S0111005";12;2020;"24.02.2021";1;1;1;1;1;1\r\n';
    const recs = [...csvRecords(text.replace(/^﻿/, ''))];
    expect(recs).toHaveLength(3);
    expect(recs[1][1]).toBe('ТОВ "ТЕСТ; СЕРВІС"');
    const header = recs[0].map((h) => h.trim().toUpperCase());
    const row = dpsRow(header, recs[1], '1-ms', 'pokaznyk.zip/J0901205.csv')!;
    expect(row).toMatchObject({
      edrpou: '00001234', year: 2020, period: 12, form: '1-ms', source: 'dps2020', name: 'ТОВ "ТЕСТ; СЕРВІС"',
      filed_on: '2021-02-24', source_id: null, assets: 2000.5, equity: 0, liabilities: 2000.5, revenue: 0, net_profit: -3.25,
    });
    expect(row.cur).toEqual({ '1300': 2000.5, '1900': 2000.5, '2350': -3.25 });
    expect(row.prev).toEqual({ '1300': 1.5 });
    expect(dpsRow(header, recs[2], '1-ms', 'x')).toBeNull();
  });
  it('helpers', () => {
    expect(csvNumber(' 1 234,5 ')).toBe(1234.5);
    expect(csvNumber('null')).toBeUndefined();
    expect(csvNumber('0')).toBeUndefined();
    expect(dmyDots('01.03.2021')).toBe('2021-03-01');
    expect(dmyDots('2021-03-01')).toBeNull();
  });
});

describe('search_registry row with stored figures', () => {
  it('uses stored cells and never parses or returns XML', () => {
    const cells = cellsFromTags('001', readTags(FORM1));
    const r = financialStatementRow({
      tin: '1234', c_doc_sub: '001', period_year: 2024, period_month: 12, form_type: 'S0100115', raw_xml: null,
      stored_figures: { ...cells, report_date: '2024-12-31', period_name: 'Рік 2024' },
    });
    expect(r.stored_figures).toBeUndefined();
    expect(r.raw_xml).toBeUndefined();
    expect(r.report_date).toBe('2024-12-31');
    expect(r.figures.find((f: any) => f.key === 'total_assets')).toMatchObject({ current: 120, prior: 100 });
  });
});

/** Fake DB: financial_figures rows as the tool's SELECT returns them, plus raw filings. */
function fakeDb(stored: any[], raw: any[]) {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM financial_figures\n')) return { rows: stored };
      if (sql.includes('FROM opendata_financial_statements o')) return { rows: raw };
      return { rows: [] };
    },
  };
}

const dbRow = (r: any) => ({ ...r, assets: r.assets === null ? null : String(r.assets), revenue: r.revenue === null ? null : String(r.revenue) });

describe('get_financial_statements', () => {
  const f1 = figureRowFromFiling(filing(1, '001', FORM1))!;
  const f2 = figureRowFromFiling(filing(2, '002', FORM2))!;
  const small23 = figureRowFromFiling(filing(3, '100', SMALL, '1234', 2023))!;
  const q1 = figureRowFromFiling(filing(4, '001', FORM1, '1234', 2025, 3))!;

  it('per-year key figures with source and filing date, annual only by default', async () => {
    const tool = new FinancialStatementsTool(fakeDb([f1, f2, small23, q1].map(dbRow), []));
    const res = await tool.executeTool('get_financial_statements', { edrpou: '1234' });
    const body = JSON.parse(res!.content[0].text);
    expect(body.edrpou).toBe('00001234');
    expect(body.units).toBe('тис. грн');
    expect(body.note).toContain('тис. грн');
    expect(body.name).toBe('ТОВ "ТЕСТОВА КОМПАНІЯ"');
    // 2025 has only an interim (Q1) period: kept as that year's latest; 2024 and 2023 annual.
    expect(body.periods.map((p: any) => p.period)).toEqual(['I квартал 2025', 'рік 2024', 'рік 2023']);
    const y24 = body.periods[1];
    const k = Object.fromEntries(y24.key_figures.map((x: any) => [x.key, x]));
    expect(k.assets).toMatchObject({ label: 'Активи', value: 120 });
    expect(k.liabilities.value).toBe(75);
    expect(k.revenue.value).toBe(500);
    expect(k.net_profit).toMatchObject({ label: 'Чистий прибуток (збиток)', value: 25 });
    expect(y24.filed_on).toBe('2025-02-20');
    expect(y24.sources[0]).toContain('data.gov.ua');
    const st = body.results.find((s: any) => s.period_year === 2024 && s.form === '1');
    expect(st).toMatchObject({ source: 'dssu', filed_on: '2025-02-20', c_doc_sub: '001', units: 'тис. грн' });
    expect(st.figures.length).toBeGreaterThan(0);
    expect(body.parsed_on_the_fly).toBeUndefined();
  });

  it('include_interim adds quarters; year range is passed to SQL', async () => {
    const db = fakeDb([f1, q1].map(dbRow), []);
    const tool = new FinancialStatementsTool(db);
    const body = JSON.parse((await tool.executeTool('get_financial_statements', { edrpou: '00001234', include_interim: true, year_from: 2024 }))!.content[0].text);
    expect(body.periods.map((p: any) => p.period)).toEqual(['I квартал 2025', 'рік 2024']);
    expect(db.calls[0]).toContain('year BETWEEN $2 AND $3');
  });

  it('falls back to parsing filings not normalized yet', async () => {
    const tool = new FinancialStatementsTool(fakeDb([], [filing(1, '001', FORM1), filing(2, '002', FORM2)]));
    const body = JSON.parse((await tool.executeTool('get_financial_statements', { edrpou: '1234' }))!.content[0].text);
    expect(body.parsed_on_the_fly).toBe(true);
    expect(body.periods[0].key_figures.map((x: any) => x.key)).toEqual(['assets', 'equity', 'liabilities', 'revenue', 'net_profit']);
  });

  it('prefers the full forms; dps2020 rows carry their own source', () => {
    const dps = { ...f1, year: 2020, source: 'dps2020' as const, source_id: null, assets: 7 };
    const out = buildFinancialStatements('00001234', [f1, { ...small23, year: 2024 }, f2, dps], false, false);
    const y24 = out.periods.find((p) => p.year === 2024)!;
    expect(y24.key_figures.find((x) => x.key === 'assets')!.form).toContain('Форма № 1');
    expect(y24.key_figures.find((x) => x.key === 'revenue')!.form).toContain('Форма № 2');
    const y20 = out.periods.find((p) => p.year === 2020)!;
    expect(y20.sources[0]).toContain('2020');
  });

  it('rejects personal tax numbers and empty input; reports nothing found', async () => {
    const tool = new FinancialStatementsTool(fakeDb([], []));
    expect((await tool.executeTool('get_financial_statements', { edrpou: '1234567890' }))!.content[0].text).toContain('РНОКПП');
    expect((await tool.executeTool('get_financial_statements', {}))!.content[0].text).toContain('ЄДРПОУ');
    const none = JSON.parse((await tool.executeTool('get_financial_statements', { edrpou: '1234' }))!.content[0].text);
    expect(none.results).toEqual([]);
    expect(none.message).toContain('не знайдено');
    expect(await tool.executeTool('other_tool', {})).toBeNull();
  });
});
