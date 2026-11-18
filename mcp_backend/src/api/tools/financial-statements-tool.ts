/**
 * get_financial_statements: key figures of a company's financial statements by ЄДРПОУ,
 * year by year, from financial_figures (migration 278).
 *
 * Sources: Держстат/ДПС open data (data.gov.ua, filings for 2021 onwards, source
 * 'dssu') and the ДПС set for 2020 (source 'dps2020'). Filings of a company not yet
 * normalized into financial_figures are parsed on the fly from
 * opendata_financial_statements.raw_xml, so the answer never depends on the backfill
 * having reached the company.
 *
 * Every statement carries its source and filing date; amounts are in тис. грн as filed.
 */
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import {
  figureRowFromFiling, FinancialFigureRow, FIGURE_FORMS, FORM_NAMES, FormKey, KeyAmounts, normalizeEdrpou,
  periodLabel, statementFromStored, SUB_BY_FORM, UNITS, dedupeFigureRows,
} from './financial-statement-figures.js';

export const SOURCE_NAMES: Record<string, string> = {
  dssu: 'Фінансова звітність підприємств (Держстат, ДПС; data.gov.ua)',
  dps2020: 'Фінансова звітність за 2020 рік, подана разом із податковою звітністю (ДПС; data.gov.ua)',
  smida: 'Звітність емітентів (НКЦПФР, SMIDA)',
};

export const NOTE =
  'Усі суми в тисячах гривень (тис. грн), як у поданій звітності. current — звітний період (баланс на його кінець, '
  + 'фінрезультат за період), prior — порівняльна графа форми (див. columns). Ключові показники періоду: активи (р. 1300), '
  + 'власний капітал (р. 1495), зобов’язання і забезпечення (р. 1900 мінус р. 1495), чистий дохід (р. 2000), '
  + 'чистий прибуток або збиток (р. 2350 мінус р. 2355). Якщо компанія подавала звіт повторно, показано пізніший.';

const KEY_LABELS: Record<keyof KeyAmounts, string> = {
  assets: 'Активи',
  equity: 'Власний капітал',
  liabilities: 'Зобов’язання і забезпечення',
  revenue: 'Чистий дохід від реалізації',
  net_profit: 'Чистий прибуток (збиток)',
};

/** Which form a period's balance / income figures are taken from, best first. */
const BALANCE_PREF: FormKey[] = ['1', '1-m', '1-ms'];
const INCOME_PREF: FormKey[] = ['2', '1-m', '1-ms'];
const SOURCE_PREF = ['dssu', 'dps2020', 'smida'];

const MAX_STATEMENTS = 200;

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/** A row of the DB query → FinancialFigureRow with numbers and ISO dates. */
export function fromDb(r: any): FinancialFigureRow {
  return {
    edrpou: r.edrpou, year: Number(r.year), period: Number(r.period), form: r.form, source: r.source,
    name: r.name ?? null, kved: r.kved ?? null, filed_on: r.filed_on ?? null, doc_stan: num(r.doc_stan),
    report_date: r.report_date ?? null, period_name: r.period_name ?? null,
    cur: r.cur ?? {}, prev: r.prev ?? null,
    assets: num(r.assets), equity: num(r.equity), liabilities: num(r.liabilities), revenue: num(r.revenue), net_profit: num(r.net_profit),
    source_ref: r.source_ref ?? '', source_id: num(r.source_id),
  };
}

/** One statement in the tool output (also the shape financialStatementRow gives, so latestFigures reads it). */
export function statementView(r: FinancialFigureRow): any {
  const sub = SUB_BY_FORM[r.form];
  const parsed = statementFromStored(sub, { cur: r.cur, prev: r.prev, report_date: r.report_date, period_name: r.period_name });
  return {
    period: periodLabel(r.year, r.period),
    period_year: r.year,
    period_month: r.period,
    form: r.form,
    c_doc_sub: sub,
    form_name: FORM_NAMES[sub],
    source: r.source,
    source_name: SOURCE_NAMES[r.source] ?? r.source,
    filed_on: r.filed_on,
    report_date: r.report_date,
    units: UNITS,
    columns: parsed?.columns ?? {},
    figures: parsed?.figures ?? [],
    ...(parsed?.balance_check !== undefined ? { balance_check: parsed.balance_check } : {}),
  };
}

function pick(rows: FinancialFigureRow[], forms: FormKey[], has: (r: FinancialFigureRow) => boolean): FinancialFigureRow | null {
  const sorted = rows
    .filter((r) => forms.includes(r.form) && has(r))
    .sort((a, b) => SOURCE_PREF.indexOf(a.source) - SOURCE_PREF.indexOf(b.source) || forms.indexOf(a.form) - forms.indexOf(b.form));
  return sorted[0] ?? null;
}

/** Key figures of one period, balance and income each from the best form filed. */
export function periodSummary(rows: FinancialFigureRow[]) {
  const bal = pick(rows, BALANCE_PREF, (r) => r.assets !== null);
  const inc = pick(rows, INCOME_PREF, (r) => r.revenue !== null || r.net_profit !== null);
  const key_figures: Array<{ key: keyof KeyAmounts; label: string; value: number; form: string; source: string }> = [];
  const add = (k: keyof KeyAmounts, r: FinancialFigureRow | null) => {
    if (r && r[k] !== null) key_figures.push({ key: k, label: KEY_LABELS[k], value: r[k] as number, form: FORM_NAMES[SUB_BY_FORM[r.form]], source: r.source });
  };
  add('assets', bal); add('equity', bal); add('liabilities', bal);
  add('revenue', inc); add('net_profit', inc);
  const first = rows[0];
  return {
    year: first.year,
    period_month: first.period,
    period: periodLabel(first.year, first.period),
    key_figures,
    filed_on: rows.map((r) => r.filed_on).filter(Boolean).sort().pop() ?? null,
    sources: [...new Set(rows.map((r) => r.source))].map((s) => SOURCE_NAMES[s] ?? s),
  };
}

/**
 * Build the tool output from rows of one company. Annual periods only, unless
 * include_interim; a year with no annual statement keeps its latest interim one.
 */
export function buildFinancialStatements(edrpou: string, rows: FinancialFigureRow[], includeInterim: boolean, fallback: boolean) {
  const byPeriod = new Map<string, FinancialFigureRow[]>();
  for (const r of rows) {
    const k = `${r.year}|${r.period}`;
    if (!byPeriod.has(k)) byPeriod.set(k, []);
    byPeriod.get(k)!.push(r);
  }
  const keys = [...byPeriod.keys()].sort((a, b) => {
    const [ya, pa] = a.split('|').map(Number);
    const [yb, pb] = b.split('|').map(Number);
    return yb - ya || pb - pa;
  });
  const keep = keys.filter((k) => {
    if (includeInterim) return true;
    const [y, p] = k.split('|').map(Number);
    if (p === 12) return true;
    // Interim kept only as the latest period of a year without an annual statement.
    return !byPeriod.has(`${y}|12`) && keys.find((x) => Number(x.split('|')[0]) === y) === k;
  });
  const periods = keep.map((k) => periodSummary(byPeriod.get(k)!));
  const statements = keep.flatMap((k) => byPeriod.get(k)!
    .sort((a, b) => a.form.localeCompare(b.form) || SOURCE_PREF.indexOf(a.source) - SOURCE_PREF.indexOf(b.source))
    .map(statementView));
  const name = rows.slice().sort((a, b) => b.year - a.year || b.period - a.period).find((r) => r.name)?.name ?? null;
  return {
    edrpou,
    name,
    units: UNITS,
    note: NOTE,
    periods,
    results: statements.slice(0, MAX_STATEMENTS),
    total_count: statements.length,
    ...(fallback ? { parsed_on_the_fly: true } : {}),
  };
}

export class FinancialStatementsTool extends BaseToolHandler {
  constructor(private db: { query(sql: string, params?: any[]): Promise<{ rows: any[] }> }) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [{
      name: 'get_financial_statements',
      annotations: { title: 'Фінансова звітність за ЄДРПОУ', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: `Фінансова звітність підприємства за кодом ЄДРПОУ: ключові показники балансу (Форма 1) і звіту про фінансові результати (Форма 2) за роками, а також форм малого (1-м/2-м) і мікропідприємства (1-мс/2-мс).

Джерела: відкриті дані Держстату й ДПС на data.gov.ua (звітність за 2021 рік і пізніше; за 2020 рік — показники, подані разом із податковою звітністю). На кожен звіт — джерело й дата подання.

Для кожного року: активи (р. 1300), власний капітал (р. 1495), зобов’язання і забезпечення (р. 1900 мінус 1495), чистий дохід (р. 2000), чистий прибуток або збиток (р. 2350/2355), а також показники кожної поданої форми з порівняльною графою. Суми в тис. грн. Типово лише річна звітність; include_interim=true додає квартальну.`,
      inputSchema: {
        type: 'object',
        properties: {
          edrpou: { type: 'string', description: 'Код ЄДРПОУ (до 8 цифр)' },
          year_from: { type: 'number', description: 'Звітний рік від (включно)' },
          year_to: { type: 'number', description: 'Звітний рік до (включно)' },
          include_interim: { type: 'boolean', default: false, description: 'Додати квартальну звітність (I квартал, півріччя, 9 місяців)' },
        },
        required: ['edrpou'],
      },
    }];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'get_financial_statements') return null;
    const raw = String(args?.edrpou ?? '').trim();
    if (/^\d{9,}$/.test(raw)) {
      return this.wrapResponse('Звітність фізичних осіб-підприємців (РНОКПП) не обробляється. Вкажіть код ЄДРПОУ юридичної особи (до 8 цифр).');
    }
    const edrpou = normalizeEdrpou(raw);
    if (!edrpou) return this.wrapResponse('Вкажіть edrpou — код ЄДРПОУ юридичної особи (до 8 цифр).');
    const yearFrom = Number.isFinite(Number(args?.year_from)) && args?.year_from != null ? Math.trunc(Number(args.year_from)) : 1990;
    const yearTo = Number.isFinite(Number(args?.year_to)) && args?.year_to != null ? Math.trunc(Number(args.year_to)) : 2100;
    const includeInterim = args?.include_interim === true || args?.include_interim === 'true';

    try {
      const stored = await this.db.query(
        `SELECT edrpou, year, period, form, source, name, kved, to_char(filed_on, 'YYYY-MM-DD') AS filed_on, doc_stan,
                to_char(report_date, 'YYYY-MM-DD') AS report_date, period_name, cur, prev,
                assets, equity, liabilities, revenue, net_profit, source_ref, source_id
         FROM financial_figures
         WHERE edrpou = $1 AND year BETWEEN $2 AND $3
         ORDER BY year DESC, period DESC, form, source`,
        [edrpou, yearFrom, yearTo],
      );
      let rows = stored.rows.map(fromDb);
      let fallback = false;
      // Filings not normalized yet (new imports, a backfill still running): parse their
      // XML with the backfill's parser and let the later filing win, as the backfill would.
      const filings = await this.db.query(
        `SELECT o.id, o.tin, o.c_doc_sub, o.period_year, o.period_month, o.raw_xml
         FROM opendata_financial_statements o
         WHERE o.tin = ANY($1) AND o.c_doc_sub = ANY($2) AND o.period_year BETWEEN $3 AND $4
           AND NOT EXISTS (SELECT 1 FROM financial_figures f WHERE f.source = 'dssu' AND f.source_id = o.id)
         ORDER BY o.id
         LIMIT 500`,
        [[edrpou, edrpou.replace(/^0+(?=\d)/, '')], [...FIGURE_FORMS], yearFrom, yearTo],
      );
      const parsed = filings.rows.map((r) => figureRowFromFiling(r)).filter((r): r is FinancialFigureRow => !!r);
      if (parsed.length) {
        const merged = dedupeFigureRows([...rows, ...parsed]);
        fallback = merged.some((r) => parsed.includes(r));
        rows = merged;
      }
      if (!rows.length) {
        return this.wrapResponse({
          edrpou,
          results: [],
          total_count: 0,
          message: `Фінансової звітності для ЄДРПОУ ${edrpou}${args?.year_from != null || args?.year_to != null ? ' у заданому діапазоні років' : ''} не знайдено у відкритих даних.`,
          sources: Object.values(SOURCE_NAMES).slice(0, 2),
        });
      }
      return this.wrapResponse(buildFinancialStatements(edrpou, rows, includeInterim, fallback));
    } catch (error: any) {
      logger.error('get_financial_statements error', { error: error.message });
      return this.wrapError(`Помилка читання фінансової звітності: ${error.message}`);
    }
  }
}
