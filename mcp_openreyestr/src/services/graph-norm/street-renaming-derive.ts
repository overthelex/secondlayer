/**
 * Street renamings derived from ЄДР address history (LEXAI-2309).
 *
 * A company whose registered address goes from 'вул. Леніна, 5, кв. 3' to 'вул. Соборна, 5, кв. 3'
 * in the same settlement most likely stayed put while its street was renamed. One company can
 * also have moved from one 'буд. 5' to another, so a pair (settlement, old street -> new street)
 * is kept only when several independent companies at several buildings show it, and an old name
 * whose companies went to several new streets is kept only when one of them dominates.
 *
 * candidatePairs() reads one company's chronological addresses; RenamingAggregator counts the
 * pairs over all companies and filter() turns them into street_renamings_scoped rows. Both are
 * pure (no DB), so the script (scripts/derive-street-renamings.ts) only streams rows in.
 */
import { normAddress, NormalisedAddress, STREET_SHORT, streetCoreKey } from './address';
import { renamingSettlementKey } from './street-renamings';

export interface AddressObservation {
  value: string;
  /** ISO date (YYYY-MM-DD) the address was first seen with this value */
  date: string;
}

export interface RenamingCandidate {
  /** renamingSettlementKey: a village's postcode cut to three digits */
  settlementKey: string;
  /** 'вул|ленина': street-type short form + streetCoreKey */
  oldKey: string;
  oldName: string;        // 'вулиця леніна'
  newKey: string;
  newName: string;
  building: string;
  /** date the new name was first seen */
  date: string;
}

interface Parsed {
  settlementKey: string;
  key: string;
  name: string;
  core: string;
  building: string;
  corpus: string | null;
  premises: string | null;
  date: string;
}

export const streetKeyOf = (type: keyof typeof STREET_SHORT, name: string) => `${STREET_SHORT[type]}|${streetCoreKey(name)}`;

/** A street core without adjective endings: 'тестова' (вулиця) = 'тестовий' (проспект). */
const genderless = (core: string) => core.split(' ').map((w) => (w.length > 4 ? w.replace(/(?:ий|ой|ая|ое|а|е|я|и)$/, '') : w)).join(' ');

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// ordinals written as words or digits: 'першого травня' = '1 травня', '1-го' = '1'
const ORDINAL_STEMS: Array<[RegExp, string]> = [
  [/^перш/, '1'], [/^друг/, '2'], [/^трет/, '3'], [/^четверт/, '4'], [/^пят/, '5'], [/^шост/, '6'],
  [/^сьом/, '7'], [/^восьм/, '8'], [/^девят/, '9'], [/^десят/, '10'],
];
const ORDINAL_SUFFIX = new Set(['го', 'ого', 'и', 'ои', 'й', 'ий', 'а', 'я', 'е']);
function numeralFold(core: string): string {
  return core.split(' ').filter((w) => !ORDINAL_SUFFIX.has(w)).map((w) => {
    for (const [re, d] of ORDINAL_STEMS) {
      if (re.test(w) && w.replace(re, '').length <= 3) return d;
    }
    return w;
  }).sort().join(' ');
}

/**
 * Two cores of one street name ('першого травня' = '1 травня'): a type / adjective-ending change ('тестова' = 'тестовий'), a typo
 * ('новокостянтинівська' = 'новоконстянтинівська', at most 1 edit per 6 letters) or extra words on
 * one side ('хмельницького' = 'хмельницького шевченківський р-н').
 */
export function sameStreetName(a: string, b: string): boolean {
  a = numeralFold(a);
  b = numeralFold(b);
  if (a === b || genderless(a) === genderless(b)) return true;
  if (editDistance(a, b) <= Math.floor(Math.min(a.length, b.length) / 6)) return true;
  const wa = a.split(' ');
  const wb = new Set(b.split(' '));
  const inter = wa.filter((w) => wb.has(w)).length;
  return inter > 0 && (inter === wa.length || inter === wb.size);
}

function parse(o: AddressObservation): Parsed | null {
  const a: NormalisedAddress = normAddress(o.value);
  if (!a.settlementKey || !a.street || !a.streetType || !a.building) return null;
  // a note in brackets is not part of the name: 'хмельницького богдана (шевченківський р-н)'
  const street = a.street.replace(/\([^)]*\)?/g, ' ').replace(/\s+/g, ' ').trim();
  const core = streetCoreKey(street);
  if (!core || /^\d+$/.test(core)) return null;
  return {
    settlementKey: renamingSettlementKey(a.settlementKey), key: `${STREET_SHORT[a.streetType]}|${core}`, core,
    name: `${a.streetType} ${street}`, building: a.building, corpus: a.corpus,
    premises: a.premises ? `${a.premisesType}|${a.premises}` : null, date: o.date,
  };
}

/**
 * Renaming candidates of one company: each address against the next parsed one, when the
 * settlement, building (and corpus) agree, the flat / office agrees or one side has none, and the
 * street name differs (sameStreetName: a type, adjective-ending or spelling change is not a
 * renaming). One candidate per (settlement, old, new) per company.
 */
export function candidatePairs(observations: AddressObservation[]): RenamingCandidate[] {
  const parsed = [...observations].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))
    .map(parse).filter((p): p is Parsed => p !== null);
  const out = new Map<string, RenamingCandidate>();
  for (let i = 1; i < parsed.length; i++) {
    const a = parsed[i - 1];
    const b = parsed[i];
    if (a.settlementKey !== b.settlementKey || a.building !== b.building) continue;
    if ((a.corpus ?? '') !== (b.corpus ?? '')) continue;
    if (a.premises && b.premises && a.premises !== b.premises) continue;
    if (sameStreetName(a.core, b.core)) continue;
    const id = `${a.settlementKey}#${a.key}#${b.key}`;
    if (!out.has(id)) {
      out.set(id, {
        settlementKey: a.settlementKey, oldKey: a.key, oldName: a.name, newKey: b.key, newName: b.name,
        building: b.building, date: b.date,
      });
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- aggregation

interface Edge {
  companies: number;
  buildings: Set<string>;
  first: string;
  last: string;
  oldNames: Map<string, number>;
  newNames: Map<string, number>;
}

export interface FilterOptions {
  minCompanies?: number;  // default 2 (2/2 spot check: 37 correct, 0 wrong, 3 unsure of 40 extra rows)
  minBuildings?: number;  // default 2
  /** share of the old name's companies the winning new name must have (default 0.8) */
  dominance?: number;
}

export interface ScopedRenaming {
  settlementKey: string;
  oldKey: string;
  oldName: string;
  /** the street's name at the end of a rename chain (A -> B -> C gives C) */
  currentKey: string;
  currentName: string;
  companies: number;
  buildings: number;
  /** companies of the winning new name / companies of all new names of this old name */
  share: number;
  firstSeen: string;
  lastSeen: string;
}

export interface FilterStats {
  oldNames: number;          // distinct (settlement, old street) with any candidate
  pairs: number;             // distinct (settlement, old -> new)
  belowSupport: number;      // old names whose best new name lacks companies / buildings
  ambiguous: number;         // old names without a dominant new name
  reverse: number;           // A -> B dropped because B -> A is (about) as strong
  kept: number;
  chained: number;           // kept rows whose current name came through a chain
}

const top = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];

export class RenamingAggregator {
  /** `${settlementKey}#${oldKey}` -> newKey -> edge */
  private readonly edges = new Map<string, Map<string, Edge>>();

  add(candidates: RenamingCandidate[]): void {
    for (const c of candidates) {
      const k = `${c.settlementKey}#${c.oldKey}`;
      let m = this.edges.get(k);
      if (!m) this.edges.set(k, (m = new Map()));
      let e = m.get(c.newKey);
      if (!e) {
        m.set(c.newKey, (e = { companies: 0, buildings: new Set(), first: c.date, last: c.date, oldNames: new Map(), newNames: new Map() }));
      }
      e.companies++;
      e.buildings.add(c.building);
      if (c.date < e.first) e.first = c.date;
      if (c.date > e.last) e.last = c.date;
      e.oldNames.set(c.oldName, (e.oldNames.get(c.oldName) ?? 0) + 1);
      e.newNames.set(c.newName, (e.newNames.get(c.newName) ?? 0) + 1);
    }
  }

  /** All (settlement, old -> new) pairs with their support, unfiltered. */
  *pairs(): Generator<{ settlementKey: string; oldKey: string; newKey: string; oldName: string; newName: string; companies: number; buildings: number; first: string; last: string }> {
    for (const [k, m] of this.edges) {
      const i = k.indexOf('#');
      for (const [newKey, e] of m) {
        yield {
          settlementKey: k.slice(0, i), oldKey: k.slice(i + 1), newKey, oldName: top(e.oldNames), newName: top(e.newNames),
          companies: e.companies, buildings: e.buildings.size, first: e.first, last: e.last,
        };
      }
    }
  }

  filter(opts: FilterOptions = {}): { rows: ScopedRenaming[]; stats: FilterStats } {
    const minC = opts.minCompanies ?? 2;
    const minB = opts.minBuildings ?? 2;
    const dom = opts.dominance ?? 0.8;
    const stats: FilterStats = { oldNames: this.edges.size, pairs: 0, belowSupport: 0, ambiguous: 0, reverse: 0, kept: 0, chained: 0 };

    // 1. one dominant, well-supported new name per old name
    const win = new Map<string, { settlementKey: string; oldKey: string; newKey: string; e: Edge; share: number }>();
    for (const [k, m] of this.edges) {
      stats.pairs += m.size;
      let total = 0;
      let best: [string, Edge] | null = null;
      for (const [nk, e] of m) {
        total += e.companies;
        if (!best || e.companies > best[1].companies || (e.companies === best[1].companies && e.buildings.size > best[1].buildings.size)) best = [nk, e];
      }
      const [newKey, e] = best!;
      if (e.companies < minC || e.buildings.size < minB) { stats.belowSupport++; continue; }
      const share = e.companies / total;
      if (share < dom) { stats.ambiguous++; continue; }
      const i = k.indexOf('#');
      win.set(k, { settlementKey: k.slice(0, i), oldKey: k.slice(i + 1), newKey, e, share });
    }

    // 2. A -> B and B -> A: keep the clearly stronger direction, or neither
    for (const [k, w] of [...win]) {
      if (!win.has(k)) continue;
      const back = win.get(`${w.settlementKey}#${w.newKey}`);
      if (!back || back.newKey !== w.oldKey) continue;
      const a = w.e.companies;
      const b = back.e.companies;
      const backKey = `${w.settlementKey}#${w.newKey}`;
      if (a / (a + b) >= dom) { win.delete(backKey); stats.reverse++; }
      else if (b / (a + b) >= dom) { win.delete(k); stats.reverse++; }
      else { win.delete(k); win.delete(backKey); stats.reverse += 2; }
    }

    // 3. follow chains to the latest name (A -> B in 2016, B -> C in 2023)
    const rows: ScopedRenaming[] = [];
    for (const w of win.values()) {
      let cur = w.newKey;
      let curName = top(w.e.newNames);
      const seen = new Set([w.oldKey, cur]);
      for (let step = 0; step < 5; step++) {
        const next = win.get(`${w.settlementKey}#${cur}`);
        if (!next || seen.has(next.newKey)) break;
        cur = next.newKey;
        curName = top(next.e.newNames);
        seen.add(cur);
      }
      if (cur === w.oldKey) continue;
      if (cur !== w.newKey) stats.chained++;
      rows.push({
        settlementKey: w.settlementKey, oldKey: w.oldKey, oldName: top(w.e.oldNames), currentKey: cur, currentName: curName,
        companies: w.e.companies, buildings: w.e.buildings.size, share: Math.round(w.share * 1000) / 1000,
        firstSeen: w.e.first, lastSeen: w.e.last,
      });
    }
    rows.sort((x, y) => (x.settlementKey < y.settlementKey ? -1 : x.settlementKey > y.settlementKey ? 1 : y.companies - x.companies));
    stats.kept = rows.length;
    return { rows, stats };
  }
}
