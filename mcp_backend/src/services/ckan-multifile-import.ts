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
export function selectCkanResources(packageShow: any, pattern: string): CkanResource[] {
  const pkg = packageShow?.result ?? packageShow;
  if (!pkg || !Array.isArray(pkg.resources)) {
    throw new Error('CKAN package_show: no resources in response');
  }
  const re = new RegExp(pattern, 'i');
  const picked: CkanResource[] = [];
  for (const r of pkg.resources) {
    if (!r || typeof r.url !== 'string' || !r.url) continue;
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

/** CKAN timestamps are naive UTC ("2026-05-01T01:00:05.496043"). */
export function parseCkanTimestamp(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : `${ts}Z`;
  return Date.parse(iso);
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
};

/** Throws on a transform name the importer does not know (caught before any download). */
export function validateTransforms(transforms: Record<string, string> | undefined): void {
  for (const [col, name] of Object.entries(transforms ?? {})) {
    if (!VALUE_TRANSFORMS[name]) throw new Error(`unknown transform "${name}" for column ${col}`);
  }
}

/**
 * Incremental parser for a JSON document whose top level is an array of objects:
 * feed it text chunks, get back the complete elements seen so far. Lets a 200 MB regional
 * file be loaded in batches instead of holding the whole string and parsed tree in memory.
 * Elements may themselves contain nested objects/arrays and any string content.
 */
export class JsonArrayStreamParser {
  private buf = '';
  private pos = 0;
  private depth = 0;
  private inString = false;
  private escape = false;
  private elementStart = -1;
  private started = false;
  private finished = false;

  push(chunk: string): any[] {
    if (this.finished) {
      if (chunk.trim()) throw new Error('JSON array stream: data after closing bracket');
      return [];
    }
    this.buf += chunk;
    const out: any[] = [];
    const s = this.buf;
    let i = this.pos;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (ch === '\\') this.escape = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (!this.started) {
        if (ch === '﻿' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
        if (ch !== '[') throw new Error(`JSON array stream: expected "[" at start, got "${ch}"`);
        this.started = true;
        this.depth = 1;
        continue;
      }
      if (ch === '"') {
        this.inString = true;
        if (this.depth === 1) throw new Error('JSON array stream: top-level element is not an object');
        continue;
      }
      if (ch === '{' || ch === '[') {
        if (this.depth === 1) {
          if (ch === '[') throw new Error('JSON array stream: top-level element is not an object');
          this.elementStart = i;
        }
        this.depth++;
      } else if (ch === '}' || ch === ']') {
        this.depth--;
        if (this.depth === 1 && ch === '}') {
          out.push(JSON.parse(s.slice(this.elementStart, i + 1)));
          this.elementStart = -1;
        } else if (this.depth === 0) {
          this.finished = true;
          i++;
          break;
        }
      }
    }
    // Keep only the unfinished element (or nothing) in the buffer.
    if (this.elementStart >= 0) {
      this.buf = s.slice(this.elementStart);
      this.pos = i - this.elementStart;
      this.elementStart = 0;
    } else {
      if (this.finished && s.slice(i).trim()) throw new Error('JSON array stream: data after closing bracket');
      this.buf = '';
      this.pos = 0;
    }
    return out;
  }

  /** Call after the last chunk: throws if the document was cut off. */
  end(): void {
    if (!this.finished) throw new Error('JSON array stream: unexpected end of data (truncated download?)');
  }
}
