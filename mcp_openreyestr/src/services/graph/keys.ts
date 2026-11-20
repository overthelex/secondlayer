/**
 * Node keys and edge classification of the ЄДР relationship graph (LEXAI-2303). Pure functions:
 * the builder applies the same rules in SQL (builder.ts) to the edr_hist rows, which already carry
 * name_latn = uaMatchKey(name), and in JS to the current dump rows it parses; the tests pin both.
 */
import { normEdrpou } from '../graph-norm/edrpou';
import { normAddress, NormAddressOptions } from '../graph-norm/address';
import { normUa, uaMatchKey } from '../edr-history/norm';
import { md5 } from '../edr-history/entries';

export type NodeKind = 'company' | 'person_name' | 'address' | 'foreign_entity';
export type EdgeKind = 'founder' | 'beneficiary' | 'head' | 'signer' | 'registered_at' | 'reg_neighbour';
export type EdgeSource = 'edr_hist' | 'edr_current';

export const NODE_KINDS: NodeKind[] = ['company', 'person_name', 'address', 'foreign_entity'];
export const EDGE_KINDS: EdgeKind[] = ['founder', 'beneficiary', 'head', 'signer', 'registered_at', 'reg_neighbour'];

/** Bump when normAddress changes in a way that changes keys: every address is re-keyed on the next build. */
export const ADDRESS_KEY_VERSION = 1;

/**
 * Entries that name a group or a statement instead of a participant ('АКЦІОНЕРИ ЗГІДНО РЕЄСТРУ',
 * '91 акціонер', 'ЧЛЕНИ КООПЕРАТИВУ', 'КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК ВІДСУТНІЙ', 'ТРУДОВИЙ
 * КОЛЕКТИВ'). Applied to normUa(name); the same pattern runs in PostgreSQL (builder.ts), so it
 * uses only POSIX classes both engines read alike.
 */
export const PLACEHOLDER_RE_SOURCE =
  '(^| )(акціонер[а-яіїєґ]*|член(и|ів|а|ами|ам|ом)?|згідно|реєстр[а-яіїєґ]*|трудов[а-яіїєґ]*|колектив[а-яіїєґ]*'
  + '|фізичн[а-яіїєґ]* (особ[а-яіїєґ]*)|учасник[а-яіїєґ]*|засновник[а-яіїєґ]*|бенефіціар[а-яіїєґ]*'
  + '|бенефіциар[а-яіїєґ]*|відсутн[а-яіїєґ]*|власник(и|ів|а|ом|ами)?|інші|пайовик[а-яіїєґ]*|співвласник[а-яіїєґ]*'
  + '|громадяни|мешканц[а-яіїєґ]*|жител[а-яіїєґ]*)( |$)';
const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_RE_SOURCE);

export function isPlaceholderName(name: string | null | undefined): boolean {
  const n = normUa(name);
  return !n || PLACEHOLDER_RE.test(n);
}

/** 8-digit ЄДРПОУ key, or null ('32945' -> '00032945'; a 10-digit РНОКПП is not a company). */
export function companyKey(code: string | null | undefined): string | null {
  return normEdrpou(code).code;
}

/** Candidate person: uaMatchKey of the full name; null for empty / placeholder names. */
export function personKey(name: string | null | undefined): string | null {
  if (isPlaceholderName(name)) return null;
  return uaMatchKey(name) || null;
}

/** Registration number of a foreign entity as a key part: letters and digits, upper case, >= 4 chars. */
export function foreignCode(code: string | null | undefined): string | null {
  const c = (code || '').toUpperCase().replace(/[^0-9A-ZА-ЯІЇЄҐ]/g, '');
  return c.length >= 4 ? c : null;
}

/**
 * Foreign entity: 'CY|name:skaramander' (country + uaMatchKey of the name: the same for the
 * Cyrillic register spelling and the Latin one) or, without a usable name, 'CY|code:HE123456'.
 * The registration code is kept in the node attrs either way, for linking ICIJ / cy_companies /
 * Companies House later.
 */
export function foreignEntityKey(countryCode: string | null | undefined, name: string | null | undefined, code?: string | null): string | null {
  const cc = (countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || cc === 'UA') return null;
  if (!isPlaceholderName(name)) {
    const n = uaMatchKey(name);
    if (n) return `${cc}|name:${n}`;
  }
  const c = foreignCode(code);
  return c ? `${cc}|code:${c}` : null;
}

export interface Endpoint { kind: NodeKind; key: string }
export type SkipReason = 'placeholder' | 'no_key' | 'ua_org_without_code';

/**
 * The node a founder entry points at: a Ukrainian organisation with a code -> company; a foreign
 * one -> foreign_entity; a person -> person_name. A Ukrainian organisation without a code is
 * returned as ua_org_without_code: the builder resolves it by a unique company name, or drops it.
 */
export function founderEndpoint(f: { kind: string | null; name: string | null; code: string | null; country_code: string | null }): Endpoint | SkipReason {
  const foreign = !!f.country_code && f.country_code !== 'UA';
  if (f.kind === 'organisation') {
    if (!foreign) {
      const c = companyKey(f.code);
      if (c) return { kind: 'company', key: c };
      return isPlaceholderName(f.name) ? 'placeholder' : 'ua_org_without_code';
    }
    const k = foreignEntityKey(f.country_code, f.name, f.code);
    return k ? { kind: 'foreign_entity', key: k } : (isPlaceholderName(f.name) ? 'placeholder' : 'no_key');
  }
  if (isPlaceholderName(f.name)) return 'placeholder';
  const p = personKey(f.name);
  return p ? { kind: 'person_name', key: p } : 'no_key';
}

/** head / signer edge of a head row: a representative (signatory) is 'signer', every other role 'head'. */
export function headEdgeKind(roleClass: string | null | undefined): EdgeKind {
  return roleClass === 'representative' ? 'signer' : 'head';
}

// ---------------------------------------------------------------- addresses

export interface AddressKeyRow {
  raw_md5: string; raw: string; key_version: string; parse_status: string;
  settlement_key: string | null; street_key: string | null; address_key: string | null; premises_key: string | null;
  label: string | null;
}

export function addressKeyVersion(renamingFingerprint: string | null): string {
  return `a${ADDRESS_KEY_VERSION}/sr:${renamingFingerprint || 'none'}`;
}

/** Keys of one raw address for graph.address_key; label = the address with the key's parts only. */
export function addressKeyRow(raw: string, version: string, opts: NormAddressOptions = {}): AddressKeyRow {
  const a = normAddress(raw, opts);
  const label = a.addressKey
    ? [a.postcode, a.settlementType && a.settlement ? `${a.settlementType} ${a.settlement}` : a.settlement,
      a.streetType && a.street ? `${a.streetType} ${a.street}` : null, a.building].filter(Boolean).join(', ')
    : null;
  return {
    raw_md5: md5(raw), raw, key_version: version, parse_status: a.status,
    settlement_key: a.settlementKey, street_key: a.streetKey, address_key: a.addressKey, premises_key: a.premisesKey,
    label,
  };
}

// ---------------------------------------------------------------- reg_neighbour

/** Two companies registered on the same day with ЄДРПОУ serials (code without the check digit) at most this far apart. */
export const REG_NEIGHBOUR_MAX_GAP = 2;
/** Days with more registrations than this are skipped (mass re-registration, data migrations). */
export const REG_NEIGHBOUR_MAX_PER_DAY = 1500;

/**
 * reg_neighbour, precisely: among companies with the same registered_on, ordered by serial
 * (ЄДРПОУ div 10), each company is linked to the next one when the serials differ by at most
 * maxGap and the day has at most maxPerDay registrations. So every company has at most two
 * reg_neighbour edges (previous and next), and a batch of N consecutive codes is a chain of N-1.
 */
export function regNeighbourPairs(rows: Array<{ edrpou: string; registered_on: string | null }>,
  maxGap = REG_NEIGHBOUR_MAX_GAP, maxPerDay = REG_NEIGHBOUR_MAX_PER_DAY): Array<[string, string, number]> {
  const byDay = new Map<string, Array<{ code: string; serial: number }>>();
  for (const r of rows) {
    const c = companyKey(r.edrpou);
    if (!c || !r.registered_on) continue;
    let a = byDay.get(r.registered_on);
    if (!a) byDay.set(r.registered_on, (a = []));
    a.push({ code: c, serial: Math.floor(Number(c) / 10) });
  }
  const out: Array<[string, string, number]> = [];
  for (const a of byDay.values()) {
    if (a.length > maxPerDay) continue;
    a.sort((x, y) => x.serial - y.serial || x.code.localeCompare(y.code));
    for (let i = 1; i < a.length; i++) {
      const gap = a[i].serial - a[i - 1].serial;
      if (gap <= maxGap) out.push([a[i - 1].code, a[i].code, gap]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- hubs

export interface HubThresholds { company: number; person_name: number; address: number; foreign_entity: number }

/**
 * Defaults set between p99 and p99.9 of the degree distribution (sample build of 179K companies,
 * Nov 2026: p99 / p99.9 of address 21 / 87, person_name 12 / 48, company 16 / 30, foreign_entity
 * 13 / 67; full history person_name 19 / 56).
 * Above them a node is a mass registration address / business centre, a formation agent or nominee
 * name, a name shared by many namesakes, or a company with hundreds of co-owners (ОСББ, former
 * state enterprises); a traversal does not expand through it. Tunable per build (--hub-*).
 */
export const DEFAULT_HUB_THRESHOLDS: HubThresholds = { company: 300, person_name: 40, address: 30, foreign_entity: 100 };

export function isHub(kind: NodeKind, degree: number, t: HubThresholds = DEFAULT_HUB_THRESHOLDS): boolean {
  return degree > t[kind];
}
