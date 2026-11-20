/**
 * Node keys and edge classification of the ЄДР relationship graph (LEXAI-2303). Pure functions:
 * the builder applies the same rules in SQL (builder.ts) to the edr_hist rows, which already carry
 * name_latn = uaMatchKey(name), and in JS to the current dump rows it parses; the tests pin both.
 */
import { normEdrpou } from '../graph-norm/edrpou';
import { normAddress, NormAddressOptions } from '../graph-norm/address';
import { normUa, uaMatchKey } from '../edr-history/norm';
import { md5 } from '../edr-history/entries';

export type NodeKind = 'company' | 'person_name' | 'address' | 'foreign_entity' | 'organisation';
export type EdgeKind = 'founder' | 'beneficiary' | 'head' | 'signer' | 'registered_at' | 'reg_neighbour';
export type EdgeSource = 'edr_hist' | 'edr_current';

export const NODE_KINDS: NodeKind[] = ['company', 'person_name', 'address', 'foreign_entity', 'organisation'];
export const EDGE_KINDS: EdgeKind[] = ['founder', 'beneficiary', 'head', 'signer', 'registered_at', 'reg_neighbour'];

/** Bump when normAddress changes in a way that changes keys: every address is re-keyed on the next build. */
export const ADDRESS_KEY_VERSION = 1;

/**
 * Entries that name a group or a statement instead of a participant ('АКЦІОНЕРИ ЗГІДНО РЕЄСТРУ',
 * '91 акціонер', 'ЧЛЕНИ КООПЕРАТИВУ', 'КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК ВІДСУТНІЙ', 'ТРУДОВИЙ
 * КОЛЕКТИВ'). Applied to normUa(name); the same patterns run in PostgreSQL (builder.ts
 * graph_stage.placeholder), so they use only POSIX classes both engines read alike.
 */
const W = '[а-яіїєґ]*';
export const PLACEHOLDER_RE_SOURCE =
  `(^| )(акціонер${W}|член(и|ів|а|ами|ам|ом)?|згідно|реєстр${W}|трудов${W}|колектив${W}`
  + `|(фізичн|физичн)${W} (особ${W}|осіб)|фіз (ос|особ${W})|учасник${W}|засновник${W}|бенефіціар${W}`
  + `|бенефіциар${W}|відсутн${W}|власник(и|ів|а|ом|ами)?|інші|пайовик${W}|співвласник${W}`
  + `|громадяни|мешканц${W}|жител${W}`
  // LEXAI-2319, from the high-degree person_name nodes of the first full build: unknown /
  // undetermined persons, communities and statements written as names
  + `|неви[зч]начен${W}|невідом(а|ий|і|ого|их|о|е)|неможлив${W}|немає|нема|не (має|маю|вказан${W}|визначен${W}|відом${W}|можлив${W}|встановлен${W})`
  + `|відомост${W}|(територіальн|релігійн|церковн|сільськ|селищн|міськ)${W} громад(а|и|і|у|ою)`
  + `|громада (села|селища|міста|сіл|парафії)|церковн${W} десятк${W})( |$)`
  // whole-name placeholders: a country, a share, a number, a lone legal form or job title
  // ('ПРИВАТНЕ ПІДПРИЄМСТВО', 'КЕРІВНИК ПІДПРИЄМСТВА' with its typos, 'ДИРЕКТОР ТОВАРИСТВА',
  // 'ГОЛОВА АСОЦІАЦІЇ', 'КЕРІНВИК ФОНДУ'), 'ГРОМАДЯНИН УКРАЇНИ'
  + `|^(україна|пряме|прямий|[0-9 ]*)$`
  + `|^([а-яіїєґ]+ ?){0,2}(підприємств|товариств|кооператив|асоціаці|компані|корпораці|організаці|установ|фонд)${W}$`
  + `|^громадян(ин|ка) [а-яіїєґ]+$`;
/**
 * Words that make a placeholder only without a patronymic: 'НЕВІДОМА ОСОБА', 'КЕРІВНИК К',
 * 'КОНТРОЛЕР ЮРИДИЧНОЇ ОСОБИ', 'ФРАНКІВСЬКА ОБЛАСТЬ' are placeholders, while 'КОНТРОЛЕР ІВАНЕНКО
 * ІВАН ІВАНОВИЧ' or 'ЮРИДИЧНОЇ ОСОБИ-ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ' (a beneficiary entry with a
 * prefix) still name a person.
 */
export const WEAK_PLACEHOLDER_RE_SOURCE =
  `(^| )(юридичн${W} (особ${W}|осіб)|юр (ос|особ${W})|особа|особи|осіб|керівник${W}|контролер${W}|кількіст${W}`
  + `|вирішальн${W}|област[ьі]|грн)( |$)`;
/** A patronymic word ('іванович', 'петрівна'): the name is a person's even next to a legal form or a weak placeholder word. */
export const PATRONYMIC_RE_SOURCE = '(^| )[а-яіїєґ]{2,}(ович|евич|івна|ївна|овна|евна)( |$)';
const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_RE_SOURCE);
const WEAK_PLACEHOLDER_RE = new RegExp(WEAK_PLACEHOLDER_RE_SOURCE);
const PATRONYMIC_RE = new RegExp(PATRONYMIC_RE_SOURCE);

export function isPlaceholderName(name: string | null | undefined): boolean {
  const n = normUa(name);
  return !n || PLACEHOLDER_RE.test(n) || (WEAK_PLACEHOLDER_RE.test(n) && !PATRONYMIC_RE.test(n));
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

// ---------------------------------------------------------------- organisations as heads (LEXAI-2318)

/**
 * Legal-form words and abbreviations: a head entry naming one is an organisation (management
 * company, КУА, ТОВ-управитель), unless the name also has a patronymic ('ТОВ ОЛЕКСАНДР
 * СЕМЕНОВИЧ' is a person named Тов; 'ТЕСТЕНКО ... ТЕСТОВИЧ ЛІКВІДАТОР ПІДПРИЄМСТВА' a person
 * with a note). Applied to normName (= graph_stage.norm_name in builder.ts), POSIX classes only.
 * 'банк', 'фонд' are surnames too; with a patronymic they are persons by the same rule. The
 * abbreviations count only at the start ('ПРАТ ГАЄК', not 'ТЕСТЕНКО ПП').
 */
export const ORG_FORM_RE_SOURCE =
  `(^| )(товариств${W}|підприємств${W}|корпораці${W}|компані(я|ї|ію|єю)|кооператив${W}|асоціаці${W}|спілк(а|и|у|ою)`
  + `|установ(а|и|і)|фонд|фонду|банк|банку|куа|limited|ltd|llc|gmbh|inc|corp|plc)( |$)`
  + `|^(тов|тзов|прат|пат|ат|зат|ват|тдв|пп|дп|кп) `;
/** An 8-digit ЄДРПОУ in the entry text (not part of a longer number such as a 10-digit РНОКПП). */
export const CODE8_RE_SOURCE = '(?:^|[^0-9])([0-9]{8})(?:[^0-9]|$)';
const ORG_FORM_RE = new RegExp(ORG_FORM_RE_SOURCE);
const CODE8_RE = new RegExp(CODE8_RE_SOURCE);

/** JS twin of graph_stage.norm_name: lower case, ё -> е, apostrophes dropped, other non-letters to single spaces. */
export function normName(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/'/g, '').replace(/[^0-9a-zа-яіїєґ]+/g, ' ').trim();
}

/** The non-zero 8-digit code written in a name, as a company key, or null. */
export function codeInName(name: string | null | undefined): string | null {
  const m = CODE8_RE.exec(name || '');
  return m && !/^0+$/.test(m[1]) ? m[1] : null;
}

/** A head entry that names a legal entity rather than a person. */
export function isOrganisationName(name: string | null | undefined): boolean {
  const n = normName(name);
  if (!n || PATRONYMIC_RE.test(n)) return false;
  return ORG_FORM_RE.test(n) || codeInName(name) !== null;
}

/** Organisation without a code that no unique company name resolves: uaMatchKey of the name (a candidate, like person_name). */
export function organisationKey(name: string | null | undefined): string | null {
  return uaMatchKey(name) || null;
}

/**
 * The node a head / signer entry points at: a person -> person_name; an organisation with a code
 * in the text -> company; one without a code -> 'ua_org_without_code', which the builder resolves
 * by a unique company name (the founders' rule) or else keys as an organisation node.
 */
export function headEndpoint(name: string | null | undefined): Endpoint | SkipReason {
  if (isPlaceholderName(name)) return 'placeholder';
  if (isOrganisationName(name)) {
    const c = codeInName(name);
    return c ? { kind: 'company', key: c } : 'ua_org_without_code';
  }
  const p = personKey(name);
  return p ? { kind: 'person_name', key: p } : 'no_key';
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

export type HubThresholds = Record<NodeKind, number>;

/**
 * Hub thresholds are computed per build from the degree distribution of each kind (LEXAI-2319):
 * threshold = max(floor, degree at the percentile), a node is a hub when its degree is above it.
 * The fixed thresholds tuned on a 10% sample (address > 30 ...) made 5,812 addresses of the full
 * graph hubs, business centres among them. First full build (20.11.2026), degree p99.9 / p99.99:
 * address 153 / 457, company 55 / 250, person_name 65 / 252, foreign_entity 69 / 174. Addresses
 * and companies use p99.99: a business centre with a few hundred tenants, or a company with a
 * hundred co-owners, should not stop a traversal; persons and foreign entities p99.9 (formation
 * agents, nominee directors, names shared by many namesakes). The floors keep a small (--limit)
 * build from marking ordinary nodes. --hub-* overrides a kind.
 */
export interface HubPolicy { percentile: number; floor: number }
export const HUB_POLICY: Record<NodeKind, HubPolicy> = {
  address: { percentile: 0.9999, floor: 100 },
  company: { percentile: 0.9999, floor: 100 },
  person_name: { percentile: 0.999, floor: 30 },
  foreign_entity: { percentile: 0.999, floor: 30 },
  organisation: { percentile: 0.999, floor: 30 },
};
/** The floors: thresholds of a graph too small for its percentiles to mean anything. */
export const DEFAULT_HUB_THRESHOLDS: HubThresholds = Object.fromEntries(
  NODE_KINDS.map(k => [k, HUB_POLICY[k].floor])) as HubThresholds;

/**
 * Mass registration address: degree at least max(floor, address degree at the percentile)
 * (first full build: p99.995 = 600, 31 addresses), or listed in graph.address_flag as
 * 'mass_registration'. Such an address is always a hub and carries attrs.mass_registration.
 * graph.address_flag 'not_hub' exempts a curated address (a business centre) from both.
 */
export const MASS_REGISTRATION_POLICY: HubPolicy = { percentile: 0.99995, floor: 500 };

/** Percentiles the builder reads from the degree distribution (one SQL pass per kind). */
export function hubPercentiles(): number[] {
  return [...new Set([...NODE_KINDS.map(k => HUB_POLICY[k].percentile), MASS_REGISTRATION_POLICY.percentile])].sort((a, b) => a - b);
}

export interface ComputedHubThresholds {
  thresholds: HubThresholds;
  massRegistrationMinDegree: number;
  /** where each value came from: 'override', 'percentile' or 'floor' */
  basis: Record<string, 'override' | 'percentile' | 'floor'>;
  /** observed degree at each percentile, per kind (only kinds that have nodes) */
  observed: Partial<Record<NodeKind, Record<string, number>>>;
}

/** Thresholds from the observed degree percentiles; overrides win, the floors bound the rest. */
export function computeHubThresholds(observed: Partial<Record<NodeKind, Record<string, number>>>,
  overrides: Partial<HubThresholds> = {}, massOverride?: number): ComputedHubThresholds {
  const basis: ComputedHubThresholds['basis'] = {};
  const pick = (name: string, pol: HubPolicy, value: number | undefined, override: number | undefined) => {
    if (override !== undefined) { basis[name] = 'override'; return override; }
    if (value !== undefined && value > pol.floor) { basis[name] = 'percentile'; return value; }
    basis[name] = 'floor';
    return pol.floor;
  };
  const thresholds = Object.fromEntries(NODE_KINDS.map(k =>
    [k, pick(k, HUB_POLICY[k], observed[k]?.[String(HUB_POLICY[k].percentile)], overrides[k])])) as HubThresholds;
  const massRegistrationMinDegree = pick('mass_registration', MASS_REGISTRATION_POLICY,
    observed.address?.[String(MASS_REGISTRATION_POLICY.percentile)], massOverride);
  return { thresholds, massRegistrationMinDegree, basis, observed };
}

export function isHub(kind: NodeKind, degree: number, t: HubThresholds = DEFAULT_HUB_THRESHOLDS): boolean {
  return degree > t[kind];
}

export type AddressFlag = 'mass_registration' | 'not_hub';

/** Hub and mass-registration flags of an address node (the SQL in builder.ts does the same). */
export function addressHubFlags(degree: number, t: ComputedHubThresholds, flag?: AddressFlag | null): { hub: boolean; massRegistration: false | 'degree' | 'list' } {
  if (flag === 'not_hub') return { hub: false, massRegistration: false };
  if (flag === 'mass_registration') return { hub: true, massRegistration: 'list' };
  if (degree >= t.massRegistrationMinDegree) return { hub: true, massRegistration: 'degree' };
  return { hub: degree > t.thresholds.address, massRegistration: false };
}
