/**
 * Pure parsing of the ДПС 2020 financial-statement CSV (pokaznyk_fin.zvit.zip) into
 * financial_figures rows; the I/O lives in scripts/import-dps2020-financial-figures.ts.
 *
 * Columns: TIN, FULL_NAME, FORM_CODE, FORM_NAME, PERIOD_MONTH, PERIOD_YEAR, D_GET and
 * one column per cell, R<line>G<3|4> (graph 3 = start of the year for balance lines,
 * the reporting year for income lines). Values use a decimal comma; "null" cells are
 * dropped, explicit zeros kept (as in the XML filings), and a record with no non-zero
 * cell is skipped as an empty statement.
 */
import {
  buildFigureRow, cellsFromGraphs, FinancialFigureRow, FormKey, normalizeEdrpou, REPORT_PERIODS,
} from '../api/tools/financial-statement-figures.js';

/** Zip entry name → form: J09001xx Форма 1, J09002xx Форма 2, J09011xx 1-м, J09012xx 1-мс. */
export const DPS_ENTRY = /^J09(001|002|011|012)\d\d/;
export const DPS_FORM_BY_ENTRY: Record<string, FormKey> = { '001': '1', '002': '2', '011': '1-m', '012': '1-ms' };

const CELL_COL = /^R(\d{4})G([34])$/;
const CELL_COLS = new WeakMap<string[], Array<[number, string, 3 | 4]>>();

/** Records of a separated CSV with "" quoting; fields may span lines inside quotes. */
export function* csvRecords(text: string, sep = ';'): Generator<string[]> {
  let field = '';
  let rec: string[] = [];
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === sep) { rec.push(field); field = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      rec.push(field); field = '';
      if (rec.length > 1 || rec[0] !== '') yield rec;
      rec = []; i++; continue;
    }
    field += ch; i++;
  }
  if (field !== '' || rec.length) { rec.push(field); yield rec; }
}

/** "1 234,5" → 1234.5; "null" and "" → undefined; an explicit 0 is kept. */
export function csvNumber(v: string | undefined): number | undefined {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!s || s.toLowerCase() === 'null') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** "22.01.2021" → "2021-01-22"; an impossible calendar date → null. */
export function dmyDots(v: string | undefined): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** One CSV record → a financial_figures row (source 'dps2020'), or null. */
export function dpsRow(header: string[], rec: string[], form: FormKey, sourceRef: string): FinancialFigureRow | null {
  const get = (name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? rec[i] : undefined;
  };
  const edrpou = normalizeEdrpou(get('TIN'));
  const year = parseInt(String(get('PERIOD_YEAR') ?? ''), 10);
  const month = parseInt(String(get('PERIOD_MONTH') ?? '12'), 10) || 12;
  if (!edrpou || !(year > 1990 && year < 2100) || !REPORT_PERIODS.includes(month)) return null;
  let cols = CELL_COLS.get(header);
  if (!cols) {
    const found: Array<[number, string, 3 | 4]> = [];
    header.forEach((h, i) => {
      const m = CELL_COL.exec(h);
      if (m) found.push([i, m[1], Number(m[2]) as 3 | 4]);
    });
    CELL_COLS.set(header, found);
    cols = found;
  }
  const entries: Array<[string, 3 | 4, number]> = [];
  for (const [i, line, graph] of cols) {
    const v = csvNumber(rec[i]);
    if (v !== undefined) entries.push([line, graph, v]);
  }
  // The file has a record for every filer of the form; one with no non-zero cell is an
  // empty statement, not a statement of zeros.
  if (!entries.some(([, , v]) => v !== 0)) return null;
  const name = (get('FULL_NAME') ?? '').trim() || null;
  return buildFigureRow(
    { edrpou, year, period: month, form, source: 'dps2020', source_ref: sourceRef, source_id: null },
    { name, kved: null, filed_on: dmyDots(get('D_GET')), doc_stan: null, report_date: null, period_name: null },
    cellsFromGraphs(entries),
  );
}
