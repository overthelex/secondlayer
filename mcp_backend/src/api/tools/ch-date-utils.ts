/**
 * Shared ISO-date validation for the Swiss (CH) tool handlers.
 *
 * A bare regex like /^\d{4}-\d{2}-\d{2}$/ accepts calendar-invalid dates such as
 * 2024-02-31 or 2025-13-01 — it checks shape, not validity. isValidIsoDate additionally
 * round-trips the parsed components through Date.UTC and confirms they come back
 * unchanged, which catches day/month overflow that Date silently normalizes away.
 */

const DATE_SHAPE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(value: string): boolean {
  const match = DATE_SHAPE_RE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
