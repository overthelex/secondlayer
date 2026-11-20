/**
 * Settlement-scoped street renamings from OpenStreetMap (LEXAI-2316).
 * Source data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright);
 * the rows derived here (street_renamings_scoped, source='osm') are a derivative database under
 * ODbL and must keep that attribution wherever they are shown.
 *
 * Input: the files of scripts/osm/extract_osm_streets.py (a Geofabrik Ukraine dump read once):
 * settlement areas and place nodes with their tags, and highway ways that carry a former name
 * (old_name, old_name:uk / :ru, date-qualified old_name:1936-2016 and name:1920-1991 keys,
 * was:name) with the areas containing them. Everything here is pure, so it is tested on
 * synthetic fixtures; scripts/import-osm-street-renamings.ts only reads files and the DB.
 *
 *  1. settlementOf(): the smallest settlement area (place=city/town/village/hamlet, or an
 *     administrative boundary of a settlement level) containing the street; without one, the
 *     nearest place node within a radius that depends on its kind. The settlement key is
 *     address.ts settlementKeyOf + renamingSettlementKey: oblast from the containing admin_level 4
 *     area (ISO3166-2), 'м' for a city (name:prefix 'місто', else place=city/town), otherwise a
 *     village key with the first three postcode digits (the area's / node's postcode tag, else the
 *     dominant prefix of addr:postcode inside the area). Villages without a postcode are skipped.
 *  2. osmPairs(): current name = name:uk, else name; each former name (split on ';') parsed with
 *     the address parser; a former name that is only a spelling / language variant of the current
 *     one (sameStreetName) is not a renaming.
 *  3. OsmRenamingAggregator: one row per (settlement, old street) when all ways agree on the
 *     current street (else ambiguous), and the old name is not also the current name of another
 *     street of that settlement (a name moved to another street: rewriting it would break the
 *     current addresses).
 */
import { oblastFromPostcode, parseStreetName, prepText, settlementKeyOf, StreetRef } from './address';
import { renamingSettlementKey } from './street-renamings';
import { sameStreetName, streetKeyOf } from './street-renaming-derive';

export type Tags = Record<string, string>;

export interface OsmArea {
  id: number;
  tags: Tags;
  km2: number;
  /** addr:postcode values inside the area -> count */
  pc5?: Record<string, number>;
}

export interface OsmPlace {
  id: number;
  tags: Tags;
  lon: number;
  lat: number;
  /** ids of the areas containing the node */
  areas: number[];
}

export interface OsmStreet {
  id: number;
  tags: Tags;
  lon?: number;
  lat?: number;
  areas: number[];
  /** [place node id, metres], nearest first */
  near?: Array<[number, number]>;
}

export interface OsmSettlement {
  /** renamingSettlementKey */
  key: string;
  name: string;
  kind: 'м' | 'н';
  oblastCode: string;
  postcode: string | null;
  /** 'area' (inside a settlement polygon) or 'node' (nearest place node) */
  how: 'area' | 'node';
  sourceId: number;
}

export const SETTLEMENT_PLACES = new Set(['city', 'town', 'village', 'hamlet']);
/** fallback radius around a place node, metres */
export const NEAR_RADIUS: Record<string, number> = { city: 6000, town: 3000, village: 1500, hamlet: 800 };

const CITY_PREFIX = /^(?:місто|м\.?|город)$/;
const VILLAGE_PREFIX = /^(?:село|с\.?|селище|селище міського типу|смт|хутір|поселок|посёлок|селище сільського типу)$/;
const ISO_UA = /^UA-\d\d$/;
const PC = /^\d{5}$/;

const nameOf = (t: Tags): string | null => (t['name:uk'] || t.name || '').trim() || null;
const firstPostcode = (v: string | undefined): string | null => {
  for (const x of (v ?? '').split(/[;,\s-]+/)) if (PC.test(x)) return x;
  return null;
};

/** 'м' / 'н' from name:prefix, else the place tag. */
export function settlementKind(tags: Tags): 'м' | 'н' | null {
  const prefix = (tags['name:prefix:uk'] || tags['name:prefix'] || '').trim().toLowerCase();
  if (prefix) {
    if (CITY_PREFIX.test(prefix)) return 'м';
    if (VILLAGE_PREFIX.test(prefix)) return 'н';
  }
  const place = tags.place;
  if (place === 'city' || place === 'town') return 'м';
  if (place === 'village' || place === 'hamlet') return 'н';
  return null;
}

/** The dominant postcode of an area when one 3-digit prefix holds at least `share` of the counts. */
export function dominantPostcode(pc5: Record<string, number> | undefined, share = 0.6, min = 2): string | null {
  if (!pc5) return null;
  const by3 = new Map<string, number>();
  let total = 0;
  for (const [pc, n] of Object.entries(pc5)) {
    if (!PC.test(pc)) continue;
    by3.set(pc.slice(0, 3), (by3.get(pc.slice(0, 3)) ?? 0) + n);
    total += n;
  }
  if (!total) return null;
  const [p3, n3] = [...by3.entries()].sort((a, b) => b[1] - a[1])[0];
  if (n3 < min || n3 / total < share) return null;
  const best = Object.entries(pc5).filter(([pc]) => pc.startsWith(p3)).sort((a, b) => b[1] - a[1])[0][0];
  return best;
}

export interface SettlementIndexOptions {
  /**
   * admin_level values of named boundary=administrative areas without a place tag that are taken as
   * settlements (default none: in the Ukraine extract such level-8 areas are Crimean 'сельское
   * поселение' and Polish gminy; settlement boundaries carry place=*)
   */
  settlementAdminLevels?: string[];
}

/** Areas, place nodes and their oblasts: answers settlementOf(street). */
export class OsmSettlementIndex {
  private readonly areas = new Map<number, OsmArea>();
  private readonly places = new Map<number, OsmPlace>();
  /** settlement area id -> place node inside it with the same name */
  private readonly areaNode = new Map<number, OsmPlace>();
  private readonly adminLevels: Set<string>;
  readonly stats = { areas: 0, settlementAreas: 0, places: 0, linkedNodes: 0 };

  constructor(areas: Iterable<OsmArea>, places: Iterable<OsmPlace>, opts: SettlementIndexOptions = {}) {
    this.adminLevels = new Set(opts.settlementAdminLevels ?? []);
    for (const a of areas) {
      this.areas.set(a.id, a);
      this.stats.areas++;
      if (this.isSettlementArea(a)) this.stats.settlementAreas++;
    }
    for (const p of places) {
      this.places.set(p.id, p);
      this.stats.places++;
      const nm = nameOf(p.tags);
      if (!nm) continue;
      for (const id of p.areas) {
        const a = this.areas.get(id);
        if (a && this.isSettlementArea(a) && nameOf(a.tags) && prepText(nameOf(a.tags) as string) === prepText(nm)) {
          if (!this.areaNode.has(id)) { this.areaNode.set(id, p); this.stats.linkedNodes++; }
        }
      }
    }
  }

  isSettlementArea(a: OsmArea): boolean {
    if (SETTLEMENT_PLACES.has(a.tags.place)) return true;
    return a.tags.boundary === 'administrative' && this.adminLevels.has(a.tags.admin_level) && !a.tags.place && !!nameOf(a.tags);
  }

  /** ISO 3166-2 of the smallest admin_level 4 area containing the given areas (Kyiv inside Kyiv oblast). */
  oblastOf(areaIds: number[]): string | null {
    let best: OsmArea | null = null;
    for (const id of areaIds) {
      const a = this.areas.get(id);
      if (a && a.tags.admin_level === '4' && a.tags.boundary === 'administrative' && ISO_UA.test(a.tags['ISO3166-2'] ?? '')) {
        if (!best || a.km2 < best.km2) best = a;
      }
    }
    return best ? best.tags['ISO3166-2'] : null;
  }

  /** The settlement of a street, or null with the reason. */
  settlementOf(s: Pick<OsmStreet, 'areas' | 'near'>): { settlement: OsmSettlement | null; reason: string } {
    const cands = s.areas.map((id) => this.areas.get(id)).filter((a): a is OsmArea => !!a && this.isSettlementArea(a))
      .sort((a, b) => a.km2 - b.km2);
    const oblast = this.oblastOf(s.areas);
    for (const a of cands) {
      const node = this.areaNode.get(a.id);
      const tags: Tags = { ...(node?.tags ?? {}), ...a.tags };
      if (!tags.place && node?.tags.place) tags.place = node.tags.place;
      if (!tags['name:prefix'] && node?.tags['name:prefix']) tags['name:prefix'] = node.tags['name:prefix'];
      const pc = firstPostcode(a.tags['addr:postcode']) ?? firstPostcode(a.tags.postal_code)
        ?? firstPostcode(node?.tags['addr:postcode']) ?? firstPostcode(node?.tags.postal_code) ?? dominantPostcode(a.pc5);
      const r = this.make(tags, oblast, pc, 'area', a.id);
      // an unnamed / untyped polygon says nothing: try the next larger one; any other answer is final
      if (r.settlement || (r.reason !== 'no_name' && r.reason !== 'no_kind')) return r;
    }
    for (const [id, dist] of s.near ?? []) {
      const p = this.places.get(id);
      if (!p || !SETTLEMENT_PLACES.has(p.tags.place)) continue;
      if (dist > (NEAR_RADIUS[p.tags.place] ?? 0)) continue;
      // the node's own oblast: the street may lie across an oblast border from it
      const ob = this.oblastOf(p.areas) ?? oblast;
      const pc = firstPostcode(p.tags['addr:postcode']) ?? firstPostcode(p.tags.postal_code)
        ?? this.nodeAreaPostcode(p);
      return this.make(p.tags, ob, pc, 'node', p.id);
    }
    return { settlement: null, reason: 'no_settlement' };
  }

  private nodeAreaPostcode(p: OsmPlace): string | null {
    for (const id of p.areas) {
      const a = this.areas.get(id);
      if (a && this.isSettlementArea(a)) return dominantPostcode(a.pc5);
    }
    return null;
  }

  private make(tags: Tags, oblast: string | null, pc: string | null, how: 'area' | 'node', sourceId: number) {
    const name = nameOf(tags);
    if (!name) return { settlement: null, reason: 'no_name' };
    const kind = settlementKind(tags);
    if (!kind) return { settlement: null, reason: 'no_kind' };
    const oblastCode = oblast ?? oblastFromPostcode(pc);
    if (!oblastCode) return { settlement: null, reason: 'no_oblast' };
    if (pc && oblastFromPostcode(pc) !== oblastCode) pc = null; // a postcode from another oblast
    if (kind === 'н' && !pc) return { settlement: null, reason: 'village_no_postcode' };
    const settlement = prepText(name).replace(/\s*-\s*/g, '-');
    const sk = settlementKeyOf({ oblastCode, settlementType: kind === 'м' ? 'місто' : 'село', settlement, postcode: pc });
    if (!sk) return { settlement: null, reason: 'no_name' };
    return {
      settlement: { key: renamingSettlementKey(sk), name: settlement, kind, oblastCode, postcode: pc, how, sourceId },
      reason: 'ok',
    };
  }
}

// ---------------------------------------------------------------- street names

/**
 * Tags whose value is a former name of the street: old_name, old_name:uk, old_name:ru, with an
 * optional date part in either order (old_name:uk:1936-2016, old_name:-2023-12-18, old_name:2016:uk),
 * was:name. Other languages (old_name:en, :pl, :uk-Latn) are translations of these; not:name (a name
 * the street does NOT have) and name:etymology are not former names.
 */
export const FORMER_NAME_KEY = /^(?:old_name|was:name)((?::(?:uk|ru|-{0,2}\d{4}(?:-\d\d){0,2}(?:-\d{4}(?:-\d\d){0,2})?))*)$/;
const DATE_PART = /^-{0,2}\d{4}/;

/** The last year in a former-name key's date part ('old_name:uk:1936-2016' -> 2016), else null. */
export function formerNameUntil(key: string): number | null {
  const parts = key.split(':').filter((p) => DATE_PART.test(p));
  if (!parts.length) return null;
  const years = parts.join('-').match(/\d{4}/g);
  return years ? Number(years[years.length - 1]) : null;
}

export interface StreetName {
  ref: StreetRef;
  key: string;
  /** '<street type> <name>' in the parser's lower-case spelling; parses back to `key` */
  sample: string;
}

// type words the address parser reads only before the name; OSM writes them after it
// ('1-й Кутаїський в'їзд', 'Суворовская аллея')
const TRAILING_TYPE = /^(.+?)\s+(вїзд|въезд|узвіз|спуск|проїзд|проезд|шоссе|аллея|набережная|площадь|тупик|бульвар|проспект|майдан)$/;

export function readStreetName(s: string, defaultType: StreetRef['type'] = 'вулиця'): StreetName | null {
  const v = s.trim();
  if (!v || !/[а-яіїєґё]/i.test(v)) return null; // Latin transliterations are never in ЄДР
  const t = prepText(v).replace(/[,\s]+$/, '');
  const trailing = t.match(TRAILING_TYPE);
  const ref = parseStreetName(v) ?? (trailing ? parseStreetName(`${trailing[2]} ${trailing[1]}`) : null)
    ?? parseStreetName(`${defaultType} ${v}`);
  if (!ref || !/[а-яіїєґ]/.test(ref.name)) return null;
  // a note in brackets is not part of the name
  const name = ref.name.replace(/\([^)]*\)?/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  const key = streetKeyOf(ref.type, name);
  if (/^[^|]+\|\d*$/.test(key)) return null; // a bare number
  const sample = `${ref.type} ${name}`;
  const back = parseStreetName(sample);
  if (!back || streetKeyOf(back.type, back.name) !== key) return null;
  return { ref: { type: ref.type, name }, key, sample };
}

export interface OsmPair {
  current: StreetName;
  old: StreetName;
  tag: string;
  /** formerNameUntil of the tag, or of a dated tag with the same old name */
  until: number | null;
}

/** Former names that ended before this year are left out: no ЄДР address (1990s on) carries them. */
export const MIN_UNTIL = 1991;

/**
 * Former-name -> current-name pairs of one way. Spelling / language variants of the current name
 * and names a dated tag puts before MIN_UNTIL are dropped.
 */
export function osmPairs(tags: Tags): { current: StreetName | null; pairs: OsmPair[]; variants: number } {
  const curRaw = (tags['name:uk'] || tags.name || '').trim();
  const current = curRaw ? readStreetName(curRaw) : null;
  if (!current) return { current: null, pairs: [], variants: 0 };
  const byKey = new Map<string, OsmPair>();
  let variants = 0;
  for (const [k, v] of Object.entries(tags)) {
    if (!FORMER_NAME_KEY.test(k)) continue;
    const until = formerNameUntil(k);
    for (const part of v.split(';')) {
      const old = readStreetName(part, current.ref.type);
      if (!old || old.key === current.key) continue;
      const seen = byKey.get(old.key);
      if (seen) {
        if (until !== null && (seen.until === null || until > seen.until)) seen.until = until;
        continue;
      }
      const oc = old.key.split('|')[1];
      const cc = current.key.split('|')[1];
      if (sameStreetName(oc, cc)) { variants++; byKey.set(old.key, { current, old, tag: k, until: null }); continue; }
      byKey.set(old.key, { current, old, tag: k, until });
    }
  }
  const pairs = [...byKey.values()].filter((p) => !sameStreetName(p.old.key.split('|')[1], current.key.split('|')[1])
    && (p.until === null || p.until >= MIN_UNTIL));
  return { current, pairs, variants };
}

// ---------------------------------------------------------------- aggregation

export interface OsmRenamingRow {
  settlementKey: string;
  oldKey: string;
  oldName: string;
  currentKey: string;
  currentName: string;
  /** OSM ways that carry the pair */
  ways: number;
  how: 'area' | 'node';
  tags: string[];
  /** a sample way id, for checking on openstreetmap.org */
  wayId: number;
  /** the latest year a dated former-name tag gives (old_name:uk:1936-2016 -> 2016), else null */
  until: number | null;
}

export interface OsmAggregateStats {
  ways: number;
  pairs: number;
  oldNames: number;
  ambiguous: number;
  /** old name is still the current name of another street in the settlement */
  stillCurrent: number;
  kept: number;
}

interface Edge {
  ways: number; currentName: string; how: Set<'area' | 'node'>; tags: Set<string>; wayId: number;
  oldNames: Map<string, number>; until: number | null;
}

export class OsmRenamingAggregator {
  private readonly edges = new Map<string, Map<string, Edge>>(); // settlement#old -> current -> edge
  /** settlement -> current street keys of every named way */
  private readonly current = new Map<string, Set<string>>();
  private ways = 0;

  /** A way's current name (also for ways without a former name). */
  addCurrent(settlementKey: string, currentKey: string): void {
    let s = this.current.get(settlementKey);
    if (!s) this.current.set(settlementKey, (s = new Set()));
    s.add(currentKey);
  }

  add(settlementKey: string, wayId: number, how: 'area' | 'node', pairs: OsmPair[]): void {
    this.ways++;
    for (const p of pairs) {
      this.addCurrent(settlementKey, p.current.key);
      const k = `${settlementKey}#${p.old.key}`;
      let m = this.edges.get(k);
      if (!m) this.edges.set(k, (m = new Map()));
      let e = m.get(p.current.key);
      if (!e) m.set(p.current.key, (e = { ways: 0, currentName: p.current.sample, how: new Set(), tags: new Set(), wayId, oldNames: new Map(), until: null }));
      e.ways++;
      if (p.until !== null && (e.until === null || p.until > e.until)) e.until = p.until;
      e.how.add(how);
      e.tags.add(p.tag);
      e.oldNames.set(p.old.sample, (e.oldNames.get(p.old.sample) ?? 0) + 1);
    }
  }

  rows(): { rows: OsmRenamingRow[]; stats: OsmAggregateStats } {
    const stats: OsmAggregateStats = { ways: this.ways, pairs: 0, oldNames: this.edges.size, ambiguous: 0, stillCurrent: 0, kept: 0 };
    const picked = new Map<string, OsmRenamingRow>();
    for (const [k, m] of this.edges) {
      stats.pairs += m.size;
      const [settlementKey, oldKey] = k.split('#');
      if (m.size !== 1) { stats.ambiguous++; continue; }
      if (this.current.get(settlementKey)?.has(oldKey)) { stats.stillCurrent++; continue; }
      const [currentKey, e] = m.entries().next().value as [string, Edge];
      const oldName = [...e.oldNames.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      picked.set(k, {
        settlementKey, oldKey, oldName, currentKey, currentName: e.currentName, ways: e.ways,
        how: e.how.has('area') ? 'area' : 'node', tags: [...e.tags].sort(), wayId: e.wayId, until: e.until,
      });
    }
    const rows = [...picked.values()];
    rows.sort((a, b) => (a.settlementKey < b.settlementKey ? -1 : a.settlementKey > b.settlementKey ? 1 : a.oldKey < b.oldKey ? -1 : 1));
    stats.kept = rows.length;
    return { rows, stats };
  }
}
