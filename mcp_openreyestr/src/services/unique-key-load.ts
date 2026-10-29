import type { RegistryConfig } from '../config/registries';

/**
 * Helpers for "huge" registries that are reloaded via TRUNCATE but must keep
 * their natural key unique (RegistryConfig.upsertOnReload, LEXAI-2130).
 *
 * The plain TRUNCATE+INSERT path drops every index, inserts the file as is and
 * recreates the indexes afterwards. A source file with duplicate key rows then
 * makes the UNIQUE recreate fail, after which the table silently stays without
 * the constraint (that is how prod debtors lost UNIQUE from migration 004).
 * With upsertOnReload the key index stays in place during the load and every
 * batch is inserted with ON CONFLICT (key) DO UPDATE.
 */

export function uniqueKeyColumns(config: RegistryConfig): string[] {
  return Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
}

/**
 * Column list of a `CREATE [UNIQUE] INDEX ... (a, b, c) ...` definition as
 * returned by pg_indexes.indexdef, or null for expression indexes.
 */
export function indexDefColumns(indexdef: string): string[] | null {
  const m = indexdef.match(/\bUSING\s+\w+\s*\(([^()]+)\)/i) ?? indexdef.match(/\(([^()]+)\)/);
  if (!m) return null;
  const cols = m[1].split(',').map(c => c.trim().replace(/^"(.*)"$/, '$1'));
  if (cols.some(c => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c))) return null;
  return cols;
}

/** True when indexdef is a non-partial UNIQUE index on exactly the key columns. */
export function isUniqueKeyIndex(indexdef: string, keyColumns: string[]): boolean {
  if (!/^CREATE\s+UNIQUE\s+INDEX\b/i.test(indexdef)) return false;
  if (/\)\s*(NULLS\s+(NOT\s+)?DISTINCT\s*)?WHERE\b/i.test(indexdef)) return false;
  const cols = indexDefColumns(indexdef);
  return !!cols && cols.length === keyColumns.length && cols.every((c, i) => c === keyColumns[i]);
}

/**
 * Dedupe key for a mapped row. NULL and '' are kept apart, and NULLs compare
 * equal, matching a UNIQUE NULLS NOT DISTINCT index.
 */
export function rowKey(mapped: Record<string, unknown>, keyColumns: string[]): string {
  return keyColumns
    .map(k => (mapped[k] === null || mapped[k] === undefined ? '\u0000' : `=${String(mapped[k])}`))
    .join('\u0001');
}

/**
 * Collapse rows with the same key (the last occurrence wins, as an upsert
 * would leave it) and order them by key. One INSERT ... ON CONFLICT DO UPDATE
 * cannot touch a row twice, and a stable key order across parallel batches
 * makes their row locks always taken in the same order (no deadlocks).
 */
export function dedupeAndSortByKey<T>(
  rows: T[],
  keyOf: (row: T) => string
): { rows: T[]; duplicates: number } {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    byKey.set(keyOf(row), row);
  }
  const keys = [...byKey.keys()].sort();
  return { rows: keys.map(k => byKey.get(k)!), duplicates: rows.length - byKey.size };
}
