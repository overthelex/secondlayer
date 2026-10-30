import type { RegistryConfig } from '../config/registries';

/**
 * Prefix of the surrogate value the importers write into an empty unique-key
 * column so a row still has a value for ON CONFLICT. It is an internal key,
 * never registry data, and must not reach API output.
 */
export const SYNTHETIC_KEY_PREFIX = 'gen_';

/** True for an importer-generated surrogate key such as "gen_4355". */
export function isSyntheticKey(value: unknown): boolean {
  return typeof value === 'string' && /^gen_\d+$/.test(value);
}

/**
 * Fill empty unique-key columns of a mapped row with a `gen_<n>` surrogate,
 * except the columns the registry lists in `nullableKeyColumns`: those carry
 * real registry data (e.g. a debtor's EDRPOU) and stay NULL when absent.
 */
export function fillMissingUniqueKeys(
  config: RegistryConfig,
  mapped: Record<string, unknown>,
  fallbackIndex: number
): void {
  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
  const nullable = config.nullableKeyColumns ?? [];
  for (const key of uniqueKeys) {
    if (nullable.includes(key)) continue;
    if (!mapped[key] && mapped[key] !== 0) {
      mapped[key] = `${SYNTHETIC_KEY_PREFIX}${fallbackIndex}`;
    }
  }
}

/**
 * SQL predicate that is true when `column` does not hold a `gen_<n>` surrogate.
 * Drops legacy surrogate rows that duplicate a row with the real key
 * (LEXAI-2129). The column name comes from code, never from user input.
 */
export function notSyntheticSql(column: string): string {
  return `${column} !~ '^gen_[0-9]+$'`;
}

/**
 * Copy of an output row in which each listed column holding a `gen_<n>`
 * surrogate is reported as null (LEXAI-2129, same rule as formatDebtorRow).
 */
export function nullSyntheticKeys<T extends Record<string, unknown>, K extends keyof T & string>(
  row: T,
  columns: readonly K[]
): Omit<T, K> & { [P in K]: T[P] | null } {
  const out: Record<string, unknown> = { ...row };
  for (const col of columns) {
    if (isSyntheticKey(out[col])) out[col] = null;
  }
  return out as Omit<T, K> & { [P in K]: T[P] | null };
}
