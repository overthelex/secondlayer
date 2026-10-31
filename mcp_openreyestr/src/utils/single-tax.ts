/**
 * Normalisation for the DPS single tax payers registry (LEXAI-2159).
 *
 * The DPS file stores ЄДРПОУ as a number, so codes with leading zeros come out
 * short ("05391695" -> "5391695"), and the activity-code column ("vd") is free
 * text: KVED-2005 (XX.XX.X) and KVED-2010 (XX.XX) codes, a "_" prefix on most
 * KVED-2010 codes, and ",", ";", "|", "/", "I" or spaces as separators. DPS
 * cuts the column at ~239 characters, so the last code of a long list can be
 * partial or missing.
 */

/** ЄДРПОУ is 8 digits. Shorter all-digit codes lost their leading zeros. */
export function normalizeEdrpou(code: string | null | undefined): string | null {
  if (code == null) return null;
  const trimmed = String(code).trim();
  if (trimmed === '') return null;
  if (/^\d{1,7}$/.test(trimmed)) return trimmed.padStart(8, '0');
  return trimmed;
}

/**
 * Stored values a lookup code can match: the 8-digit form and, for codes with
 * leading zeros, the zero-stripped form rows imported before the fix still
 * hold. 10-digit RNOKPP and other non-ЄДРПОУ inputs match only themselves.
 */
export function tinLookupCandidates(input: string): string[] {
  const trimmed = input.trim().replace(/\s+/g, '');
  if (!/^\d{1,8}$/.test(trimmed)) return [trimmed];
  const padded = trimmed.padStart(8, '0');
  const stripped = padded.replace(/^0+/, '') || '0';
  return Array.from(new Set([padded, stripped]));
}

export type KvedVersion = 'КВЕД-2010' | 'КВЕД-2005' | 'КВЕД-2005/2010';

export interface NormalizedActivityCodes {
  codes: string[];
  kvedVersion: KvedVersion | null;
}

// Division 2 digits, class 2 digits, optional KVED-2005 subclass digit. A
// one-digit class ("47.1") is a code DPS cut off mid-way and is dropped. The
// subclass is taken only when no digit follows it, so "68.20,47.19" splits into
// two codes instead of "68.20.4". "," is accepted as the decimal mark
// ("16,22  16,23").
const KVED_CODE = /(?<!\d)(\d{2})[.,](\d{2})(?:[.,](\d)(?!\d))?/g;

export function normalizeActivityCodes(raw: string | null | undefined): NormalizedActivityCodes {
  if (raw == null) return { codes: [], kvedVersion: null };
  const codes: string[] = [];
  let has2005 = false;
  let has2010 = false;
  for (const m of String(raw).matchAll(KVED_CODE)) {
    const code = m[3] !== undefined ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`;
    if (codes.includes(code)) continue;
    codes.push(code);
    if (m[3] !== undefined) has2005 = true;
    else has2010 = true;
  }
  const kvedVersion: KvedVersion | null =
    has2005 && has2010 ? 'КВЕД-2005/2010' : has2005 ? 'КВЕД-2005' : has2010 ? 'КВЕД-2010' : null;
  return { codes, kvedVersion };
}

/** Canonical stored form: codes joined by ", ", or null when none parse. */
export function formatActivityCodes(raw: string | null | undefined): string | null {
  const { codes } = normalizeActivityCodes(raw);
  return codes.length > 0 ? codes.join(', ') : null;
}

/** DPS cuts "vd" at ~239 characters; a value that long has lost codes. */
export const ACTIVITY_CODES_SOURCE_LIMIT = 238;

/**
 * True when DPS cut the list: the value reaches the source limit, or digits
 * follow the last complete code ("_47.19|_6", "68.20, 47.1").
 */
export function isActivityCodesTruncated(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const text = String(raw);
  if (text.length >= ACTIVITY_CODES_SOURCE_LIMIT) return true;
  let tailStart = 0;
  for (const m of text.matchAll(KVED_CODE)) tailStart = (m.index ?? 0) + m[0].length;
  return /\d/.test(text.slice(tailStart));
}

/** ISO yyyy-mm-dd or null; DPS also ships blanks and stray text here. */
export function normalizeIsoDate(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${m}-${d}`;
  }
  const v = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC rolls 2022-02-30 over to 2022-03-02; a real date round-trips.
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? v : null;
}

/**
 * Tool output for one single_tax_payers row. Rows loaded before LEXAI-2159
 * hold short ЄДРПОУ and raw activity codes; they are normalised here the same
 * way the importer now normalises them, so the answer does not depend on when
 * the row was loaded. `activity_codes_truncated` is NULL on those rows, and the
 * raw value then tells whether DPS cut the list.
 */
export function formatSingleTaxPayerRow(row: Record<string, any>): Record<string, unknown> {
  const raw = row.activity_codes as string | null | undefined;
  const { codes, kvedVersion } = normalizeActivityCodes(raw);
  const truncated =
    typeof row.activity_codes_truncated === 'boolean'
      ? row.activity_codes_truncated
      : isActivityCodesTruncated(raw);
  return {
    ...row,
    tin: normalizeEdrpou(row.tin),
    start_date: normalizeIsoDate(row.start_date),
    end_date: normalizeIsoDate(row.end_date),
    activity_codes: codes.length > 0 ? codes.join(', ') : null,
    kved_version: kvedVersion,
    activity_codes_truncated: truncated,
  };
}
