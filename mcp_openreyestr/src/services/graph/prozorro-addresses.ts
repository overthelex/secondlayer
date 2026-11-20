/**
 * ProZorro supplier addresses as registered_at edges of the relationship graph (LEXAI-2317).
 *
 * The 2026 ЄДР dumps publish no addresses: companies registered after the last address snapshot
 * (2021-11-01) have no registered_at edge, and the others' addresses are confirmed only up to
 * then. A ProZorro contract names its supplier with an address (prozorro_contracts.supplier_region
 * / supplier_locality / supplier_address = the OCDS address.region / locality / streetAddress) and a
 * date (dateSigned, else the contract date, else the tender's dateModified), so each supplier gets
 * dated address observations. Buyers are not used: prozorro_tenders keeps no buyer address.
 *
 * Per (company, building key) the observations are merged into a run first_seen .. last_seen.
 *   - The key is one the ЄДР already links the company to: no new edge; the ЄДР edge gets
 *     source_ref.prozorro and attrs.prozorro_confirmed_until.
 *   - Otherwise an edge with source 'prozorro', valid_from = first contract with the address,
 *     attrs.confirmed_until = last one. It is open (valid_to NULL) when it is the company's newest
 *     ProZorro address, unless the company's open ЄДР address was confirmed later than the ProZorro
 *     address was last seen (the ЄДР wins when it is newer); else valid_to = last_seen.
 *   - An open ЄДР address is closed (valid_to = first_seen of the newer address, attrs.closed_by
 *     'prozorro') when the company's newest ProZorro address is another building first seen after
 *     the ЄДР confirmation date: the company moved after the last ЄДР address snapshot.
 *
 * ProZorro has no postcode column, so a village / селище is keyed only when the street text carries
 * the postcode (village keys include it: names repeat within an oblast); an address whose oblast is
 * unknown is skipped too. A bare locality ('Харків' instead of 'м. Харків') is read as a city when
 * the ЄДР addresses already have a city of that name in the oblast. 10-digit runs (phone numbers,
 * РНОКПП) are cut from the text before keying, so checkPersonalIds keeps passing.
 */
import type { PoolClient } from 'pg';
import { normAddress, parseAddressParts } from '../graph-norm/address';

/** Observations dated before ProZorro (2015) or in the future are data errors (years 16, 516, 1970 occur). */
export const PROZORRO_MIN_DATE = '2015-01-01';
/** A city settlement key seen at least this often in the ЄДР addresses makes a bare locality a city. */
export const CITY_MIN_ADDRESSES = 3;

export type ComposeStatus = 'ok' | 'no_street' | 'no_key' | 'no_oblast' | 'village_no_postcode';

const LONG_DIGITS = /(^|[^0-9])[0-9]{10,}(?=[^0-9]|$)/g;

// the comma-less layout of the newer extracts: 'Х р-н місто Х вул.Х будинок 1' (buildings and
// premises are split off by the parser itself)
const RAION_END = /(\s(?:р-н|район))\s+(?=\S)/gi;
const PLACE_OR_STREET = /\s+(?=(?:(?:місто|селище міського типу|смт|селище|село|вулиця|провулок|проспект|бульвар|площа)\s|(?:м|с|смт|вул|пров|просп|пр|бул|пл)\.))/gi;

function clean(s: string | null | undefined): string {
  let t = (s || '').replace(/\\[rn]|[\r\n\t]/g, ' ').replace(LONG_DIGITS, '$1 ').replace(/\s+/g, ' ').trim();
  if (!/[,;]/.test(t)) t = t.replace(RAION_END, '$1, ').replace(PLACE_OR_STREET, ', ');
  return t.replace(/^[,;\s]+|[,;\s]+$/g, '');
}

/** 'Широка, 81' -> 'вул. Широка, 81': OCDS street addresses often omit the street type. */
function withStreetType(s: string): string {
  if (parseAddressParts(s).street) return s;
  const first = s.split(/\s*[,;]\s*/)[0];
  const p = parseAddressParts(first);
  if (!/^[а-яіїєґa-z]/i.test(first) || p.settlement || p.oblast || p.raion || p.street || p.building || p.premises) return s;
  return `вул. ${s}`;
}

/**
 * One raw address in the ЄДР layout ('Україна, <region>, <locality>, <street>') from the three
 * OCDS fields, or null with the reason it would not give a usable building key.
 * cityKeys: city settlement keys known from the ЄДР ('UA-63|м|харкив'), to read a bare locality.
 */
export function composeProzorroAddress(region: string | null | undefined, locality: string | null | undefined,
  street: string | null | undefined, cityKeys: ReadonlySet<string> | null): { raw: string | null; status: ComposeStatus } {
  const r = clean(region);
  let l = clean(locality);
  const s0 = clean(street);
  if (!s0) return { raw: null, status: 'no_street' };
  const s = withStreetType(s0);
  if (l && !parseAddressParts(l).settlement && cityKeys) {
    const asCity = normAddress(['Україна', r, `м. ${l}`].filter(Boolean).join(', '));
    if (asCity.settlementKey && cityKeys.has(asCity.settlementKey)) l = `м. ${l}`;
  }
  const raw = ['Україна', r, l, s].filter(Boolean).join(', ');
  const a = normAddress(raw);
  if (!a.addressKey) return { raw: null, status: 'no_key' };
  if (!a.oblastCode) return { raw: null, status: 'no_oblast' };
  if (a.settlementType !== 'місто' && !a.postcode) return { raw: null, status: 'village_no_postcode' };
  return { raw, status: 'ok' };
}

export interface ProzorroStageOptions {
  /** the builder's scope predicate on a company code column */
  inScope: (col: string) => string;
  /** address key version of this build (city keys are read for it) */
  keyVersion: string;
  batch: number;
  /** keys the raw addresses of a staged table (columns raw_md5, raw) into graph.address_key */
  keyRaws: (table: string) => Promise<number>;
  log: (m: string) => void;
}

/**
 * Stages graph_stage.pz_run (edrpou, address_key, first_seen, last_seen, contracts, refs (jsonb), premises,
 * raw, raw_md5): one row per company and building key. refs: up to 5 newest contract ids of the newest spelling. Needs graph_stage.company. Without the
 * prozorro_contracts table (a test or scratch database) pz_run is empty.
 */
export async function stageProzorroAddresses(c: PoolClient, o: ProzorroStageOptions): Promise<Record<string, number | string>> {
  const counts: Record<string, number | string> = {};
  const n = async (sql: string) => Number((await c.query(sql)).rows[0].n);
  await c.query(`CREATE FUNCTION graph_stage.pz_loose(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT array_to_string(a[1:n - 1] || a[n + 1:], '|')
    FROM (SELECT string_to_array(k, '|') AS a, CASE split_part(k, '|', 2) WHEN 'м' THEN 4 ELSE 5 END AS n) x $$`);
  await c.query(`CREATE UNLOGGED TABLE graph_stage.pz_run (edrpou text, address_key text, first_seen date, last_seen date,
    contracts int, refs jsonb, premises text, raw text, raw_md5 text)`);
  if (!(await c.query(`SELECT to_regclass('prozorro_contracts') AS t`)).rows[0].t) {
    counts.prozorro = 'absent';
    return counts;
  }
  // one row per (supplier, address spelling), with the dates and the newest contracts
  await c.query(`CREATE UNLOGGED TABLE graph_stage.pz_obs AS
    SELECT x.edrpou, md5(x.r || chr(31) || x.l || chr(31) || x.a) AS src_md5, x.r, x.l, x.a,
           min(x.d) AS first_seen, max(x.d) AS last_seen, count(*)::int AS contracts,
           (array_agg(x.contract_id ORDER BY x.d DESC, x.contract_id))[1:5] AS refs
    FROM (
      SELECT p.supplier_edrpou AS edrpou, coalesce(p.supplier_region, '') AS r, coalesce(p.supplier_locality, '') AS l,
             p.supplier_address AS a, p.contract_id,
             (coalesce(p.date_signed, p.contract_date, p.tender_date_modified) AT TIME ZONE 'Europe/Kiev')::date AS d
      FROM prozorro_contracts p JOIN graph_stage.company co ON co.edrpou = p.supplier_edrpou
      WHERE p.supplier_edrpou ~ '^\\d{8}$' AND coalesce(p.supplier_address, '') <> '' AND ${o.inScope('p.supplier_edrpou')}
    ) x
    WHERE x.d >= DATE '${PROZORRO_MIN_DATE}' AND x.d <= current_date
    GROUP BY x.edrpou, x.r, x.l, x.a`);
  counts.prozorro_observations = await n('SELECT count(*) AS n FROM graph_stage.pz_obs');
  counts.prozorro_contracts_used = await n('SELECT coalesce(sum(contracts), 0) AS n FROM graph_stage.pz_obs');
  counts.prozorro_suppliers = await n('SELECT count(DISTINCT edrpou) AS n FROM graph_stage.pz_obs');
  await c.query(`CREATE UNLOGGED TABLE graph_stage.pz_src AS
    SELECT row_number() OVER () AS i, src_md5, r, l, a FROM (
      SELECT DISTINCT ON (src_md5) src_md5, r, l, a FROM graph_stage.pz_obs ORDER BY src_md5) x`);
  await c.query('ALTER TABLE graph_stage.pz_src ADD PRIMARY KEY (i)');
  // compose (JS): the ЄДР layout, a bare locality read as a known city
  const cityKeys = new Set<string>((await c.query(`SELECT settlement_key FROM graph.address_key
      WHERE key_version = $1 AND settlement_key LIKE '%|м|%' GROUP BY 1 HAVING count(*) >= ${CITY_MIN_ADDRESSES}`, [o.keyVersion]))
    .rows.map(r => String(r.settlement_key)));
  counts.prozorro_city_keys = cityKeys.size;
  await c.query('CREATE UNLOGGED TABLE graph_stage.pz_raw (src_md5 text PRIMARY KEY, raw text, raw_md5 text, status text NOT NULL)');
  const total = await n('SELECT count(*) AS n FROM graph_stage.pz_src');
  for (let lo = 0; lo < total; lo += o.batch) {
    const rows = (await c.query('SELECT src_md5, r, l, a FROM graph_stage.pz_src WHERE i > $1 AND i <= $2', [lo, lo + o.batch])).rows;
    const out = rows.map(x => ({ md5: String(x.src_md5), ...composeProzorroAddress(x.r, x.l, x.a, cityKeys) }));
    await c.query(`INSERT INTO graph_stage.pz_raw SELECT s, r, md5(r), st FROM unnest($1::text[], $2::text[], $3::text[]) AS u(s, r, st)`,
      [out.map(x => x.md5), out.map(x => x.raw), out.map(x => x.status)]);
  }
  for (const r of (await c.query('SELECT status, count(*) AS n FROM graph_stage.pz_raw GROUP BY 1')).rows) {
    counts[`prozorro_spellings_${r.status}`] = Number(r.n);
  }
  await c.query(`CREATE UNLOGGED TABLE graph_stage.pz_key_todo AS SELECT DISTINCT raw_md5, raw FROM graph_stage.pz_raw WHERE raw IS NOT NULL`);
  counts.prozorro_addresses_keyed = await o.keyRaws('graph_stage.pz_key_todo');
  // one run per building: spellings that differ only in the street type ('Широка' read as вулиця,
  // 'просп. Широка') are one building, keyed as the spelling with the most contracts
  await c.query(`INSERT INTO graph_stage.pz_run
    WITH k AS (
      SELECT o.edrpou, k.address_key, graph_stage.pz_loose(k.address_key) AS loose, min(o.first_seen) AS first_seen,
             max(o.last_seen) AS last_seen, sum(o.contracts)::int AS contracts,
             (array_agg(to_jsonb(o.refs) ORDER BY o.last_seen DESC, o.src_md5))[1] AS refs,
             (array_agg(k.premises_key ORDER BY o.last_seen DESC, o.src_md5))[1] AS premises,
             (array_agg(pr.raw ORDER BY o.last_seen DESC, o.src_md5))[1] AS raw,
             (array_agg(pr.raw_md5 ORDER BY o.last_seen DESC, o.src_md5))[1] AS raw_md5
      FROM graph_stage.pz_obs o
      JOIN graph_stage.pz_raw pr ON pr.src_md5 = o.src_md5 AND pr.raw IS NOT NULL
      JOIN graph.address_key k ON k.raw_md5 = pr.raw_md5 AND k.address_key IS NOT NULL
      GROUP BY o.edrpou, k.address_key
    )
    SELECT edrpou, (array_agg(address_key ORDER BY contracts DESC, address_key))[1], min(first_seen), max(last_seen), sum(contracts)::int,
           (array_agg(refs ORDER BY last_seen DESC, address_key))[1], (array_agg(premises ORDER BY contracts DESC, address_key))[1],
           (array_agg(raw ORDER BY contracts DESC, address_key))[1], (array_agg(raw_md5 ORDER BY contracts DESC, address_key))[1]
    FROM k GROUP BY edrpou, loose`);
  counts.prozorro_runs = await n('SELECT count(*) AS n FROM graph_stage.pz_run');
  counts.prozorro_companies_with_address = await n('SELECT count(DISTINCT edrpou) AS n FROM graph_stage.pz_run');
  await c.query('DROP TABLE graph_stage.pz_obs, graph_stage.pz_src, graph_stage.pz_raw, graph_stage.pz_key_todo');
  await c.query('ANALYZE graph_stage.pz_run');
  return counts;
}

/**
 * Adds the ProZorro addresses to graph_stage.e_raw, after the ЄДР registered_at edges (the rules
 * in the header). edrConfirmed: the newest snapshot publishing addresses (the ЄДР confirmation
 * date of an open address), null without snapshots.
 */
export async function prozorroAddressEdges(c: PoolClient, edrConfirmed: string | null): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const conf = edrConfirmed ? `DATE '${edrConfirmed.replace(/[^0-9-]/g, '')}'` : 'NULL::date';
  const run = async (name: string, sql: string) => { counts[name] = (await c.query(sql)).rowCount || 0; };
  // the company's ЄДР addresses; its newest ProZorro run (ties: the later first contract, then the key)
  await c.query(`CREATE UNLOGGED TABLE graph_stage.pz_edge AS
    WITH edr AS (
      SELECT src_key AS edrpou, bool_or(valid_to IS NULL) AS edr_open, array_agg(graph_stage.pz_loose(dst_key)) AS loose
      FROM graph_stage.e_raw WHERE kind = 'registered_at' AND source <> 'prozorro' GROUP BY 1
    ), ranked AS (
      SELECT p.*, row_number() OVER (PARTITION BY p.edrpou ORDER BY p.last_seen DESC, p.first_seen DESC, p.address_key) = 1 AS newest
      FROM graph_stage.pz_run p
    )
    SELECT r.*, e.edrpou IS NOT NULL AS has_edr, coalesce(e.edr_open, false) AS edr_open,
           coalesce(graph_stage.pz_loose(r.address_key) = ANY (e.loose), false) AS in_edr
    FROM ranked r LEFT JOIN edr e USING (edrpou)`);
  // fresh tables have no statistics: without them the planner can pick a nested loop over e_raw that
  // ran for half an hour on prod (20.11)
  await c.query('ANALYZE graph_stage.pz_edge');
  await c.query('ANALYZE graph_stage.e_raw');
  const pzRef = (p: string) => `jsonb_build_object('table', 'prozorro_contracts', 'first_seen', ${p}.first_seen, 'last_seen', ${p}.last_seen,
    'contracts', ${p}.contracts, 'contract_ids', ${p}.refs, 'value', ${p}.raw_md5)`;
  // the same building as the ЄДР: a confirmation of the ЄДР edge
  await run('prozorro_confirms_edr', `UPDATE graph_stage.e_raw e
    SET source_ref = e.source_ref || jsonb_build_object('prozorro', ${pzRef('p')}),
        attrs = e.attrs || jsonb_build_object('prozorro_confirmed_until', p.last_seen)
    FROM graph_stage.pz_edge p
    WHERE p.in_edr AND e.kind = 'registered_at' AND e.src_kind = 'company' AND e.src_key = p.edrpou
      AND graph_stage.pz_loose(e.dst_key) = graph_stage.pz_loose(p.address_key)`);
  // the company moved after the last ЄДР address snapshot: its open ЄДР address ends
  await run('edr_closed_by_prozorro', `UPDATE graph_stage.e_raw e
    SET valid_to = p.first_seen, attrs = e.attrs || jsonb_build_object('closed_by', 'prozorro')
    FROM graph_stage.pz_edge p
    WHERE p.newest AND NOT p.in_edr AND p.edr_open AND ${conf} IS NOT NULL AND p.first_seen > ${conf}
      AND e.kind = 'registered_at' AND e.source <> 'prozorro' AND e.src_kind = 'company' AND e.src_key = p.edrpou AND e.valid_to IS NULL`);
  await run('edges_prozorro_address', `INSERT INTO graph_stage.e_raw
    SELECT 'company', p.edrpou, 'address', p.address_key, 'registered_at', p.first_seen,
           CASE WHEN p.newest AND NOT (p.edr_open AND ${conf} IS NOT NULL AND ${conf} >= p.last_seen) THEN NULL ELSE p.last_seen END,
           'prozorro', jsonb_build_object('prozorro', ${pzRef('p')}),
           jsonb_strip_nulls(jsonb_build_object('premises', p.premises, 'raw', p.raw, 'confirmed_until', p.last_seen, 'contracts', p.contracts)),
           NULL, NULL
    FROM graph_stage.pz_edge p WHERE NOT p.in_edr`);
  const one = async (sql: string) => Number((await c.query(sql)).rows[0].n);
  counts.prozorro_first_address_companies = await one('SELECT count(DISTINCT edrpou) AS n FROM graph_stage.pz_edge WHERE NOT has_edr');
  counts.prozorro_differs_from_edr_companies = await one('SELECT count(*) AS n FROM graph_stage.pz_edge WHERE newest AND has_edr AND NOT in_edr');
  counts.prozorro_same_as_edr_companies = await one('SELECT count(*) AS n FROM graph_stage.pz_edge WHERE newest AND in_edr');
  counts.edges_prozorro_address_current = await one(`SELECT count(*) AS n FROM graph_stage.e_raw WHERE source = 'prozorro' AND valid_to IS NULL`);
  await c.query('DROP TABLE graph_stage.pz_edge');
  return counts;
}
