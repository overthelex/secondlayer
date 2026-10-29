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
