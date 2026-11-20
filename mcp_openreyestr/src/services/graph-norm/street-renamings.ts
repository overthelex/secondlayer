/**
 * Old -> current street names for address keys (LEXAI-2302).
 *
 * buildStreetRenamingIndex(rows) is pure: the rows say "this street, now `currentName`, was once
 * each of `oldNames`", optionally within one settlement (an address.ts settlementKey). The index
 * answers lookup(settlementKey, type, core) with the current street, so 'вул. Леніна, 5' in an
 * old dump and 'вул. Соборна, 5' now give one addressKey.
 *
 * Settlement-scoped rows are always used. Rows without a settlement (the OpenStreetMap import in
 * street_renamings has none: osm_id, current_name, old_names) say nothing about which town
 * renamed what: 'вулиця Гагаріна' has 415 different current names there. They are used only with
 * { global: true }, and then only for an old name that every row maps to the same current name
 * and that is nobody's current name, so 'вулиця Леніна' stays as written.
 *
 * StreetRenamingsCache loads the tables once (TTL, default 24 h) for the runtime: the
 * settlement-scoped street_renamings_scoped (LEXAI-2309: derived from ЄДР address history, plus
 * 'osm' / 'manual' rows) is on by default, the global OSM table only with { global: true }. An
 * index from the cache passed to normAddress therefore applies scoped renamings only.
 */
import { parseStreetName, STREET_SHORT, streetCoreKey, StreetRef, StreetRenamingLookup, StreetType } from './address';

export interface StreetRenamingRow {
  currentName: string;
  oldNames: string[];
  /** settlementKey (address.ts) of the street; null when the source does not know it */
  settlementKey?: string | null;
}

export interface BuildRenamingOptions {
  /** use rows without a settlement for unambiguous old names (default false) */
  global?: boolean;
}

export interface RenamingIndexStats {
  rows: number;
  /** names without a street-type word, read as 'вулиця' */
  untyped: number;
  scoped: number;
  global: number;
  /** old names left out: several current names, or the old name is also a current one */
  ambiguous: number;
}

/**
 * The settlement part of a renaming key: a city's settlementKey as is; a village / смт key with
 * its postcode cut to the first three digits ('UA-18|н|народичи|11400' -> '...|114'), since a
 * village's postcode often changed with the reform (11400 -> 11401) and its streets did not.
 */
export function renamingSettlementKey(settlementKey: string): string {
  const p = settlementKey.split('|');
  return p.length === 4 && p[1] === 'н' ? `${p[0]}|н|${p[2]}|${p[3].slice(0, 3)}` : settlementKey;
}

const idOf = (r: StreetRef) => `${STREET_SHORT[r.type]}|${streetCoreKey(r.name)}`;

function readName(s: string, stats: RenamingIndexStats): StreetRef | null {
  if (!s || !s.trim()) return null;
  const r = parseStreetName(s);
  if (r) return r;
  stats.untyped++;
  return parseStreetName(`вулиця ${s}`);
}

export class StreetRenamingIndex implements StreetRenamingLookup {
  constructor(
    private readonly scoped: Map<string, StreetRef>,
    private readonly global: Map<string, StreetRef>,
    readonly stats: RenamingIndexStats,
  ) {}

  lookup(settlementKey: string | null, type: StreetType, core: string): StreetRef | null {
    const id = `${STREET_SHORT[type]}|${core}`;
    if (settlementKey) {
      const s = this.scoped.get(`${renamingSettlementKey(settlementKey)}#${id}`);
      if (s) return s;
    }
    return this.global.get(id) ?? null;
  }

  get size(): number { return this.scoped.size + this.global.size; }
}

export function buildStreetRenamingIndex(rows: Iterable<StreetRenamingRow>, opts: BuildRenamingOptions = {}): StreetRenamingIndex {
  const stats: RenamingIndexStats = { rows: 0, untyped: 0, scoped: 0, global: 0, ambiguous: 0 };
  const scoped = new Map<string, Map<string, StreetRef>>(); // key -> current id -> ref
  const global = new Map<string, Map<string, StreetRef>>();
  const currentIds = new Set<string>();

  for (const row of rows) {
    stats.rows++;
    const cur = readName(row.currentName, stats);
    if (!cur) continue;
    const curId = idOf(cur);
    if (!row.settlementKey) currentIds.add(curId);
    if (!row.settlementKey && !opts.global) continue;
    for (const o of row.oldNames || []) {
      const old = readName(o, stats);
      if (!old) continue;
      const oldId = idOf(old);
      if (oldId === curId) continue; // a spelling change only: the keys already agree
      const [map, key] = row.settlementKey ? [scoped, `${renamingSettlementKey(row.settlementKey)}#${oldId}`] : [global, oldId];
      let m = map.get(key);
      if (!m) map.set(key, (m = new Map()));
      m.set(curId, cur);
    }
  }

  const pick = (src: Map<string, Map<string, StreetRef>>, isGlobal: boolean) => {
    const out = new Map<string, StreetRef>();
    for (const [key, curs] of src) {
      if (curs.size !== 1 || (isGlobal && currentIds.has(key))) { stats.ambiguous++; continue; }
      out.set(key, curs.values().next().value as StreetRef);
    }
    return out;
  };
  const s = pick(scoped, false);
  const g = pick(global, true);
  stats.scoped = s.size;
  stats.global = g.size;
  return new StreetRenamingIndex(s, g, stats);
}

// ---------------------------------------------------------------- runtime loader

export interface Queryable {
  query(sql: string): Promise<{ rows: any[] }>;
}

export const STREET_RENAMINGS_SQL =
  'SELECT COALESCE(current_name_uk, current_name) AS current_name, old_names FROM street_renamings';

/** One row per (settlement, old street): a 'manual' row wins over 'edr_history', which wins over 'osm'. */
export const STREET_RENAMINGS_SCOPED_SQL = `SELECT DISTINCT ON (settlement_key, old_street_key)
    settlement_key, old_name_sample, current_name_sample
  FROM street_renamings_scoped
  ORDER BY settlement_key, old_street_key,
    CASE source WHEN 'manual' THEN 0 WHEN 'edr_history' THEN 1 ELSE 2 END`;

export interface StreetRenamingsCacheOptions extends BuildRenamingOptions {
  ttlMs?: number;             // default 24 h
  /** load street_renamings_scoped (default true) */
  scoped?: boolean;
  /** settlement-scoped rows from another source, merged with the tables */
  extraRows?: () => Promise<StreetRenamingRow[]> | StreetRenamingRow[];
}

/** street_renamings_scoped rows -> index rows */
export function scopedRowsOf(rows: any[]): StreetRenamingRow[] {
  return rows
    .filter((r) => r.settlement_key && r.old_name_sample && r.current_name_sample)
    .map((r) => ({ currentName: String(r.current_name_sample), oldNames: [String(r.old_name_sample)], settlementKey: String(r.settlement_key) }));
}

/** One in-memory index per process, reloaded after the TTL; concurrent callers share one load. */
export class StreetRenamingsCache {
  private index: StreetRenamingIndex | null = null;
  private loadedAt = 0;
  private pending: Promise<StreetRenamingIndex> | null = null;

  constructor(private readonly db: Queryable, private readonly opts: StreetRenamingsCacheOptions = {}) {}

  async get(): Promise<StreetRenamingIndex> {
    const ttl = this.opts.ttlMs ?? 24 * 3600 * 1000;
    if (this.index && Date.now() - this.loadedAt < ttl) return this.index;
    if (!this.pending) {
      this.pending = this.load().then((idx) => {
        this.index = idx;
        this.loadedAt = Date.now();
        return idx;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  invalidate(): void {
    this.index = null;
    this.loadedAt = 0;
  }

  private async load(): Promise<StreetRenamingIndex> {
    const rows: StreetRenamingRow[] = [];
    if (this.opts.scoped !== false) {
      try {
        rows.push(...scopedRowsOf((await this.db.query(STREET_RENAMINGS_SCOPED_SQL)).rows));
      } catch (e: any) {
        if (e?.code !== '42P01') throw e; // migration 029 not applied yet: no scoped rows
      }
    }
    if (this.opts.global) {
      const res = await this.db.query(STREET_RENAMINGS_SQL);
      rows.push(...res.rows.map((r) => ({
        currentName: String(r.current_name ?? ''),
        oldNames: Array.isArray(r.old_names) ? r.old_names.map(String) : [],
        settlementKey: null,
      })));
    }
    if (this.opts.extraRows) rows.push(...(await this.opts.extraRows()));
    return buildStreetRenamingIndex(rows, { global: this.opts.global });
  }
}
