/**
 * Key figures of a Ukrainian financial statement, read from the XML filed to the
 * tax service (opendata_financial_statements.raw_xml, data.gov.ua dataset
 * "Фінансова звітність").
 *
 * Pure module, shared by the query-time path and the batch scripts: the cells of
 * Форми 1, 2, 1-м and 1-мс are normalized into financial_figures (migration 278,
 * scripts/backfill-financial-figures.ts); a filing not normalized yet is parsed on
 * the fly from its XML, which for the few rows of one company costs microseconds.
 *
 * Tag scheme. Taken from the field-structure description published with the dataset
 * (opis_strukturi-poliv-do-form-fin_zvitnosti.zip) and checked against prod filings
 * (2026-11-18, ~3.5K sampled rows: 1300 = 1900 and 1900 = 1495+1595+1695+1700(+1800)
 * hold for >98% of balances in every form, the residue being filer errors):
 *
 *   c_doc_sub 001  Форма № 1 (баланс)          A<line> = на початок звітного періоду
 *                                              B<line> = на кінець звітного періоду
 *   c_doc_sub 002  Форма № 2 (фінрезультати)   A<line> = за звітний період
 *                                              B<line> = за аналогічний період попереднього року
 *                  Збиток (2095, 2195, 2295, 2355) is filed as a positive amount in
 *                  brackets, so it is subtracted from the matching profit line.
 *   c_doc_sub 100  Ф. № 1-м / 2-м (мале підприємство)
 *   c_doc_sub 110  Ф. № 1-мс / 2-мс (мікропідприємство)
 *                  balance  A<line>_3 = на початок звітного року, A<line>_4 = на кінець звітного періоду
 *                  results  B<line>_3 = за звітний період,        B<line>_4 = за попередній період
 *                  2350 is one signed line «Чистий прибуток (збиток)»; there is no
 *                  gross-profit line in these forms.
 *
 * Units: тис. грн (small forms with one decimal place).
 */

export type FigureKey =
  | 'total_assets' | 'non_current_assets' | 'current_assets' | 'equity'
  | 'long_term_liabilities' | 'current_liabilities'
  | 'net_revenue' | 'gross_profit' | 'profit_before_tax' | 'net_profit';

export interface Figure {
  key: FigureKey;
  /** Line code(s) of the form the value comes from, e.g. "2350/2355". */
  line: string;
  label: string;
  current: number | null;
  prior: number | null;
}

export interface StatementFigures {
  form_code: string;
  form_name: string;
  units: string;
  /** Balance date from the filing (MY_DATE), ISO. */
  report_date: string | null;
  /** Period as the filer named it (REP_PERNM), e.g. "Рік 2025". */
  period_name: string | null;
  /** What `current` and `prior` mean, per statement. */
  columns: {
    balance?: { current: string; prior: string };
    income?: { current: string; prior: string };
  };
  figures: Figure[];
  /** Assets (1300) equal liabilities and equity (1900) at the end of the period. */
  balance_check?: boolean;
}

export const UNITS = 'тис. грн';

/** c_doc_sub → form name; covers every form in the dataset. */
export const FORM_NAMES: Record<string, string> = {
  '001': 'Форма № 1 «Баланс (Звіт про фінансовий стан)»',
  '002': 'Форма № 2 «Звіт про фінансові результати (Звіт про сукупний дохід)»',
  '003': 'Форма № 3 «Звіт про рух грошових коштів (за прямим методом)»',
  '033': 'Форма № 3-н «Звіт про рух грошових коштів (за непрямим методом)»',
  '040': 'Форма № 4 «Звіт про власний капітал»',
  '050': 'Форма № 5 «Примітки до річної фінансової звітності»',
  '060': 'Форма № 6 «Додаток до приміток до річної фінансової звітності (сегменти)»',
  '100': 'Форми № 1-м, 2-м «Фінансова звітність малого підприємства»',
  '110': 'Форми № 1-мс, 2-мс «Фінансова звітність мікропідприємства»',
};

/** Forms whose figures this module reads. */
export const FIGURE_FORMS = ['001', '002', '100', '110'] as const;

const BALANCE_LINES: Array<{ key: FigureKey; line: string; label: string }> = [
  { key: 'total_assets', line: '1300', label: 'Активи (баланс)' },
  { key: 'non_current_assets', line: '1095', label: 'Необоротні активи' },
  { key: 'current_assets', line: '1195', label: 'Оборотні активи' },
  { key: 'equity', line: '1495', label: 'Власний капітал' },
  { key: 'long_term_liabilities', line: '1595', label: 'Довгострокові зобов’язання і забезпечення' },
  { key: 'current_liabilities', line: '1695', label: 'Поточні зобов’язання і забезпечення' },
];

const LABEL = {
  net_revenue: 'Чистий дохід від реалізації продукції (товарів, робіт, послуг)',
  gross_profit: 'Валовий прибуток (збиток)',
  profit_before_tax: 'Фінансовий результат до оподаткування',
  net_profit: 'Чистий прибуток (збиток)',
} as const;

const COLS_FULL_BALANCE = { current: 'на кінець звітного періоду', prior: 'на початок звітного періоду' };
const COLS_SMALL_BALANCE = { current: 'на кінець звітного періоду', prior: 'на початок звітного року' };
const COLS_FULL_INCOME = { current: 'за звітний період', prior: 'за аналогічний період попереднього року' };
const COLS_SMALL_INCOME = { current: 'за звітний період', prior: 'за попередній період' };

/** Tag → numeric value; xsi:nil and empty tags are absent. */
export function readTags(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /<([AB]\d{4}(?:_\d)?)>\s*([^<]*?)\s*<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[2].replace(/\s/g, '').replace(',', '.');
    if (raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out.set(m[1], n);
  }
  return out;
}

function readText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** "31122025" → "2025-12-31". */
function ddmmyyyy(v: string | null): string | null {
  if (!v || !/^\d{8}$/.test(v)) return null;
  return `${v.slice(4)}-${v.slice(2, 4)}-${v.slice(0, 2)}`;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** profit − |loss|; null when neither line is filed. */
function net(profit: number | undefined, loss: number | undefined): number | null {
  if (profit === undefined && loss === undefined) return null;
  return round((profit ?? 0) - Math.abs(loss ?? 0));
}

const val = (v: number | undefined): number | null => (v === undefined ? null : v);

/** Form of a filing in financial_figures, by c_doc_sub. */
export type FormKey = '1' | '2' | '1-m' | '1-ms';
export const FORM_BY_SUB: Record<string, FormKey> = { '001': '1', '002': '2', '100': '1-m', '110': '1-ms' };
export const SUB_BY_FORM: Record<FormKey, string> = { '1': '001', '2': '002', '1-m': '100', '1-ms': '110' };

/**
 * Line code → value, split by column: `cur` is the reporting period (balance at its
 * end, income for the period), `prev` the comparative column (balance at the start
 * of the period or year, income for the same period last year).
 */
export interface StatementCells {
  cur: Record<string, number>;
  prev: Record<string, number>;
}

const CELL = /^([AB])(\d{4})(?:_([34]))?$/;

/**
 * Tag map of one XML filing → cells, by the form's column scheme (see the header).
 * Only the tag shapes a form defines are read; a stray tag of another scheme is ignored.
 * Checked on secondlayer_local 2026-11-18 by chaining years: the start-of-year column
 * of a 2024 balance equals the end-of-year column of the 2023 one (Ф1 1388/1594,
 * 1-м 3098/4227, 1-мс 1864/2488), and the comparative column of a 2024 income
 * statement equals the 2023 reporting column (Ф2 1326/1591), the reverse pairings
 * matching almost never.
 */
export function cellsFromTags(cDocSub: string, tags: Map<string, number>): StatementCells {
  const sub = String(cDocSub ?? '').padStart(3, '0');
  const cells: StatementCells = { cur: {}, prev: {} };
  for (const [tag, v] of tags) {
    const m = CELL.exec(tag);
    if (!m) continue;
    const [, col, line, graph] = m;
    const income = line >= '2000';
    let side: 'cur' | 'prev' | null = null;
    if (sub === '001') {
      if (!income && !graph) side = col === 'B' ? 'cur' : 'prev';
    } else if (sub === '002') {
      if (income && !graph) side = col === 'A' ? 'cur' : 'prev';
    } else if (sub === '100' || sub === '110') {
      if (!income && col === 'A' && graph) side = graph === '4' ? 'cur' : 'prev';
      if (income && col === 'B' && graph) side = graph === '3' ? 'cur' : 'prev';
    }
    if (side) cells[side][line] = v;
  }
  return cells;
}

/**
 * Graph-numbered cells (ДПС CSV for 2020, R<line>G<3|4>) → cells. Graph 3 is the start
 * of the year for balance lines and the reporting period for income lines, graph 4
 * the end of the year and the previous period.
 */
export function cellsFromGraphs(entries: Iterable<[line: string, graph: 3 | 4, value: number]>): StatementCells {
  const cells: StatementCells = { cur: {}, prev: {} };
  for (const [line, graph, v] of entries) {
    const income = line >= '2000';
    cells[(graph === 3) === income ? 'cur' : 'prev'][line] = v;
  }
  return cells;
}

const own = (o: Record<string, number> | null | undefined, k: string): number | undefined =>
  o && Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === 'number' ? o[k] : undefined;

/** Figures, columns and the balance check of one statement, from its cells. */
export function figuresFromCells(
  cDocSub: string,
  cells: { cur?: Record<string, number> | null; prev?: Record<string, number> | null },
): Pick<StatementFigures, 'columns' | 'figures' | 'balance_check'> | null {
  const sub = String(cDocSub ?? '').padStart(3, '0');
  if (!(FIGURE_FORMS as readonly string[]).includes(sub)) return null;
  const figures: Figure[] = [];
  const columns: StatementFigures['columns'] = {};
  let balanceCheck: boolean | undefined;
  const cur = (line: string) => own(cells.cur, line);
  const pri = (line: string) => own(cells.prev, line);

  if (sub === '001' || sub === '100' || sub === '110') {
    for (const b of BALANCE_LINES) {
      figures.push({ key: b.key, line: b.line, label: b.label, current: val(cur(b.line)), prior: val(pri(b.line)) });
    }
    columns.balance = sub === '001' ? COLS_FULL_BALANCE : COLS_SMALL_BALANCE;
    const a = cur('1300');
    const l = cur('1900');
    if (a !== undefined && l !== undefined) balanceCheck = Math.abs(a - l) < 0.05;
  }

  if (sub === '002') {
    figures.push(
      { key: 'net_revenue', line: '2000', label: LABEL.net_revenue, current: val(cur('2000')), prior: val(pri('2000')) },
      { key: 'gross_profit', line: '2090/2095', label: LABEL.gross_profit, current: net(cur('2090'), cur('2095')), prior: net(pri('2090'), pri('2095')) },
      { key: 'profit_before_tax', line: '2290/2295', label: LABEL.profit_before_tax, current: net(cur('2290'), cur('2295')), prior: net(pri('2290'), pri('2295')) },
      { key: 'net_profit', line: '2350/2355', label: LABEL.net_profit, current: net(cur('2350'), cur('2355')), prior: net(pri('2350'), pri('2355')) },
    );
    columns.income = COLS_FULL_INCOME;
  }

  if (sub === '100' || sub === '110') {
    figures.push(
      { key: 'net_revenue', line: '2000', label: LABEL.net_revenue, current: val(cur('2000')), prior: val(pri('2000')) },
      { key: 'profit_before_tax', line: '2290', label: LABEL.profit_before_tax, current: val(cur('2290')), prior: val(pri('2290')) },
      { key: 'net_profit', line: '2350', label: LABEL.net_profit, current: val(cur('2350')), prior: val(pri('2350')) },
    );
    columns.income = COLS_SMALL_INCOME;
  }

  // A filing with every key line empty (a nil-only form) says nothing: report no figures.
  return {
    columns,
    figures: figures.filter((f) => f.current !== null || f.prior !== null),
    ...(balanceCheck !== undefined ? { balance_check: balanceCheck } : {}),
  };
}

/**
 * Key figures of one filing, or null for forms that carry none of them
 * (cash flow, equity statement, notes) and for unparseable input.
 */
export function parseStatementFigures(cDocSub: string | null | undefined, xml: string | null | undefined): StatementFigures | null {
  const sub = String(cDocSub ?? '').padStart(3, '0');
  if (!xml || !(FIGURE_FORMS as readonly string[]).includes(sub)) return null;
  const parsed = figuresFromCells(sub, cellsFromTags(sub, readTags(xml)))!;
  return {
    form_code: sub,
    form_name: FORM_NAMES[sub],
    units: UNITS,
    report_date: ddmmyyyy(readText(xml, 'MY_DATE')),
    period_name: readText(xml, 'REP_PERNM'),
    ...parsed,
  };
}

/** Summary amounts stored per statement in financial_figures (тис. грн). */
export interface KeyAmounts {
  assets: number | null;
  equity: number | null;
  liabilities: number | null;
  revenue: number | null;
  net_profit: number | null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Summary amounts of the reporting period: assets 1300 (else 1900), equity 1495,
 * liabilities and provisions 1900 − 1495, net revenue 2000, net profit 2350 − 2355.
 * A line left empty on a filed side of the statement counts as zero (the form omits
 * empty lines); a side not filed at all (no balance lines in Форма 2) gives null.
 */
export function keyAmounts(cells: StatementCells): KeyAmounts {
  const c = cells.cur;
  const lines = Object.keys(c);
  const balance = lines.some((k) => k < '2000');
  const income = lines.some((k) => k >= '2000');
  const assets = balance ? (c['1300'] ?? c['1900'] ?? null) : null;
  const equity = balance ? (c['1495'] ?? 0) : null;
  return {
    assets,
    equity,
    liabilities: assets !== null ? round3((c['1900'] ?? assets) - (equity ?? 0)) : null,
    revenue: income ? (c['2000'] ?? 0) : null,
    net_profit: income ? round3((c['2350'] ?? 0) - Math.abs(c['2355'] ?? 0)) : null,
  };
}

/** '376372' → '00376372'. Longer codes are personal tax numbers of sole traders: null. */
export function normalizeEdrpou(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^\d{1,8}$/.test(s) ? s.padStart(8, '0') : null;
}

const XML_ENTITIES: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const unescapeXml = (s: string) => s.replace(/&(?:quot|apos|lt|gt|amp);/g, (e) => XML_ENTITIES[e]);

export interface FilingHeader {
  name: string | null;
  kved: string | null;
  /** D_FILL: the date the filer completed the report, ISO. */
  filed_on: string | null;
  /** C_DOC_STAN: 1 звітний, 2 новий звітний, 3 уточнюючий (absent in most filings). */
  doc_stan: number | null;
  /** MY_DATE: balance date, ISO. */
  report_date: string | null;
  /** REP_PERNM, e.g. "Рік 2025". */
  period_name: string | null;
}

export function readHeader(xml: string): FilingHeader {
  const text = (tag: string) => {
    const v = readText(xml, tag);
    return v === null ? null : unescapeXml(v);
  };
  const stan = text('C_DOC_STAN');
  return {
    name: text('FIRM_NAME'),
    kved: text('FIRM_KVED') ?? text('KVED'),
    filed_on: ddmmyyyy(text('D_FILL')),
    doc_stan: stan && /^\d+$/.test(stan) ? Number(stan) : null,
    report_date: ddmmyyyy(text('MY_DATE')),
    period_name: text('REP_PERNM'),
  };
}

export type FigureSource = 'dssu' | 'dps2020' | 'smida';

/** One row of financial_figures, keys as the table's columns. */
export interface FinancialFigureRow extends KeyAmounts, FilingHeader {
  edrpou: string;
  year: number;
  /** Month the reporting period ends: 3, 6, 9 or 12. */
  period: number;
  form: FormKey;
  source: FigureSource;
  cur: Record<string, number>;
  prev: Record<string, number> | null;
  source_ref: string;
  source_id: number | null;
}

/** Cells + header → a financial_figures row, or null when no line is filled. */
export function buildFigureRow(
  base: { edrpou: string; year: number; period: number; form: FormKey; source: FigureSource; source_ref: string; source_id: number | null },
  header: FilingHeader,
  cells: StatementCells,
): FinancialFigureRow | null {
  const hasCur = Object.keys(cells.cur).length > 0;
  const hasPrev = Object.keys(cells.prev).length > 0;
  if (!hasCur && !hasPrev) return null;
  return { ...base, ...header, cur: cells.cur, prev: hasPrev ? cells.prev : null, ...keyAmounts(cells) };
}

/**
 * opendata_financial_statements row → financial_figures row (source 'dssu'), or null
 * when the filing is not a Форма 1/2/1-м/1-мс, its code is a personal tax number,
 * its period is unknown, or no line is filled.
 */
export function figureRowFromFiling(r: {
  id: number | string;
  tin: string | null;
  c_doc_sub: string | null;
  period_year: number | string | null;
  period_month: number | string | null;
  raw_xml: string | null;
}): FinancialFigureRow | null {
  const sub = String(r.c_doc_sub ?? '').padStart(3, '0');
  const form = FORM_BY_SUB[sub];
  const edrpou = normalizeEdrpou(r.tin);
  const year = Number(r.period_year);
  const period = Number(r.period_month);
  if (!form || !edrpou || !r.raw_xml || !(year > 1990 && year < 2100) || !(period >= 1 && period <= 12)) return null;
  return buildFigureRow(
    { edrpou, year, period, form, source: 'dssu', source_ref: `opendata_financial_statements:${r.id}`, source_id: Number(r.id) },
    readHeader(r.raw_xml),
    cellsFromTags(sub, readTags(r.raw_xml)),
  );
}

/**
 * True when `a` should replace `b` for the same (edrpou, year, period, form, source):
 * the later filing wins (D_FILL), then the higher document state (a correction), then
 * the newer import. Equal rows replace each other, so a rerun refreshes the parse.
 */
export function newerFiling(
  a: Pick<FinancialFigureRow, 'filed_on' | 'doc_stan' | 'source_id'>,
  b: Pick<FinancialFigureRow, 'filed_on' | 'doc_stan' | 'source_id'>,
): boolean {
  const fa = a.filed_on ?? '';
  const fb = b.filed_on ?? '';
  if (fa !== fb) return fa > fb;
  const sa = a.doc_stan ?? 0;
  const sb = b.doc_stan ?? 0;
  if (sa !== sb) return sa > sb;
  return (a.source_id ?? 0) >= (b.source_id ?? 0);
}

/** Keep one row per key, by newerFiling. */
export function dedupeFigureRows(rows: FinancialFigureRow[]): FinancialFigureRow[] {
  const best = new Map<string, FinancialFigureRow>();
  for (const r of rows) {
    const k = `${r.edrpou}|${r.year}|${r.period}|${r.form}|${r.source}`;
    const cur = best.get(k);
    if (!cur || newerFiling(r, cur)) best.set(k, r);
  }
  return [...best.values()];
}

const PERIOD_BY_MONTH: Record<number, string> = { 3: 'I квартал', 6: 'півріччя', 9: '9 місяців', 12: 'рік' };

/** "рік 2025", "9 місяців 2023". */
export function periodLabel(year: unknown, month: unknown): string {
  const m = Number(month);
  const name = PERIOD_BY_MONTH[m] ?? (Number.isFinite(m) && m > 0 ? `${m} міс.` : 'період');
  return `${name} ${year ?? ''}`.trim();
}

/**
 * Statement figures from a financial_figures row (its cur/prev cells), the same shape
 * parseStatementFigures gives for the XML.
 */
export function statementFromStored(
  cDocSub: string,
  stored: { cur?: Record<string, number> | null; prev?: Record<string, number> | null; report_date?: string | null; period_name?: string | null },
): StatementFigures | null {
  const sub = String(cDocSub ?? '').padStart(3, '0');
  const parsed = figuresFromCells(sub, stored);
  if (!parsed) return null;
  return {
    form_code: sub,
    form_name: FORM_NAMES[sub],
    units: UNITS,
    report_date: stored.report_date ? String(stored.report_date).slice(0, 10) : null,
    period_name: stored.period_name ?? null,
    ...parsed,
  };
}

/**
 * search_registry row hook: replaces raw_xml with the figures, so the XML never
 * leaves the backend. `stored_figures` (cells from financial_figures) is used when
 * the filing has been normalized; otherwise the XML is parsed on the fly.
 */
export function financialStatementRow(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const { raw_xml, stored_figures, ...rest } = row;
  const sub = String(rest.c_doc_sub ?? '').padStart(3, '0');
  const parsed = stored_figures && typeof stored_figures === 'object'
    ? statementFromStored(sub, stored_figures)
    : parseStatementFigures(sub, typeof raw_xml === 'string' ? raw_xml : null);
  return {
    ...rest,
    form_name: FORM_NAMES[sub] ?? null,
    period: periodLabel(rest.period_year, rest.period_month),
    ...(parsed
      ? {
          units: parsed.units,
          report_date: parsed.report_date,
          columns: parsed.columns,
          figures: parsed.figures,
          ...(parsed.balance_check !== undefined ? { balance_check: parsed.balance_check } : {}),
        }
      : {}),
  };
}

export interface LatestFigures {
  period: string;
  period_year: number;
  period_month: number;
  forms: string[];
  units: string;
  columns: StatementFigures['columns'];
  figures: Figure[];
  balance_check?: boolean;
}

/**
 * The latest reporting period among parsed rows (output of financialStatementRow),
 * balance and income figures merged. A full annual report is preferred over a newer
 * interim one, because a year is what a reader compares; an interim period is used
 * only when no annual report exists.
 */
export function latestFigures(rows: any[]): LatestFigures | null {
  const withFigures = rows.filter((r) => Array.isArray(r?.figures) && r.figures.length > 0);
  if (!withFigures.length) return null;
  const key = (r: any) => Number(r.period_year) * 100 + Number(r.period_month);
  const annual = withFigures.filter((r) => Number(r.period_month) === 12);
  const pool = annual.length ? annual : withFigures;
  const best = Math.max(...pool.map(key));
  const same = pool.filter((r) => key(r) === best);
  const figures: Figure[] = [];
  const seen = new Set<string>();
  const columns: StatementFigures['columns'] = {};
  let balanceCheck: boolean | undefined;
  // Full forms (001/002) before small ones, so a company filing both keeps the full figures.
  for (const r of [...same].sort((a, b) => String(a.c_doc_sub).localeCompare(String(b.c_doc_sub)))) {
    for (const f of r.figures as Figure[]) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      figures.push(f);
    }
    if (r.columns?.balance && !columns.balance) columns.balance = r.columns.balance;
    if (r.columns?.income && !columns.income) columns.income = r.columns.income;
    if (r.balance_check !== undefined && balanceCheck === undefined) balanceCheck = r.balance_check;
  }
  const order: FigureKey[] = ['total_assets', 'non_current_assets', 'current_assets', 'equity', 'long_term_liabilities',
    'current_liabilities', 'net_revenue', 'gross_profit', 'profit_before_tax', 'net_profit'];
  figures.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return {
    period: periodLabel(same[0].period_year, same[0].period_month),
    period_year: Number(same[0].period_year),
    period_month: Number(same[0].period_month),
    forms: same.map((r) => r.form_name ?? r.form_type).filter(Boolean),
    units: UNITS,
    columns,
    figures,
    ...(balanceCheck !== undefined ? { balance_check: balanceCheck } : {}),
  };
}
