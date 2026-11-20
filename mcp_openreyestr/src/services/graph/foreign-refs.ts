/**
 * Foreign registers linked to the foreign_entity nodes of the ЄДР relationship graph (LEXAI-2321).
 *
 * The registers live in another database (secondlayer_local: cy_companies / cy_officials from the
 * Cyprus DRCOR open data, LEXAI-2301; icij_nodes from the ICIJ Offshore Leaks database,
 * LEXAI-2311). scripts/import-foreign-refs.ts reads them once and copies the matches into
 * graph.foreign_ref / graph.foreign_officer of this database (migration 034); the builder only
 * reads those two tables, never the other database:
 *
 *   CY  cy_companies by the HE number in the entry (code, name or code key: 'HE 123456', 'НЕ123456',
 *       'ΗΕ 123456') -> match 'code'; else by the name skeleton (uaMatchKey, the node key's name
 *       part) when exactly one Cypriot company has it -> match 'name'. Directors, secretaries and
 *       other officials of a linked company become 'head' edges (source 'cy_drcor') from a
 *       person_name node (a corporate official: a foreign_entity 'CY|name:...') to the entity.
 *   ICIJ icij_nodes entities of the entity's jurisdiction with the same name skeleton: candidates
 *       only (a name match is not an identification), each with its link, the leak and the ICIJ
 *       caveat; no edges.
 *   GB  the Companies House number written in the entry: a link to the public register,
 *       unverified (no Companies House copy in these databases).
 *
 * Every link carries the source, the source snapshot date and a URL of the source record or dataset.
 */
import type { PoolClient } from 'pg';
import { uaMatchKey } from '../edr-history/norm';
import { stripPersonIds } from '../graph-norm/personal-ids';
import { isOrganisationName, normName, PERSON_KEY_VERSION, personKey } from './keys';

type Q = Pick<PoolClient, 'query'>;

export type ForeignRefSource = 'cy_drcor' | 'icij' | 'companies_house';
export const FOREIGN_REF_SOURCES: ForeignRefSource[] = ['cy_drcor', 'icij', 'companies_house'];

export interface ForeignRef {
  node_key: string;
  source: ForeignRefSource;
  /** cy_drcor: '<org_type_code>/<registration_no>'; icij: node_id; companies_house: the company number */
  ref_id: string;
  match: 'code' | 'name';
  /** true: a name match to check against other data (ICIJ, an unverified Companies House number) */
  candidate: boolean;
  name: string | null;
  jurisdiction: string | null;
  status: string | null;
  registered_on: string | null;
  url: string | null;
  source_date: string | null;
  attrs: Record<string, unknown>;
}

export interface ForeignOfficer {
  source: ForeignRefSource;
  ref_id: string;
  /** the official's name as the source writes it (personal numbers stripped) */
  name: string;
  role: string;
  position: string | null;
  ep_kind: 'person_name' | 'foreign_entity';
  ep_key: string;
  key_version: string;
  source_date: string | null;
  url: string | null;
}

/** Person key version the officer endpoint keys were computed with; the builder skips other versions. */
export const OFFICER_KEY_VERSION = `p${PERSON_KEY_VERSION}`;

export const CY_DATASET_URL = 'https://www.data.gov.cy/en/dataset/1026';
export const ICIJ_ATTRIBUTION =
  'Джерело: база даних ICIJ Offshore Leaks Міжнародного консорціуму журналістів-розслідувачів (ICIJ), '
  + 'https://offshoreleaks.icij.org. База даних поширюється за ліцензією Open Database License (ODbL) 1.0, '
  + 'її вміст — за ліцензією Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0).';
export const ICIJ_CAVEAT =
  'Застереження ICIJ: наявність особи чи компанії в базі Offshore Leaks не означає і не свідчить про незаконну '
  + 'або неналежну поведінку. Збіг назви не доводить, що це та сама компанія: його слід підтвердити іншими даними.';
export const icijNodeUrl = (nodeId: string) => `https://offshoreleaks.icij.org/nodes/${encodeURIComponent(nodeId)}`;
export const companiesHouseUrl = (n: string) => `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(n)}`;

/** Positions of cy_officials -> the role written on the edge. */
export const CY_ROLES: Record<string, string> = {
  'Διευθυντής': 'director',
  'Αντικαταστάτης Διευθυντής': 'alternate_director',
  'Γραμματέας': 'secretary',
  'Βοηθός Γραμματέας': 'assistant_secretary',
  'Αναπληρωτής Γραμματέας': 'deputy_secretary',
  'Ιδιοκτήτης': 'owner',
  'Ομόρρυθμος Συνέταιρος': 'general_partner',
  'Ετερόρρυθμος Συνέταιρος': 'limited_partner',
  'Εξουσιοδοτημένο Πρόσωπο': 'authorised_person',
};
export function cyRole(position: string | null | undefined): string {
  return CY_ROLES[(position || '').trim()] || 'official';
}

/**
 * ICIJ jurisdiction codes of an ISO 3166 country of the ЄДР entry (icij_nodes.jurisdiction: the
 * leaks use their own codes, several per country).
 */
export const ICIJ_JURISDICTIONS: Record<string, string[]> = {
  BS: ['BAH', 'BS', 'BHS'], VG: ['BVI', 'VG', 'VGB'], MT: ['MLT', 'MT'], KN: ['KNA', 'KN'], AW: ['AW'],
  PA: ['PMA', 'PA', 'PAN'], BB: ['BRB', 'BB'], SC: ['SEY', 'SYC', 'SC'], WS: ['SAM', 'WSM'], NU: ['NIUE'],
  BM: ['BM', 'BERMU'], KY: ['KY', 'CAYMN', 'CYM'], CK: ['COOK', 'COK', 'CK'], AI: ['ANG', 'AIA', 'AI'],
  HK: ['HK', 'HKG'], IM: ['IM', 'IOM', 'IMN'], JE: ['JE', 'JSY', 'JEY'], SG: ['SGP', 'SG'], BZ: ['BLZ', 'BZ'],
  MU: ['MU', 'MAURI', 'MUS'], GG: ['GG', 'GGY'], AE: ['ARE', 'AE', 'DUBAI', 'RAK'], CY: ['CYP', 'CY'],
  US: ['USA', 'US', 'USDE', 'NEV', 'WYO'], GB: ['UK', 'GBR'], CR: ['CRI'], MY: ['MALAY', 'LABUA'], NZ: ['NZL', 'NZ'],
  UY: ['UY'], LI: ['LI'], LR: ['LR', 'LIBER'], TC: ['TC'], VC: ['VC', 'VCT'], GI: ['GIB', 'GI'], CH: ['CHE'],
  NL: ['NL', 'NETH'], LV: ['LVA'], GD: ['GD'], MH: ['MARSH', 'MHL', 'MH'], VU: ['VANU', 'VUT'], AG: ['AG'],
  LU: ['LU'], LB: ['LBN'], LC: ['STLU', 'LCA'], MC: ['MCO'], VI: ['VI'], BN: ['BRUN'], TH: ['THAIL'], GH: ['GHA'],
  IE: ['IRELD'], CN: ['CHINA'],
};

/** Words of a name key that are registration numbers or their prefixes, not the name: 'ne 123456', 'he123456', 'fn 12345 z'. */
function nameKeyTokens(key: string): string[] {
  return key.split(' ').filter(w => w && !/\d/.test(w) && !/^(he|ne|fn|reg|no|nr|kod|kode|identifikatsiinii|reiestratsiinii|nomer)$/.test(w));
}
/** The name skeleton used for matching a foreign register: the key's words without numbers. */
export function matchName(nameKey: string | null | undefined): string | null {
  const t = nameKeyTokens(nameKey || '');
  return t.length && t.join('').length >= 3 ? t.join(' ') : null;
}
/** The same skeleton of a register's own spelling ('SCARAMANDER LIMITED' -> 'skaramander'). */
export function registerNameKey(name: string | null | undefined): string | null {
  return matchName(uaMatchKey(name));
}

/**
 * Cypriot HE registration numbers written in an entry ('HE 123456', 'НЕ-123456', 'ΗΕ123456',
 * 'H.E. 12345', a code key 'CY|code:HE123456'), digits only.
 */
export function heNumbers(...texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  const re = /(?:^|[^A-Za-zА-Яа-яІіЇїЄєΑ-Ωα-ω])(?:H|Н|Η)\.?\s*(?:E|Е|Ε)\.?\s*[-№#:.]*\s*0*(\d{1,6})(?!\d)/g;
  for (const t of texts) {
    if (!t) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) out.add(m[1]);
  }
  return [...out];
}

/**
 * Companies House numbers in a GB entry: 8 characters, digits or a two-letter prefix and 6 digits
 * ('12345678', '№ 01234567', 'SC123456'); shorter all-digit numbers are zero-padded.
 */
export function companiesHouseNumbers(...texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  const re = /(?:^|[^A-Za-z0-9])((?:SC|NI|OC|SO|NC|FC|LP|SL|NL|R0)\d{6}|\d{7,8})(?![0-9])/gi;
  for (const t of texts) {
    if (!t) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) out.add(m[1].toUpperCase().padStart(8, '0'));
  }
  return [...out];
}

const GREEK_LAT: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o',
  π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};
/** Greek letters to Latin (ELOT-like, without digraph rules): a Greek-only name gets a key instead of none. */
export function greekToLatin(s: string): string {
  if (!/[Ͱ-Ͽ]/.test(s)) return s;
  let out = '';
  for (const ch of s.normalize('NFD').replace(/\p{Mn}/gu, '')) {
    const lo = ch.toLowerCase();
    const t = GREEK_LAT[lo];
    out += t === undefined ? ch : (ch === lo ? t : t.toUpperCase());
  }
  return out;
}

const CORPORATE_OFFICER_RE = /(^| )(limited|ltd|llc|inc|corp|plc|gmbh|sa|ag|bv|nv|services|secretarial|secretaries|nominees|trust|trustees|holdings?|directors)( |$)/;

/** Endpoint of a register official: a corporate official is a foreign entity of the register's country, else a person. */
export function officerEndpoint(name: string, country: string): { ep_kind: 'person_name' | 'foreign_entity'; ep_key: string; name: string } | null {
  const label = stripPersonIds(name) || '';
  const clean = greekToLatin(label);
  if (isOrganisationName(clean) || CORPORATE_OFFICER_RE.test(normName(clean))) {
    const k = uaMatchKey(clean);
    return k ? { ep_kind: 'foreign_entity', ep_key: `${country}|name:${k}`, name: label } : null;
  }
  const k = personKey(clean);
  return k ? { ep_kind: 'person_name', ep_key: k, name: label } : null;
}

// ---------------------------------------------------------------- import (scripts/import-foreign-refs.ts)

export interface ForeignNode { key: string; label: string | null; codes: string[] }

/** Country, name skeleton and code of a foreign_entity key ('CY|name:skaramander', 'CY|code:HE123456'). */
export function parseForeignKey(key: string): { country: string; nameKey: string | null; code: string | null } {
  const [country, rest = ''] = key.split('|', 2);
  return {
    country,
    nameKey: rest.startsWith('name:') ? rest.slice(5) : null,
    code: rest.startsWith('code:') ? rest.slice(5) : null,
  };
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const tokensOverlap = (a: string | null, b: string | null) => {
  if (!a || !b) return false;
  const s = new Set(a.split(' '));
  return b.split(' ').some(w => w.length > 2 && s.has(w));
};

export interface CollectOptions {
  /** ICIJ candidates kept per foreign entity */
  icijMaxCandidates?: number;
  log?: (m: string) => void;
}

/**
 * Matches of the foreign entities of graph.node (target) in the registers of the source database.
 * Read-only on both sides; returns the rows for writeForeignRefs and the counts.
 */
export async function collectForeignRefs(target: Q, source: Q, opts: CollectOptions = {}): Promise<{
  refs: ForeignRef[]; officers: ForeignOfficer[]; counts: Record<string, number>;
}> {
  const log = opts.log || (() => undefined);
  const maxIcij = opts.icijMaxCandidates ?? 5;
  const counts: Record<string, number> = {};
  const inc = (k: string, n = 1) => { counts[k] = (counts[k] || 0) + n; };
  const nodes = (await target.query(`SELECT key, label, coalesce(ARRAY(SELECT jsonb_array_elements_text(attrs->'codes')), '{}') AS codes
    FROM graph.node WHERE kind = 'foreign_entity'`)).rows as ForeignNode[];
  counts.foreign_entities = nodes.length;
  log(`${nodes.length} foreign entities`);
  const refs: ForeignRef[] = [];
  const officers: ForeignOfficer[] = [];

  // ---- Cyprus: HE number, else a unique name
  const cy = nodes.filter(n => n.key.startsWith('CY|'));
  counts.cy_entities = cy.length;
  const heOf = new Map<string, string[]>();
  for (const n of cy) {
    const p = parseForeignKey(n.key);
    const he = heNumbers(...n.codes, n.label, p.code);
    if (he.length) heOf.set(n.key, he);
  }
  counts.cy_entities_with_he = heOf.size;
  const allHe = [...new Set([...heOf.values()].flat())];
  const cyByNo = new Map<string, any>();
  if (allHe.length) {
    for (const r of (await source.query(`SELECT org_type_code, registration_no, name, status, registration_date, snapshot_date
        FROM cy_companies WHERE org_type_code = 'C' AND registration_no = ANY($1)`, [allHe])).rows) cyByNo.set(String(r.registration_no), r);
  }
  const cyRows = (await source.query(`SELECT org_type_code, registration_no, name, status, registration_date, snapshot_date
    FROM cy_companies WHERE org_type_code IN ('C', 'O', 'P')`)).rows;
  const cyByName = new Map<string, any[]>();
  for (const r of cyRows) {
    const k = registerNameKey(r.name);
    if (!k) continue;
    const a = cyByName.get(k);
    if (a) { if (a.length < 3) a.push(r); } else cyByName.set(k, [r]);
  }
  log(`cy_companies: ${cyRows.length} rows, ${cyByName.size} name keys`);
  const cyRef = (key: string, r: any, match: 'code' | 'name', candidate: boolean, extra: Record<string, unknown> = {}): ForeignRef => ({
    node_key: key, source: 'cy_drcor', ref_id: `${r.org_type_code}/${r.registration_no}`, match, candidate,
    name: r.name ?? null, jurisdiction: 'CY', status: r.status ?? null, registered_on: iso(r.registration_date),
    url: CY_DATASET_URL, source_date: iso(r.snapshot_date),
    attrs: { registration_no: `${r.org_type_code === 'C' ? 'HE' : r.org_type_code} ${r.registration_no}`, ...extra },
  });
  for (const n of cy) {
    const p = parseForeignKey(n.key);
    const nm = matchName(p.nameKey);
    let linked = false;
    for (const he of heOf.get(n.key) || []) {
      const r = cyByNo.get(he);
      if (!r) { inc('cy_he_not_in_register'); continue; }
      // a typo in the number links another company: without a common name word it is only a candidate
      const ok = !nm || tokensOverlap(nm, registerNameKey(r.name));
      refs.push(cyRef(n.key, r, 'code', !ok, ok ? {} : { name_mismatch: true }));
      inc(ok ? 'cy_linked_by_code' : 'cy_code_name_mismatch');
      linked = linked || ok;
    }
    if (linked || !nm) continue;
    const cands = cyByName.get(nm);
    if (cands?.length === 1) { refs.push(cyRef(n.key, cands[0], 'name', false)); inc('cy_linked_by_name'); }
    else if (cands?.length) inc('cy_name_ambiguous');
  }
  // officials of the confirmed Cypriot links
  const cyLinked = refs.filter(r => r.source === 'cy_drcor' && !r.candidate);
  const regNos = [...new Set(cyLinked.map(r => r.ref_id.split('/')[1]))];
  if (regNos.length) {
    const want = new Set(cyLinked.map(r => r.ref_id));
    const seen = new Set<string>();
    for (const o of (await source.query(`SELECT org_type_code, registration_no, person_name, position, snapshot_date, source_url
        FROM cy_officials WHERE registration_no = ANY($1)`, [regNos])).rows) {
      const ref = `${o.org_type_code}/${o.registration_no}`;
      if (!want.has(ref)) continue;
      const ep = officerEndpoint(String(o.person_name), 'CY');
      if (!ep) { inc('cy_officers_without_key'); continue; }
      const role = cyRole(o.position);
      const id = `${ref}|${ep.ep_kind}|${ep.ep_key}|${role}`;
      if (seen.has(id)) continue;
      seen.add(id);
      officers.push({ source: 'cy_drcor', ref_id: ref, name: ep.name, role, position: o.position || null, ep_kind: ep.ep_kind, ep_key: ep.ep_key,
        key_version: OFFICER_KEY_VERSION, source_date: iso(o.snapshot_date), url: o.source_url ?? CY_DATASET_URL });
      inc(`cy_officers_${ep.ep_kind}`);
    }
  }

  // ---- ICIJ: name candidates in the entity's jurisdiction
  const byCountry = new Map<string, ForeignNode[]>();
  for (const n of nodes) {
    const p = parseForeignKey(n.key);
    if (!ICIJ_JURISDICTIONS[p.country] || !matchName(p.nameKey)) continue;
    const a = byCountry.get(p.country);
    if (a) a.push(n); else byCountry.set(p.country, [n]);
  }
  for (const [country, ns] of byCountry) {
    const rows = (await source.query(`SELECT node_id, name, jurisdiction, jurisdiction_description, status, incorporation_date, source_leak
      FROM icij_nodes WHERE node_type = 'entity' AND jurisdiction = ANY($1)`, [ICIJ_JURISDICTIONS[country]])).rows;
    const byName = new Map<string, any[]>();
    for (const r of rows) {
      const k = registerNameKey(r.name);
      if (!k || k.replace(/ /g, '').length < 5) continue;
      const a = byName.get(k);
      if (a) { if (a.length < maxIcij) a.push(r); } else byName.set(k, [r]);
    }
    for (const n of ns) {
      const nm = matchName(parseForeignKey(n.key).nameKey);
      for (const r of (nm && byName.get(nm)) || []) {
        refs.push({ node_key: n.key, source: 'icij', ref_id: String(r.node_id), match: 'name', candidate: true, name: r.name ?? null,
          jurisdiction: r.jurisdiction_description || r.jurisdiction || null, status: r.status || null,
          registered_on: iso(r.incorporation_date), url: icijNodeUrl(String(r.node_id)), source_date: null,
          attrs: { leak: r.source_leak ?? null } });
        inc('icij_candidates');
      }
    }
    log(`icij ${country}: ${rows.length} entities, ${ns.length} graph entities`);
  }
  counts.icij_entities_with_candidates = new Set(refs.filter(r => r.source === 'icij').map(r => r.node_key)).size;
  const icijDate = (await source.query(`SELECT max(generated_on) AS d FROM icij_snapshots`).catch(() => ({ rows: [{ d: null }] }))).rows[0]?.d;
  for (const r of refs) if (r.source === 'icij') r.source_date = iso(icijDate);

  // ---- Companies House: the number written in a GB entry (no copy of the register here: unverified)
  for (const n of nodes) {
    if (!n.key.startsWith('GB|')) continue;
    const p = parseForeignKey(n.key);
    for (const no of companiesHouseNumbers(...n.codes, p.code)) {
      refs.push({ node_key: n.key, source: 'companies_house', ref_id: no, match: 'code', candidate: true, name: null,
        jurisdiction: 'GB', status: null, registered_on: null, url: companiesHouseUrl(no), source_date: null, attrs: { verified: false } });
      inc('companies_house_numbers');
    }
  }
  counts.foreign_refs = refs.length;
  counts.foreign_officers = officers.length;
  return { refs, officers, counts };
}

/** Replace graph.foreign_ref / graph.foreign_officer with the collected rows, in one transaction. */
export async function writeForeignRefs(c: Q, refs: ForeignRef[], officers: ForeignOfficer[], opts: { applyToGraph?: boolean } = {}): Promise<Record<string, number>> {
  const now = new Date().toISOString();
  await c.query('BEGIN');
  try {
    await c.query('DELETE FROM graph.foreign_ref');
    await c.query('DELETE FROM graph.foreign_officer');
    for (let i = 0; i < refs.length; i += 5000) {
      await c.query(`INSERT INTO graph.foreign_ref SELECT * FROM jsonb_populate_recordset(NULL::graph.foreign_ref, $1::jsonb)
        ON CONFLICT DO NOTHING`, [JSON.stringify(refs.slice(i, i + 5000).map(r => ({ ...r, imported_at: now })))]);
    }
    for (let i = 0; i < officers.length; i += 5000) {
      await c.query(`INSERT INTO graph.foreign_officer SELECT * FROM jsonb_populate_recordset(NULL::graph.foreign_officer, $1::jsonb)
        ON CONFLICT DO NOTHING`, [JSON.stringify(officers.slice(i, i + 5000))]);
    }
    const res = opts.applyToGraph ? await applyForeignRefs(c, 'graph') : {};
    await c.query('COMMIT');
    return res;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------- builder hooks

/** True when migration 034 is applied (the builder works without it, with no links). */
async function hasRefs(c: Q): Promise<boolean> {
  return !!(await c.query(`SELECT to_regclass('graph.foreign_ref') AS a, to_regclass('graph.foreign_officer') AS b`)).rows
    .every(r => r.a && r.b);
}

/**
 * Officials of the linked Cypriot companies as 'head' edges into graph_stage.e_raw (before the
 * degrees are computed), for the foreign entities this build has. Officers keyed with another
 * person key version are skipped (re-run import-foreign-refs). Returns counts for graph.build.
 */
export async function addForeignOfficerEdges(c: Q): Promise<Record<string, number>> {
  if (!(await hasRefs(c))) return { foreign_officer_edges: 0 };
  await c.query(`CREATE UNLOGGED TABLE graph_stage.fe_key AS
    SELECT DISTINCT src_key AS key FROM graph_stage.e_raw WHERE src_kind = 'foreign_entity'`);
  await c.query('ALTER TABLE graph_stage.fe_key ADD PRIMARY KEY (key)');
  await c.query(`INSERT INTO graph_stage.e_raw
    SELECT o.ep_kind, o.ep_key, 'foreign_entity', r.node_key, 'head', NULL, NULL, o.source,
           jsonb_build_object(o.source, jsonb_strip_nulls(jsonb_build_object('ref', o.ref_id, 'snapshot', o.source_date, 'url', o.url))),
           jsonb_strip_nulls(jsonb_build_object('role', o.role, 'position', o.position, 'entry', o.source, 'confirmed_until', o.source_date)),
           o.name, NULL
    FROM graph.foreign_officer o
    JOIN graph.foreign_ref r ON r.source = o.source AND r.ref_id = o.ref_id AND NOT r.candidate
    WHERE o.key_version = $1
      AND r.node_key IN (SELECT key FROM graph_stage.fe_key)
      AND NOT (o.ep_kind = 'foreign_entity' AND o.ep_key = r.node_key)`, [OFFICER_KEY_VERSION]);
  await c.query('DROP TABLE graph_stage.fe_key');
  const n = Number((await c.query(`SELECT count(*) AS n FROM graph_stage.e_raw WHERE kind = 'head' AND dst_kind = 'foreign_entity'`)).rows[0].n);
  const stale = Number((await c.query(`SELECT count(*) AS n FROM graph.foreign_officer WHERE key_version <> $1`, [OFFICER_KEY_VERSION])).rows[0].n);
  return { foreign_officer_edges: n, foreign_officers_stale_key_version: stale };
}

/**
 * attrs.links of the foreign_entity nodes in `schema`.node from graph.foreign_ref: one object per
 * link ({source, ref, match, candidate, name, jurisdiction, status, registered_on, url,
 * source_date, ...attrs}); with an ICIJ candidate also attrs.icij = {attribution, caveat}.
 */
export async function applyForeignRefs(c: Q, schema: string): Promise<Record<string, number>> {
  if (!(await hasRefs(c))) return { foreign_entities_linked: 0 };
  await c.query(`UPDATE ${schema}.node SET attrs = attrs - 'links' - 'icij' WHERE kind = 'foreign_entity' AND (attrs ? 'links' OR attrs ? 'icij')`);
  const r = await c.query(`UPDATE ${schema}.node n
    SET attrs = (n.attrs - 'links' - 'icij') || jsonb_build_object('links', l.links)
              || CASE WHEN l.icij THEN jsonb_build_object('icij', jsonb_build_object('attribution', $1::text, 'caveat', $2::text)) ELSE '{}'::jsonb END
    FROM (SELECT node_key, bool_or(source = 'icij') AS icij,
                 jsonb_agg(jsonb_strip_nulls(jsonb_build_object('source', source, 'ref', ref_id, 'match', match, 'candidate', candidate,
                   'name', name, 'jurisdiction', jurisdiction, 'status', status, 'registered_on', registered_on, 'url', url,
                   'source_date', source_date) || attrs) ORDER BY candidate, source, ref_id) AS links
          FROM graph.foreign_ref GROUP BY node_key) l
    WHERE n.kind = 'foreign_entity' AND n.key = l.node_key`, [ICIJ_ATTRIBUTION, ICIJ_CAVEAT]);
  const by = (await c.query(`SELECT source || CASE WHEN candidate THEN '_candidate' ELSE '' END AS k, count(DISTINCT node_key) AS n
    FROM graph.foreign_ref r WHERE EXISTS (SELECT 1 FROM ${schema}.node n WHERE n.kind = 'foreign_entity' AND n.key = r.node_key)
    GROUP BY 1`)).rows as Array<{ k: string; n: string }>;
  return { foreign_entities_linked: r.rowCount ?? 0, ...Object.fromEntries(by.map(x => [`foreign_linked_${x.k}`, Number(x.n)])) };
}
