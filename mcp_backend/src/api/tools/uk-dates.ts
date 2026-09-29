/**
 * node-postgres turns a DATE column into a JS Date at LOCAL midnight. JSON.stringify then
 * writes it in UTC, so under British Summer Time 2016-04-06 comes out as
 * "2016-04-05T23:00:00.000Z" and a point-in-time answer names the wrong day. The UK tools
 * therefore turn every such value back into the calendar day it came from before replying.
 *
 * Only a Date that sits exactly on local midnight is treated as a DATE; anything with a time
 * of day (a real timestamp) is left alone.
 */

function isLocalMidnight(d: Date): boolean {
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

function toDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Deep copy of `value` with every DATE-valued Date replaced by its YYYY-MM-DD string. */
export function datesToDays<T>(value: T): T {
  if (value instanceof Date) {
    return (Number.isNaN(value.getTime()) || !isLocalMidnight(value) ? value : toDay(value)) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => datesToDays(v)) as unknown as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = datesToDays(v);
    return out as T;
  }
  return value;
}
