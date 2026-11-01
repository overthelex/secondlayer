/**
 * Helpers for json_array sources whose data is spread over several resources of one
 * data.gov.ua (CKAN) dataset (LEXAI-2181).
 *
 * The МВС passport registers used to be one file per dataset at a fixed resource URL. In
 * April 2026 the ministry re-published them as ~25 regional files (mvswantedpassport_vNN.json)
 * under new dataset ids, and every fixed URL in import_source_catalog went 404. A catalog
 * entry for such a source names the dataset (`ckan_package`) and a file-name pattern; the
 * importer asks CKAN (package_show) for the current resource list on every run, so the next
 * re-publication changes nothing as long as the dataset keeps its id or slug.
 *
 * Everything here is pure (no I/O) so it can be unit-tested.
 */

import { normalizePassportSeries } from '../utils/passport-series.js';

export interface CkanResource {
  id: string;
  name: string;
  url: string;
  last_modified: string | null;
}

/** Default CKAN action endpoint for data.gov.ua. */
export const DATA_GOV_UA_PACKAGE_SHOW = 'https://data.gov.ua/api/3/action/package_show';

export function packageShowUrl(packageId: string, apiBase: string = DATA_GOV_UA_PACKAGE_SHOW): string {
  return `${apiBase}?id=${encodeURIComponent(packageId)}`;
}

/**
 * Pick the data files of a CKAN package_show response. `pattern` (a case-insensitive regex)
 * is matched against the resource URL's file name, falling back to the resource name; it is
 * what separates mvswantedpassport_v05.json from mvswantedpassport_shema.json. Sorted by
 * file name so a run is reproducible.
 */
export function selectCkanResources(packageShow: any, pattern: string, format?: string): CkanResource[] {
  const pkg = packageShow?.result ?? packageShow;
  if (!pkg || !Array.isArray(pkg.resources)) {
    throw new Error('CKAN package_show: no resources in response');
  }
  const re = new RegExp(pattern, 'i');
  const picked: CkanResource[] = [];
  for (const r of pkg.resources) {
    if (!r || typeof r.url !== 'string' || !r.url) continue;
    // Optional CKAN `format` filter: НАЗК's live API resource ("API", .../corrupt/getAllData)
    // and its 2020 XLSX dump (.../download/getalldata) have the same file name.
    if (format && String(r.format ?? '').trim().toUpperCase() !== format.toUpperCase()) continue;
    const fileName = r.url.split('?')[0].split('/').pop() || '';
    if (!re.test(fileName) && !re.test(String(r.name ?? ''))) continue;
    picked.push({
      id: String(r.id ?? ''),
      name: String(r.name ?? fileName),
      url: r.url,
      last_modified: r.last_modified || r.metadata_modified || r.created || null,
    });
  }
  const key = (r: CkanResource) => (r.url.split('/').pop() || r.name).toLowerCase();
  return picked.sort((a, b) => key(a).localeCompare(key(b)));
}

/** Default for source_config.download_timeout_ms: socket idle time before a download is abandoned. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Upper bound for download_timeout_ms, so a typo cannot park a task for hours. */
export const MAX_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/**
 * source_config.download_timeout_ms -> the idle timeout for a resource download (LEXAI-2183).
 * It bounds silence on the socket, not the whole transfer: НАЗК's getAllData API sends its
 * first byte only after ~163 s and then streams 55 MB in ~5 s, so the 60 s default failed
 * every attempt. Missing -> the default; anything that is not a whole number of ms in
 * 1 s .. 30 min throws before any download.
 */
export function resolveDownloadTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1_000 || n > MAX_DOWNLOAD_TIMEOUT_MS) {
    throw new Error(`download_timeout_ms must be a whole number of ms between 1000 and ${MAX_DOWNLOAD_TIMEOUT_MS}, got ${JSON.stringify(value)}`);
  }
  return n;
}

/** CKAN timestamps are naive UTC ("2026-05-01T01:00:05.496043"). */
export function parseCkanTimestamp(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : `${ts}Z`;
  return Date.parse(iso);
}

/**
 * The most recently modified resource (source_config.latest_only), for datasets that add a
 * dated snapshot per release next to the old ones (АМКУ reestr_dd_DD_MM_YYYY.xlsx, ДПС
 * reestr_vpp_YYYY.csv): loading all of them would stack every past release into the table.
 * File names are not reliably dated, so this goes by CKAN's last_modified; a resource
 * without a parsable timestamp is never preferred over one with it.
 */
export function latestCkanResource(resources: CkanResource[]): CkanResource[] {
  let best: CkanResource | null = null;
  let bestT = -Infinity;
  for (const r of resources) {
    const t = parseCkanTimestamp(r.last_modified);
    const tt = Number.isNaN(t) ? -Infinity : t;
    if (best === null || tt > bestT) { best = r; bestT = tt; }
  }
  return best ? [best] : [];
}

/**
 * True when every resource was last modified before `lastSuccessAt` — i.e. a previous run
 * already loaded exactly these files. A resource without a parsable timestamp counts as
 * changed, so an unknown is never skipped.
 */
export function resourcesUnchangedSince(resources: CkanResource[], lastSuccessAt: Date | string | null | undefined): boolean {
  if (!lastSuccessAt || resources.length === 0) return false;
  const since = new Date(lastSuccessAt).getTime();
  if (Number.isNaN(since)) return false;
  return resources.every((r) => {
    const t = parseCkanTimestamp(r.last_modified);
    return !Number.isNaN(t) && t < since;
  });
}

/**
 * Replace guard: refuse to swap in a load that is much smaller than what the table holds
 * now (a truncated download, a dataset half re-published, a pattern that stopped matching).
 * Returns the refusal message, or null when the swap may proceed.
 */
export function replaceGuardError(newRows: number, currentRows: number, minRatio: number): string | null {
  if (newRows <= 0) return 'джерело дало 0 записів';
  if (currentRows <= 0) return null;
  const ratio = newRows / currentRows;
  if (ratio < minRatio) {
    return `нове завантаження ${newRows} записів < ${Math.round(minRatio * 100)}% від поточних ${currentRows} ` +
      `(${(ratio * 100).toFixed(1)}%)`;
  }
  return null;
}

/** Named per-column value transforms a catalog entry can request (source_config.transforms). */
export const VALUE_TRANSFORMS: Record<string, (v: any) => any> = {
  /** Passport series in the registry's Latin storage form (see normalizePassportSeries). */
  passport_series: (v) => {
    if (v == null) return null;
    const s = normalizePassportSeries(String(v));
    return s === '' ? null : s;
  },
  /**
   * "2012-01-16T00:00:00" -> "2012-01-16". Anything that is not a valid calendar date in
   * years 0001-9999 becomes NULL instead of failing the whole batch (PostgreSQL rejects year 0).
   */
  iso_date: (v) => {
    if (v == null) return null;
    const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
    if (d > daysInMonth) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  },
  trim: (v) => (v == null ? null : String(v).trim() || null),
  /** List of strings -> one text, lines joined; [] -> "" (НААУ statusDescription). */
  join: (v) => (v == null ? null : Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean).join('\n') : String(v)),
  /**
   * Number for a NUMERIC column, from a spreadsheet cell in either convention:
   * "107 302 000,50", "1.234,56", "1,234.56", "22600934.18", "16770000\n". Anything that is
   * not a number ("NA" in АМКУ's amounts) -> NULL, so one text cell does not fail the batch.
   */
  number: (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = normalizeNumberString(String(v));
    return s === null ? null : Number(s);
  },
};

/**
 * "1.234,56" / "1,234.56" / "1 234,56" -> "1234.56"; null when the text is not a number.
 * Spaces (incl. no-break ones) are group separators. With both "," and "." the later one is
 * the decimal mark; a mark that occurs more than once is a group separator; a single mark
 * alone is the decimal mark (Ukrainian "0,5" and "22600934.18"). Groups after a group
 * separator must have 3 digits, so "1,2,3" is rejected instead of read as 123.
 */
export function normalizeNumberString(raw: string): string | null {
  const s = raw.replace(/[\s\u00a0\u202f]/g, '');
  if (!/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let group: string | null = null;
  let decimal: string | null = null;
  if (lastComma >= 0 && lastDot >= 0) {
    decimal = lastComma > lastDot ? ',' : '.';
    group = decimal === ',' ? '.' : ',';
  } else if (lastComma >= 0 || lastDot >= 0) {
    const mark = lastComma >= 0 ? ',' : '.';
    if (s.split(mark).length > 2) group = mark; else decimal = mark;
  }
  let intPart = s;
  let frac = '';
  if (decimal) {
    const i = s.lastIndexOf(decimal);
    intPart = s.slice(0, i);
    frac = s.slice(i + 1);
    if (!/^\d+$/.test(frac)) return null;
  }
  const neg = intPart.startsWith('-');
  let digits = neg ? intPart.slice(1) : intPart;
  if (group) {
    const parts = digits.split(group);
    if (!/^\d{1,3}$/.test(parts[0]) || parts.slice(1).some(x => !/^\d{3}$/.test(x))) return null;
    digits = parts.join('');
  }
  if (!/^\d+$/.test(digits)) return null;
  return `${neg ? '-' : ''}${digits}${frac ? `.${frac}` : ''}`;
}

/** Throws on a transform name the importer does not know (caught before any download). */
export function validateTransforms(transforms: Record<string, string> | undefined): void {
  for (const [col, name] of Object.entries(transforms ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(VALUE_TRANSFORMS, name)) throw new Error(`unknown transform "${name}" for column ${col}`);
  }
}

/**
 * Incremental parser for a JSON document whose top level is an array of objects:
 * feed it text chunks, get back the complete elements seen so far. Lets a 200 MB regional
 * file be loaded in batches instead of holding the whole string and parsed tree in memory.
 *
 * The array syntax is checked strictly: only objects at the top level, exactly one comma
 * between elements, no trailing comma, `]` as the closer and nothing but whitespace after
 * it. Brackets inside an element must pair up; the element text itself is validated by
 * JSON.parse. Anything else throws, so a malformed file can never load partially.
 */
type ArrayState = 'start' | 'first' | 'afterElement' | 'afterComma' | 'done';

export class JsonArrayStreamParser {
  private buf = '';
  private pos = 0;
  private state: ArrayState = 'start';
  /** Open brackets inside the current element; empty = between elements. */
  private stack: string[] = [];
  private inString = false;
  private escape = false;
  private elementStart = -1;

  push(chunk: string): any[] {
    this.buf += chunk;
    const out: any[] = [];
    const s = this.buf;
    let i = this.pos;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (this.stack.length > 0) {
        // Inside an element.
        if (this.inString) {
          if (this.escape) this.escape = false;
          else if (ch === '\\') this.escape = true;
          else if (ch === '"') this.inString = false;
          continue;
        }
        if (ch === '"') { this.inString = true; continue; }
        if (ch === '{' || ch === '[') { this.stack.push(ch); continue; }
        if (ch === '}' || ch === ']') {
          const open = this.stack.pop();
          if ((ch === '}') !== (open === '{')) throw new Error(`JSON array stream: mismatched "${ch}" inside an element`);
          if (this.stack.length === 0) {
            out.push(JSON.parse(s.slice(this.elementStart, i + 1)));
            this.elementStart = -1;
            this.state = 'afterElement';
          }
        }
        continue;
      }
      // Between elements, or outside the array.
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
      if (this.state === 'start') {
        if (ch === '﻿') continue;
        if (ch !== '[') throw new Error(`JSON array stream: expected "[" at start, got "${ch}"`);
        this.state = 'first';
      } else if (this.state === 'first' || this.state === 'afterComma') {
        if (ch === '{') {
          this.elementStart = i;
          this.stack.push('{');
        } else if (ch === ']' && this.state === 'first') {
          this.state = 'done';
        } else {
          throw new Error(`JSON array stream: top-level element is not an object (got "${ch}")`);
        }
      } else if (this.state === 'afterElement') {
        if (ch === ',') this.state = 'afterComma';
        else if (ch === ']') this.state = 'done';
        else throw new Error(`JSON array stream: expected "," or "]" after an element, got "${ch}"`);
      } else {
        throw new Error('JSON array stream: data after closing bracket');
      }
    }
    // Keep only the unfinished element (or nothing) in the buffer.
    if (this.elementStart >= 0) {
      this.buf = s.slice(this.elementStart);
      this.pos = i - this.elementStart;
      this.elementStart = 0;
    } else {
      this.buf = '';
      this.pos = 0;
    }
    return out;
  }

  /** Call after the last chunk: throws if the document was cut off. */
  end(): Record<string, any>[] {
    if (this.state !== 'done') throw new Error('JSON array stream: unexpected end of data (truncated download?)');
    return [];
  }
}

// ---------------------------------------------------------------------------------------
// Tabular resources (LEXAI-2183). Several catalog sources moved from a JSON resource to CSV
// (ДСА court schedule, НАЗК declaration checks, ДПС large taxpayers) or XLSX (АМКУ state
// aid). Both become plain records keyed by the header row, so mapping/transforms, staging
// and the guarded swap stay exactly as for JSON.

export interface TabularOptions {
  /** 1-based non-blank row holding the column names (default 1). */
  headerRow?: number;
  /** Rows to drop after the header, e.g. АМКУ's second header row with Ukrainian labels. */
  skipRows?: number;
}

/**
 * Header cells -> record keys: whitespace collapsed and trimmed; a repeated name gets a
 * numeric suffix (АМКУ has "EDRPOU" for the provider and again for the recipient ->
 * EDRPOU, EDRPOU_2); an empty header cell becomes "col_N" so its values are not lost.
 */
export function headerKeys(cells: any[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((c, i) => {
    const base = String(c ?? '').replace(/^﻿/, '').replace(/\s+/g, ' ').trim() || `col_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

function rowToRecord(keys: string[], cells: any[]): Record<string, any> {
  const rec: Record<string, any> = {};
  keys.forEach((k, i) => { rec[k] = cells[i] ?? null; });
  return rec;
}

/**
 * The file's layout is wrong (missing header row, rows wider than the header): the same
 * download would fail the same way, so the importer does not retry it. A truncated download
 * stays a plain Error and is retried.
 */
export class TabularLayoutError extends Error {
  readonly noRetry = true;
}

const isBlankRow = (cells: any[]) => cells.every(c => c == null || String(c).trim() === '');

/**
 * Incremental RFC 4180 parser (quoted fields, "" escapes, delimiters and line breaks inside
 * quotes, CRLF or LF) with the same push()/end() contract as JsonArrayStreamParser, so the
 * 400 MB ДСА file streams in batches. Blank lines are skipped. A data row with more fields
 * than the header (wrong delimiter, broken quoting) throws; a short row gets nulls.
 */
export class CsvStreamParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  /** Saw a quote inside a quoted field: an escaped "" or the closing quote, decided by the next char. */
  private quotePending = false;
  private fieldStarted = false;
  private lineNo = 0;
  private keys: string[] | null = null;
  private skipLeft: number;
  private readonly headerRow: number;
  private bomChecked = false;

  constructor(private readonly delimiter: string = ',', opts: TabularOptions = {}) {
    if (delimiter.length !== 1) throw new Error(`CSV delimiter must be one character, got "${delimiter}"`);
    this.headerRow = Math.max(1, opts.headerRow ?? 1);
    this.skipLeft = Math.max(0, opts.skipRows ?? 0);
  }

  push(chunk: string): Record<string, any>[] {
    const out: Record<string, any>[] = [];
    let s = chunk;
    if (!this.bomChecked && s.length) {
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      this.bomChecked = true;
    }
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (ch === '"') { this.field += '"'; continue; }
          this.inQuotes = false; // that was the closing quote; handle ch as unquoted below
        } else if (ch === '"') {
          this.quotePending = true;
          continue;
        } else {
          this.field += ch;
          continue;
        }
      }
      if (ch === '"' && !this.fieldStarted) { this.inQuotes = true; this.fieldStarted = true; continue; }
      if (ch === this.delimiter) { this.endField(); continue; }
      if (ch === '\n') { this.endRow(out); continue; }
      if (ch === '\r') continue; // CRLF line ends; a CR inside quotes is kept above
      this.field += ch;
      this.fieldStarted = true;
    }
    return out;
  }

  /** Call after the last chunk: returns the last row when the file has no trailing newline. */
  end(): Record<string, any>[] {
    if (this.inQuotes && !this.quotePending) {
      throw new Error('CSV stream: unexpected end of data inside a quoted field (truncated download?)');
    }
    this.inQuotes = false;
    this.quotePending = false;
    const out: Record<string, any>[] = [];
    if (this.fieldStarted || this.row.length) this.endRow(out);
    if (!this.keys) throw new TabularLayoutError(`CSV stream: no header row ${this.headerRow}`);
    return out;
  }

  private endField(): void {
    this.row.push(this.field);
    this.field = '';
    this.fieldStarted = false;
  }

  private endRow(out: Record<string, any>[]): void {
    this.endField();
    const cells = this.row;
    this.row = [];
    if (isBlankRow(cells)) return;
    this.lineNo++;
    if (!this.keys) {
      if (this.lineNo === this.headerRow) this.keys = headerKeys(cells);
      return;
    }
    if (this.skipLeft > 0) { this.skipLeft--; return; }
    if (cells.length > this.keys.length) {
      throw new TabularLayoutError(`CSV stream: row ${this.lineNo} has ${cells.length} fields, header has ${this.keys.length}`);
    }
    out.push(rowToRecord(this.keys, cells));
  }
}

/**
 * exceljs cell value -> plain value: rich text and hyperlinks to their text, formulas to
 * their result, dates to "YYYY-MM-DD" (full ISO when there is a time of day), errors to null.
 */
export function xlsxCellValue(v: any): any {
  if (v == null) return null;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t: any) => t.text ?? '').join('');
    if ('result' in v) return xlsxCellValue(v.result);
    if ('text' in v) return xlsxCellValue(v.text);
    if ('error' in v) return null;
  }
  return v;
}

/**
 * Records of the first worksheet of an XLSX file. Meant for small registers (the whole
 * file is held in memory; the importer caps the download). Blank rows are not counted for
 * headerRow / skipRows; trailing empty header cells are formatting, not columns, but a data
 * row with a value beyond the last header column fails (TabularLayoutError).
 */
export async function xlsxRecords(buf: Buffer, opts: TabularOptions = {}): Promise<Record<string, any>[]> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  if (!ws) throw new TabularLayoutError('XLSX: no worksheet');
  const headerRow = Math.max(1, opts.headerRow ?? 1);
  let skipLeft = Math.max(0, opts.skipRows ?? 0);
  let keys: string[] | null = null;
  let lineNo = 0;
  const out: Record<string, any>[] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-based and sparse (holes for empty cells): densify before mapping.
    const vals = Array.from(row.values as any[]).slice(1).map(xlsxCellValue);
    if (isBlankRow(vals)) return;
    lineNo++;
    if (!keys) {
      if (lineNo === headerRow) {
        keys = headerKeys(vals);
        while (keys.length && /^col_\d+$/.test(keys[keys.length - 1])) keys.pop();
      }
      return;
    }
    if (skipLeft > 0) { skipLeft--; return; }
    // Like the CSV parser: a populated cell right of the last header column has no field to
    // land in; dropping it would load the row silently incomplete.
    const extra = vals.findIndex((c, i) => i >= keys!.length && c != null && String(c).trim() !== '');
    if (extra >= 0) {
      throw new TabularLayoutError(`XLSX: row ${row.number} has a value in column ${extra + 1}, header has ${keys!.length} columns`);
    }
    out.push(rowToRecord(keys, vals));
  });
  if (!keys) throw new TabularLayoutError(`XLSX: no header row ${headerRow}`);
  return out;
}
