/**
 * Enforcement proceedings (АСВП) normalisation (LEXAI-2163).
 *
 * The АСВП file carries VP_BEGINDATE values that are mistyped at the source,
 * e.g. "21.12.2209 00:00:00" (proceeding 5713939), "25.05.5005" (849872) or
 * "29.07.8209" (14053256). Which digit is wrong cannot be told from the value,
 * so out-of-range dates are dropped (NULL) instead of being "repaired".
 */

/**
 * Earliest opening date kept. The few earlier values in the file (1958, 1987,
 * 1989) are typos as well; Ukrainian enforcement proceedings start in the 1990s.
 */
export const MIN_OPENING_DATE = '1990-01-01';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Latest opening date kept: tomorrow (UTC), so a proceeding opened today in
 * Kyiv time is never dropped. An opening date cannot lie in the future.
 */
export function maxOpeningDate(now: Date = new Date()): string {
  return isoDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

/**
 * "dd.mm.yyyy[ HH:MM:SS]" -> "yyyy-mm-dd", or null when the value is empty,
 * malformed, not a real calendar date, or outside
 * [MIN_OPENING_DATE, maxOpeningDate(now)].
 */
export function parseOpeningDate(raw: string | null | undefined, now: Date = new Date()): string | null {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s|$)/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const iso = `${yyyy}-${mm}-${dd}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || isoDate(d) !== iso) return null; // 31.02, 00.13 ...
  if (iso < MIN_OPENING_DATE || iso > maxOpeningDate(now)) return null;
  return iso;
}

/**
 * SQL for opening_date with implausible values hidden, for rows imported
 * before the fix. Used both in the SELECT list and in ORDER BY so such rows
 * sort with the undated ones (NULLS LAST) instead of first.
 */
export const PLAUSIBLE_OPENING_DATE_SQL =
  `CASE WHEN ep.opening_date >= DATE '${MIN_OPENING_DATE}' AND ep.opening_date <= CURRENT_DATE + 1 ` +
  `THEN ep.opening_date END`;
