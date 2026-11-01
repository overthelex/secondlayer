/**
 * Swap guards for import-court-case-status.ts (LEXAI-2182).
 *
 * The ДСА ZIP of 31.10.2026 shipped 26 files / 1,301,925 rows instead of 30 / 1,461,483:
 * Касаційний господарський суд went 328 → 0 rows and Касаційний адміністративний суд
 * 1,147 → 1. The only guard then was «snapshot ≥ 80% of the table», which passed because
 * the table held 1,249,720 rows, so a partial export replaced the table. The checks below
 * compare the snapshot with the table per court and with the last successful load, and the
 * importer refuses the swap when any of them fails (unless --force).
 *
 * Rule per court (current = rows in the table, next = rows in the snapshot):
 *   * vanished: current ≥ MIN_ROWS_VANISHED and next = 0;
 *   * dropped:  current ≥ MIN_ROWS_DROP and next < current × (1 − MAX_COURT_DROP).
 * A court with fewer than MIN_ROWS_VANISHED rows may disappear (renamed or merged court,
 * a few stray rows); a court with fewer than MIN_ROWS_DROP rows is too small for a
 * percentage to mean much, but it is still caught when it vanishes entirely.
 */

import { isCalendarDate } from './court-case-status-dates.js';

/** Refuse a snapshot much smaller than the table: a truncated download. */
export const MIN_SNAPSHOT_RATIO = 0.8;
/** A court with at least this many rows in the table must not vanish from the snapshot. */
export const MIN_ROWS_VANISHED = 10;
/** A court with at least this many rows in the table is checked for a relative drop. */
export const MIN_ROWS_DROP = 50;
/** Largest tolerated relative drop of one court's row count (0.5 = half its rows). */
export const MAX_COURT_DROP = 0.5;

export interface CourtCountProblem {
  court: string;
  current: number;
  next: number;
  kind: 'vanished' | 'dropped';
}

export interface CourtCountOptions {
  minRowsVanished?: number;
  minRowsDrop?: number;
  maxDrop?: number;
}

/** Courts whose row count vanishes or drops too far between the table and the snapshot. */
export function compareCourtCounts(
  current: Map<string, number>,
  next: Map<string, number>,
  opts: CourtCountOptions = {},
): CourtCountProblem[] {
  const minVanished = opts.minRowsVanished ?? MIN_ROWS_VANISHED;
  const minDrop = opts.minRowsDrop ?? MIN_ROWS_DROP;
  const maxDrop = opts.maxDrop ?? MAX_COURT_DROP;
  const problems: CourtCountProblem[] = [];
  for (const [court, cur] of current) {
    const n = next.get(court) || 0;
    if (n === 0 && cur >= minVanished) {
      problems.push({ court, current: cur, next: 0, kind: 'vanished' });
    } else if (cur >= minDrop && n < cur * (1 - maxDrop)) {
      problems.push({ court, current: cur, next: n, kind: 'dropped' });
    }
  }
  return problems.sort((a, b) => b.current - a.current);
}

export interface LoadRecord { fileCount: number; totalRows: number; sourceName: string | null }

export interface SnapshotGuardInput {
  /** Per-court row counts in the table now. */
  current: Map<string, number>;
  /** Per-court row counts in the parsed snapshot. */
  next: Map<string, number>;
  /** CSV files read from the snapshot. */
  fileCount: number;
  /** The last successful load, or null when none is recorded. */
  lastLoad: LoadRecord | null;
}

export interface SnapshotGuardResult { ok: boolean; problems: string[] }

/** Every reason to refuse the swap, as log lines; ok when there is none. */
export function evaluateSnapshotGuards(input: SnapshotGuardInput, opts: CourtCountOptions = {}): SnapshotGuardResult {
  const problems: string[] = [];
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const curRows = sum(input.current);
  const nextRows = sum(input.next);
  if (nextRows < curRows * MIN_SNAPSHOT_RATIO) {
    problems.push(`snapshot has ${nextRows} rows, table has ${curRows} (< ${MIN_SNAPSHOT_RATIO * 100}%)`);
  }
  const last = input.lastLoad;
  if (last && input.fileCount < last.fileCount) {
    problems.push(`snapshot has ${input.fileCount} files, last successful load` +
      `${last.sourceName ? ` (${last.sourceName})` : ''} had ${last.fileCount}`);
  }
  for (const p of compareCourtCounts(input.current, input.next, opts)) {
    const name = p.court || '(без назви суду)';
    problems.push(p.kind === 'vanished'
      ? `${name}: ${p.current} → 0 rows (vanished)`
      : `${name}: ${p.current} → ${p.next} rows (−${Math.round((1 - p.next / p.current) * 100)}%)`);
  }
  return { ok: problems.length === 0, problems };
}

/** Snapshot date from «stan-rozglyadu-sprav-vid-DD-MM-YYYY.zip» as YYYY-MM-DD, else null. */
export function snapshotDateFromName(name: string): string | null {
  const m = /(\d{2})[-.](\d{2})[-.](\d{4})(?!.*\d{2}[-.]\d{2}[-.]\d{4})/.exec(name);
  if (!m || !isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}
