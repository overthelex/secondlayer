/**
 * Date and row normalisation for the ДСА «Інформація щодо стану розгляду справ» dataset
 * (opendata_court_case_status), LEXAI-2173.
 *
 * The source stores dates as DD.MM.YYYY text typed by court staff, and about one row in
 * 13,000 carries a mistyped year: the two-digit year typed twice («01.12.2323» for 2023,
 * «29.02.2424» for 2024) or digits swapped or dropped («15.02.0180», «25.05.5018»).
 * The importer used to store them verbatim, so those rows sorted first in
 * search_court_case_status. A doubled year is repaired; any other year outside the
 * plausible range is dropped (NULL), because the intended year cannot be recovered.
 *
 * The same rules are applied to stored rows by migration 233_court_case_status_dates.sql;
 * keep the two in step.
 */

/** The ДСА registry starts with the courts' automated case management in the 1990s. */
export const MIN_COURT_YEAR = 1991;

const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const DOUBLED_YEAR_RE = /^(2[0-9])\1$/;

export type CourtDateFix = 'ok' | 'repaired' | 'dropped' | 'empty';

export interface NormalizedCourtDate {
  value: string | null;
  fix: CourtDateFix;
}

/**
 * Normalise one DD.MM.YYYY value.
 * @param maxYear latest plausible year (scheduled stages run into next year, so the
 *   importer passes the current year + 1).
 */
export function normalizeCourtDate(raw: unknown, maxYear: number): NormalizedCourtDate {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return { value: null, fix: 'empty' };
  const m = DATE_RE.exec(s);
  if (!m) return { value: null, fix: 'dropped' };
  const [, dd, mm, yyyy] = m;
  const year = Number(yyyy);
  let fixedYear: number | null = null;
  let fix: CourtDateFix = 'ok';
  if (year >= MIN_COURT_YEAR && year <= maxYear) {
    fixedYear = year;
  } else if (DOUBLED_YEAR_RE.test(yyyy)) {
    const candidate = 2000 + Number(yyyy.slice(2));
    if (candidate >= MIN_COURT_YEAR && candidate <= maxYear) {
      fixedYear = candidate;
      fix = 'repaired';
    }
  }
  if (fixedYear === null) return { value: null, fix: 'dropped' };
  // The calendar check runs on the final year: 29.02 is valid in 2024 but not in 2023.
  if (!isCalendarDate(Number(dd), Number(mm), fixedYear)) return { value: null, fix: 'dropped' };
  return { value: fix === 'ok' ? s : `${dd}.${mm}.${fixedYear}`, fix };
}

/** True when day/month/year name a real day (31.02 and 29.02 of a non-leap year do not). */
export function isCalendarDate(day: number, month: number, year: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

/** Column order of the ДСА TSV header (the file's "type" column maps to case_type). */
export const SOURCE_COLUMNS = [
  'court_name', 'case_number', 'case_proc', 'registration_date', 'judge', 'judges',
  'participants', 'stage_date', 'stage_name', 'cause_result', 'cause_dep', 'type', 'description',
] as const;

export const TARGET_COLUMNS = [
  'court_name', 'case_number', 'case_proc', 'registration_date', 'judge', 'judges',
  'participants', 'stage_date', 'stage_name', 'cause_result', 'cause_dep', 'case_type', 'description',
] as const;

/**
 * Parse the ДСА export: tab-separated, every field in double quotes, quotes inside a
 * field doubled, and newlines allowed inside quoted fields (description, participants).
 * Yields one string[] per record, header included.
 */
export function* parseQuotedTsv(text: string): Generator<string[]> {
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === '\t') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') yield row;
      row = []; i++; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') yield row;
  }
}

export interface DateFixStats { repaired: number; dropped: number }

/**
 * Position of every SOURCE_COLUMNS entry in the file header. Throws when the header lacks
 * a column, so a format change in the export stops the import instead of loading NULLs.
 */
export function columnIndex(header: string[]): number[] {
  const clean = header.map((h) => h.trim().toLowerCase());
  const missing = SOURCE_COLUMNS.filter((c) => !clean.includes(c));
  if (missing.length) throw new Error(`ДСА export header lacks: ${missing.join(', ')}`);
  return SOURCE_COLUMNS.map((c) => clean.indexOf(c));
}

/**
 * Map one source record to TARGET_COLUMNS values, normalising the two date columns.
 * Returns null for a record with no case number.
 */
export function toTargetRow(
  index: number[],
  record: string[],
  maxYear: number,
  stats?: DateFixStats,
): (string | null)[] | null {
  const caseNumber = record[index[1]];
  if (!caseNumber || !caseNumber.trim()) return null;

  return SOURCE_COLUMNS.map((col, k) => {
    const idx = index[k];
    const v = idx < record.length ? record[idx] : null;
    if (col === 'stage_date' || col === 'registration_date') {
      const d = normalizeCourtDate(v, maxYear);
      if (stats && d.fix === 'repaired') stats.repaired++;
      if (stats && d.fix === 'dropped') stats.dropped++;
      return d.value;
    }
    return v;
  });
}

export interface CkanResource { url: string; name?: string; format?: string; last_modified?: string; created?: string }

/** The newest *.zip resource of the dataset (the monthly 2022 CSV files are history). */
export function pickLatestZip(resources: CkanResource[]): CkanResource | null {
  const zips = resources.filter((r) => /\.zip$/i.test(r.url) || /\.zip$/i.test(r.name || ''));
  if (!zips.length) return null;
  const ts = (r: CkanResource) => r.last_modified || r.created || '';
  return zips.sort((a, b) => ts(b).localeCompare(ts(a)))[0];
}
