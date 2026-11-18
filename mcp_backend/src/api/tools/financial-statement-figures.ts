/**
 * Key figures of a Ukrainian financial statement, read from the XML filed to the
 * tax service (opendata_financial_statements.raw_xml, data.gov.ua dataset
 * "Фінансова звітність").
 *
 * Parsed at query time for the few rows a caller asked for: a company has a handful
 * of filings a year, so this costs microseconds and needs no migration of the 2.8 GB
 * table.
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

/**
 * Key figures of one filing, or null for forms that carry none of them
 * (cash flow, equity statement, notes) and for unparseable input.
 */
export function parseStatementFigures(cDocSub: string | null | undefined, xml: string | null | undefined): StatementFigures | null {
  const sub = String(cDocSub ?? '').padStart(3, '0');
  if (!xml || !(FIGURE_FORMS as readonly string[]).includes(sub)) return null;
  const t = readTags(xml);
  const figures: Figure[] = [];
  const columns: StatementFigures['columns'] = {};
  let balanceCheck: boolean | undefined;

  if (sub === '001' || sub === '100' || sub === '110') {
    const small = sub !== '001';
    const cur = (line: string) => t.get(small ? `A${line}_4` : `B${line}`);
    const pri = (line: string) => t.get(small ? `A${line}_3` : `A${line}`);
    for (const b of BALANCE_LINES) {
      figures.push({ key: b.key, line: b.line, label: b.label, current: val(cur(b.line)), prior: val(pri(b.line)) });
    }
    columns.balance = small ? COLS_SMALL_BALANCE : COLS_FULL_BALANCE;
    const a = cur('1300');
    const l = cur('1900');
    if (a !== undefined && l !== undefined) balanceCheck = Math.abs(a - l) < 0.05;
  }

  if (sub === '002') {
    const cur = (line: string) => t.get(`A${line}`);
    const pri = (line: string) => t.get(`B${line}`);
    figures.push(
      { key: 'net_revenue', line: '2000', label: LABEL.net_revenue, current: val(cur('2000')), prior: val(pri('2000')) },
      { key: 'gross_profit', line: '2090/2095', label: LABEL.gross_profit, current: net(cur('2090'), cur('2095')), prior: net(pri('2090'), pri('2095')) },
      { key: 'profit_before_tax', line: '2290/2295', label: LABEL.profit_before_tax, current: net(cur('2290'), cur('2295')), prior: net(pri('2290'), pri('2295')) },
      { key: 'net_profit', line: '2350/2355', label: LABEL.net_profit, current: net(cur('2350'), cur('2355')), prior: net(pri('2350'), pri('2355')) },
    );
    columns.income = COLS_FULL_INCOME;
  }

  if (sub === '100' || sub === '110') {
    const cur = (line: string) => t.get(`B${line}_3`);
    const pri = (line: string) => t.get(`B${line}_4`);
    figures.push(
      { key: 'net_revenue', line: '2000', label: LABEL.net_revenue, current: val(cur('2000')), prior: val(pri('2000')) },
      { key: 'profit_before_tax', line: '2290', label: LABEL.profit_before_tax, current: val(cur('2290')), prior: val(pri('2290')) },
      { key: 'net_profit', line: '2350', label: LABEL.net_profit, current: val(cur('2350')), prior: val(pri('2350')) },
    );
    columns.income = COLS_SMALL_INCOME;
  }

  // A filing with every key line empty (a nil-only form) says nothing: report no figures.
  const filled = figures.filter((f) => f.current !== null || f.prior !== null);
  return {
    form_code: sub,
    form_name: FORM_NAMES[sub],
    units: UNITS,
    report_date: ddmmyyyy(readText(xml, 'MY_DATE')),
    period_name: readText(xml, 'REP_PERNM'),
    columns,
    figures: filled,
    ...(balanceCheck !== undefined ? { balance_check: balanceCheck } : {}),
  };
}

const PERIOD_BY_MONTH: Record<number, string> = { 3: 'I квартал', 6: 'півріччя', 9: '9 місяців', 12: 'рік' };

/** "рік 2025", "9 місяців 2023". */
export function periodLabel(year: unknown, month: unknown): string {
  const m = Number(month);
  const name = PERIOD_BY_MONTH[m] ?? (Number.isFinite(m) && m > 0 ? `${m} міс.` : 'період');
  return `${name} ${year ?? ''}`.trim();
}

/**
 * search_registry row hook: replaces raw_xml with the parsed figures, so the XML
 * never leaves the backend.
 */
export function financialStatementRow(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const { raw_xml, ...rest } = row;
  const sub = String(rest.c_doc_sub ?? '').padStart(3, '0');
  const parsed = parseStatementFigures(sub, typeof raw_xml === 'string' ? raw_xml : null);
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
