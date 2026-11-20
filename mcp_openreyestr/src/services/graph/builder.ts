/**
 * Builds the relationship graph (schema graph, migration 030) from the ЄДР history (edr_hist) and
 * the current dump tables (legal_entities, founders, signers, beneficiaries). LEXAI-2303.
 *
 * Everything is staged in schema graph_stage and swapped in with one transaction at the end, so
 * graph.node / graph.edge stay queryable during a rebuild. Work is server-side SQL
 * (INSERT ... SELECT) except where JS normalisation is needed:
 *   - address keys (graph-norm normAddress) for raw addresses not yet keyed with the current key
 *     version, cached in graph.address_key across builds;
 *   - parsing the current dump's text entries (founder_info / signer_info / beneficiary_info)
 *     with the edr_hist parsers into the edr_hist row shape, so one SQL classification serves both;
 *   - stripping personal numbers (РНОКПП, passport series) from names and free-text attributes
 *     (graph-norm/personal-ids, LEXAI-2322): the few values carrying them go through JS into
 *     graph_stage.name_fix / text_fix, which the participation SQL joins. Before the swap the
 *     build FAILS if a 10-digit run is left in a node label / key (foreign entities excepted: their
 *     codes are registration numbers) or in an edge attribute (amounts excepted): checkPersonalIds.
 *
 * Sources and dates:
 *   hist     edr_hist.founder / beneficiary / head (one row per distinct entry text per company,
 *            first/last snapshot) and edr_hist.history (field 'address' runs).
 *   current  the current dump tables, dated --current-date (default: max(legal_entities.updated_at)).
 *            Used when newer than the newest history snapshot; once the weekly sync folds the
 *            dumps into edr_hist (EDR_HISTORY_SNAPSHOT=1) the history itself is current and the
 *            text tables are skipped (includeCurrent 'auto').
 *   prozorro supplier addresses of prozorro_contracts, dated by the contracts (prozorro-addresses.ts,
 *            LEXAI-2317): registered_at edges for addresses the ЄДР dumps since 2021 no longer carry.
 * A relation is one edge per (participant, company, kind): its entries over all snapshots and both
 * sources are merged (the 2018 and 2021 dumps spell the same founder differently).
 */
import { Pool, PoolClient } from 'pg';
import { parseBeneficiary, parseFounder, parseHead } from '../edr-history/entries';
import { countryIso, uaMatchKey } from '../edr-history/norm';
import { StreetRenamingsCache } from '../graph-norm/street-renamings';
import type { StreetRenamingLookup } from '../graph-norm/address';
import { NAME_ID_PROBE_SQL, stripIdNumbers, stripPersonIds, TEN_DIGITS_SQL, TEXT_ID_PROBE_SQL } from '../graph-norm/personal-ids';
import {
  addressKeyRow, addressKeyVersion, CODE8_RE_SOURCE, computeHubThresholds, ComputedHubThresholds, hubPercentiles,
  HubThresholds, NODE_KINDS, NodeKind, ORG_FORM_RE_SOURCE, PATRONYMIC_RE_SOURCE, PERSON_KEY_VERSION, PLACEHOLDER_RE_SOURCE,
  WEAK_PLACEHOLDER_RE_SOURCE,
  REG_NEIGHBOUR_MAX_GAP, REG_NEIGHBOUR_MAX_PER_DAY,
} from './keys';
import { prozorroAddressEdges, stageProzorroAddresses } from './prozorro-addresses';
import { buildCourtEdges, CourtEdgeOptions } from './court';

export interface BuildOptions {
  /** sample build: only the first N companies by code (from fromEdrpou) */
  limit?: number;
  fromEdrpou?: string;
  /** count the sources only: nothing is written, no staging schema */
  dryRun?: boolean;
  /** 'auto' (default): use the current dump tables when they are newer than the newest snapshot */
  includeCurrent?: 'auto' | 'yes' | 'no';
  /** date of the current dump (YYYY-MM-DD); default max(legal_entities.updated_at)::date */
  currentDate?: string;
  /** per-kind overrides of the computed hub thresholds (keys.ts HUB_POLICY) */
  hubThresholds?: Partial<HubThresholds>;
  /** override of the computed mass registration degree of addresses (keys.ts MASS_REGISTRATION_POLICY) */
  massRegistrationMinDegree?: number;
  regNeighbourMaxGap?: number;
  regNeighbourMaxPerDay?: number;
  /** re-key every address, not only those of another key version */
  rekeyAddresses?: boolean;
  /** street renamings for address keys; default: StreetRenamingsCache over this database (none on error) */
  streetRenamings?: StreetRenamingLookup | null;
  renamingFingerprint?: string | null;
  statementTimeout?: string;   // default '3h'
  workMem?: string;            // default '256MB'
  batchSize?: number;          // JS batches, default 20000
  /** ProZorro supplier addresses as registered_at edges (prozorro-addresses.ts); default true */
  prozorroAddresses?: boolean;
  /** co_party edges from graph.court_party (court.ts, LEXAI-2304); false = none */
  court?: CourtEdgeOptions | false;
  /** leave graph_stage in place after the swap (debugging) */
  keepStage?: boolean;
  log?: (m: string) => void;
}

export interface BuildResult {
  dryRun: boolean;
  params: Record<string, unknown>;
  sources: Record<string, unknown>;
  counts: Record<string, number | string | null>;
  seconds: Record<string, number>;
  /** the thresholds applied: computed from the degree distribution (null on a dry run) */
  hubThresholds: ComputedHubThresholds | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** DDL of graph.node / graph.edge (identical to migrations 030 + 031 + 032), created in the staging schema. */
export function stageDdl(schema: string): string[] {
  return [
    `CREATE TABLE ${schema}.node (
      id      bigserial,
      kind    text NOT NULL CHECK (kind IN ('company', 'person_name', 'address', 'foreign_entity', 'organisation')),
      key     text NOT NULL,
      label   text,
      degree  integer NOT NULL DEFAULT 0,
      hub     boolean NOT NULL DEFAULT false,
      attrs   jsonb NOT NULL DEFAULT '{}'::jsonb)`,
    `CREATE TABLE ${schema}.edge (
      id          bigserial,
      src         bigint NOT NULL,
      dst         bigint NOT NULL,
      kind        text NOT NULL CHECK (kind IN ('founder', 'beneficiary', 'head', 'signer', 'registered_at', 'reg_neighbour', 'co_party')),
      valid_from  date,
      valid_to    date,
      source      text NOT NULL CHECK (source IN ('edr_hist', 'edr_current', 'edrsr', 'prozorro')),
      source_ref  jsonb NOT NULL DEFAULT '{}'::jsonb,
      attrs       jsonb NOT NULL DEFAULT '{}'::jsonb)`,
  ];
}

/** Indexes and constraints of the staged tables, added after the bulk load (names as in migration 030). */
export function stageIndexDdl(schema: string): string[] {
  return [
    `ALTER TABLE ${schema}.node ADD CONSTRAINT node_pkey PRIMARY KEY (id)`,
    `ALTER TABLE ${schema}.node ADD CONSTRAINT node_kind_key UNIQUE (kind, key)`,
    `ALTER TABLE ${schema}.edge ADD CONSTRAINT edge_pkey PRIMARY KEY (id)`,
    `CREATE INDEX edge_src_kind ON ${schema}.edge (src, kind)`,
    `CREATE INDEX edge_dst_kind ON ${schema}.edge (dst, kind)`,
    `CREATE INDEX edge_src_current ON ${schema}.edge (src) WHERE valid_to IS NULL`,
    `CREATE INDEX edge_dst_current ON ${schema}.edge (dst) WHERE valid_to IS NULL`,
  ];
}

// SQL helpers created in graph_stage (dropped with it): nothing is added to other schemas.
const STAGE_FUNCS = [
  `CREATE FUNCTION graph_stage.ua_date(t text) RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
   BEGIN RETURN to_date(substring(t FROM '\\d{2}\\.\\d{2}\\.\\d{4}'), 'DD.MM.YYYY'); EXCEPTION WHEN others THEN RETURN NULL; END $$`,
  // normUa for the placeholder test: lower case, non-letters to single spaces
  `CREATE FUNCTION graph_stage.norm_name(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
   SELECT btrim(regexp_replace(replace(replace(lower(coalesce(t, '')), 'ё', 'е'), '''', ''), '[^0-9a-zа-яіїєґ]+', ' ', 'g')) $$`,
  // keys.ts isPlaceholderName (an empty name is not one here: such rows have no key anyway)
  `CREATE FUNCTION graph_stage.placeholder(t text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
   SELECT n ~ ${lit(PLACEHOLDER_RE_SOURCE)} OR (n ~ ${lit(WEAK_PLACEHOLDER_RE_SOURCE)} AND n !~ ${lit(PATRONYMIC_RE_SOURCE)})
   FROM (SELECT graph_stage.norm_name(t) AS n) x $$`,
  // keys.ts isOrganisationName: a legal form (or a code) in the name, and no patronymic
  `CREATE FUNCTION graph_stage.org_name(t text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
   SELECT n <> '' AND n !~ ${lit(PATRONYMIC_RE_SOURCE)}
          AND (n ~ ${lit(ORG_FORM_RE_SOURCE)} OR coalesce(substring(t FROM ${lit(CODE8_RE_SOURCE)}), '0') !~ '^0+$')
   FROM (SELECT graph_stage.norm_name(t) AS n) x $$`,
];

type Step = (c: PoolClient) => Promise<void>;

export async function buildGraph(pool: Pool, opts: BuildOptions = {}): Promise<BuildResult> {
  const log = opts.log || ((m: string) => console.log(m));
  if (opts.limit !== undefined && !(Number.isInteger(opts.limit) && opts.limit > 0)) throw new Error(`limit must be a positive integer, got ${opts.limit}`);
  if (opts.fromEdrpou !== undefined && !/^\d{1,8}$/.test(opts.fromEdrpou)) throw new Error(`fromEdrpou must be digits, got ${opts.fromEdrpou}`);
  if (opts.currentDate !== undefined && !DATE_RE.test(opts.currentDate)) throw new Error(`currentDate must be YYYY-MM-DD, got ${opts.currentDate}`);
  const hubOverrides: Partial<HubThresholds> = { ...(opts.hubThresholds || {}) };
  for (const [k, v] of Object.entries(hubOverrides)) {
    if (!NODE_KINDS.includes(k as NodeKind)) throw new Error(`unknown node kind ${k}`);
    if (!(Number.isInteger(v) && (v as number) > 0)) throw new Error(`hub threshold ${k} must be a positive integer`);
  }
  const massOverride = opts.massRegistrationMinDegree;
  if (massOverride !== undefined && !(Number.isInteger(massOverride) && massOverride > 0)) throw new Error('massRegistrationMinDegree must be a positive integer');
  let hubThresholds: ComputedHubThresholds | null = null;
  const gap = opts.regNeighbourMaxGap ?? REG_NEIGHBOUR_MAX_GAP;
  const perDay = opts.regNeighbourMaxPerDay ?? REG_NEIGHBOUR_MAX_PER_DAY;
  if (!(Number.isInteger(gap) && gap >= 1 && Number.isInteger(perDay) && perDay >= 2)) throw new Error('bad reg_neighbour limits');
  const batch = opts.batchSize || 20000;
  const scoped = opts.limit !== undefined;
  const startedAt = new Date();
  const seconds: Record<string, number> = {};
  const counts: Record<string, number | string | null> = {};

  const c = await pool.connect();
  let locked = false;
  const timed = async (name: string, f: Step) => {
    const t = Date.now();
    log(`- ${name}`);
    await f(c);
    seconds[name] = Math.round((Date.now() - t) / 100) / 10;
    log(`  ${name}: ${seconds[name]}s`);
  };
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const count = async (name: string, sql: string, params: unknown[] = []) => {
    counts[name] = Number((await one(sql, params)).n);
    return counts[name] as number;
  };

  try {
    await c.query(`SET statement_timeout = ${lit(opts.statementTimeout || '3h')}`);
    await c.query(`SET work_mem = ${lit(opts.workMem || '256MB')}`);
    // no parallel workers: a database container's small /dev/shm cannot hold parallel hash tables,
    // and the build should not take CPU from live queries
    await c.query('SET max_parallel_workers_per_gather = 0');
    await c.query('SET max_parallel_maintenance_workers = 0');
    if (!opts.dryRun) {
      const lock = await one(`SELECT pg_try_advisory_lock(hashtext('graph_builder')) AS ok`);
      if (!lock.ok) throw new Error('another graph build is running');
      locked = true;
    }

    // ------------------------------------------------------------ source dates
    const snaps = (await c.query(`SELECT snapshot_date::text AS d, fields FROM edr_hist.snapshot WHERE kind = 'uo' ORDER BY snapshot_date`)).rows as Array<{ d: string; fields: string[] }>;
    const fieldRange = (f: string) => {
      const ds = snaps.filter(s => s.fields.includes(f)).map(s => s.d);
      return { min: ds[0] || null, max: ds[ds.length - 1] || null };
    };
    const ranges = { founder: fieldRange('founder'), beneficiary: fieldRange('beneficiary'), head: fieldRange('head'), address: fieldRange('address') };
    const histMax = snaps.length ? snaps[snaps.length - 1].d : null;
    const curDate: string | null = opts.currentDate
      || (await one(`SELECT max(updated_at)::date::text AS d FROM legal_entities`)).d;
    const useCurrent = opts.includeCurrent === 'yes' ? true : opts.includeCurrent === 'no' ? false
      : !!curDate && (!histMax || curDate > histMax);
    if (useCurrent && !curDate) throw new Error('current dump date unknown: pass currentDate');
    const sources = { snapshots: snaps.map(s => s.d), ranges, histMax, currentDate: useCurrent ? curDate : null, useCurrent };
    log(`Sources: snapshots ${snaps.map(s => s.d).join(', ') || 'none'}; current dump ${useCurrent ? curDate : 'not used'}`);
    const params = {
      limit: opts.limit ?? null, fromEdrpou: opts.fromEdrpou ?? null, includeCurrent: opts.includeCurrent || 'auto',
      hubThresholds: hubOverrides, massRegistrationMinDegree: massOverride ?? null, regNeighbour: { maxGap: gap, maxPerDay: perDay }, rekeyAddresses: !!opts.rekeyAddresses,
    };

    if (opts.dryRun) {
      await dryRunCounts(count, scoped, opts, useCurrent);
      return { dryRun: true, params, sources, counts, seconds, hubThresholds: null };
    }

    // ------------------------------------------------------------ staging
    if (!(await one(`SELECT to_regclass('graph.address_key') AS t`)).t) throw new Error('schema graph missing: run migration 030_graph_schema.sql');
    if (!(await one(`SELECT to_regclass('graph.address_flag') AS t`)).t) throw new Error('graph.address_flag missing: run migration 031_graph_hubs_and_organisations.sql');
    await timed('stage', async () => {
      await c.query('DROP SCHEMA IF EXISTS graph_stage CASCADE');
      await c.query('CREATE SCHEMA graph_stage');
      for (const f of STAGE_FUNCS) await c.query(f);
      if (scoped) {
        await c.query(`CREATE UNLOGGED TABLE graph_stage.scope AS
          SELECT edrpou FROM (
            SELECT edrpou FROM edr_hist.company WHERE edrpou >= $1 AND edrpou !~ '[0-9]{10}'
            UNION SELECT edrpou FROM legal_entities WHERE edrpou >= $1 AND edrpou ~ '^\\d{8}$') x
          ORDER BY edrpou LIMIT ${opts.limit}`, [(opts.fromEdrpou || '0').padStart(8, '0')]);
        await c.query('ALTER TABLE graph_stage.scope ADD PRIMARY KEY (edrpou)');
        await count('scope_companies', 'SELECT count(*) AS n FROM graph_stage.scope');
      }
    });
    // a 10-digit code is an individual's РНОКПП, not a company (ЄДРПОУ has 8 digits): such records are skipped
    const inScope = (col: string) => `${col} !~ '[0-9]{10}'${scoped ? ` AND ${col} IN (SELECT edrpou FROM graph_stage.scope)` : ''}`;

    await timed('companies', async () => {
      // the current dump: one record per code, the most alive one
      await c.query(`CREATE UNLOGGED TABLE graph_stage.cur_company AS
        SELECT DISTINCT ON (le.edrpou) le.edrpou, le.record, le.name, le.short_name, le.opf AS legal_form, le.stan AS status,
               graph_stage.ua_date(le.registration) AS registered_on
        FROM legal_entities le
        WHERE ${useCurrent ? 'TRUE' : 'FALSE'} AND le.edrpou ~ '^\\d{8}$' AND ${inScope('le.edrpou')}
        ORDER BY le.edrpou,
          CASE lower(le.stan) WHEN 'зареєстровано' THEN 0 WHEN 'в стані припинення' THEN 2 WHEN 'припинено' THEN 3 WHEN 'скасовано' THEN 4 ELSE 1 END,
          le.updated_at DESC NULLS LAST, le.id DESC`);
      await c.query('ALTER TABLE graph_stage.cur_company ADD PRIMARY KEY (edrpou)');
      await c.query('CREATE INDEX ON graph_stage.cur_company (record)');
      await c.query(`CREATE UNLOGGED TABLE graph_stage.company AS
        SELECT edrpou,
               coalesce(c.name, h.name) AS name, coalesce(c.short_name, h.short_name) AS short_name,
               coalesce(c.legal_form, h.legal_form) AS legal_form, coalesce(c.status, h.status) AS status,
               coalesce(h.registered_on, c.registered_on) AS registered_on, h.kved, h.kind AS hist_kind,
               h.first_seen, h.last_seen, h.edrpou IS NOT NULL AS in_hist, c.edrpou IS NOT NULL AS in_current
        FROM (SELECT * FROM edr_hist.company WHERE ${inScope('edrpou')}) h
        FULL JOIN graph_stage.cur_company c USING (edrpou)`);
      await c.query('ALTER TABLE graph_stage.company ADD PRIMARY KEY (edrpou)');
      await count('companies', 'SELECT count(*) AS n FROM graph_stage.company');
      await count('companies_current_only', 'SELECT count(*) AS n FROM graph_stage.company WHERE NOT in_hist');
      // Ukrainian organisations named without a code are resolved by a company name that is unique
      await c.query(`CREATE UNLOGGED TABLE graph_stage.uniq_name AS
        SELECT name_latn, min(edrpou) AS edrpou FROM edr_hist.company
        WHERE name_latn IS NOT NULL AND length(name_latn) >= 4 AND edrpou ~ '^\\d{8}$' GROUP BY name_latn HAVING count(*) = 1`);
      await c.query('ALTER TABLE graph_stage.uniq_name ADD PRIMARY KEY (name_latn)');
    });

    // ------------------------------------------------------------ current dump entries (JS parse)
    await c.query(`CREATE UNLOGGED TABLE graph_stage.cur_founder (edrpou text, ref text, kind text, name text, name_latn text,
      code text, country_code text, contribution text, contribution_uah numeric)`);
    await c.query(`CREATE UNLOGGED TABLE graph_stage.cur_head (edrpou text, ref text, source text, name text, name_latn text,
      role text, role_class text, appointed_on date)`);
    await c.query(`CREATE UNLOGGED TABLE graph_stage.cur_beneficiary (edrpou text, ref text, name text, name_latn text,
      country_code text, influence text, share text)`);
    if (useCurrent) {
      await timed('current_parse', async () => {
        counts.cur_founder_rows = await streamCurrent(c, 'founders', 'founder_info', batch, (id, edrpou, raw) => {
          const f = parseFounder(raw);
          return [edrpou, `founders:${id}`, f.kind, f.name, uaMatchKey(f.name) || null, f.code, countryIso(f.country), f.contribution, f.contribution_uah];
        }, 'graph_stage.cur_founder', ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'numeric']);
        counts.cur_head_rows = await streamCurrent(c, 'signers', 'signer_info', batch, (id, edrpou, raw) => {
          const h = parseHead(raw, 'signer');
          return [edrpou, `signers:${id}`, 'signer', h.name, uaMatchKey(h.name) || null, h.role, h.role_class, h.appointed_on];
        }, 'graph_stage.cur_head', ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'date']);
        counts.cur_beneficiary_rows = await streamCurrent(c, 'beneficiaries', 'beneficiary_info', batch, (id, edrpou, raw) => {
          const b = parseBeneficiary(raw);
          if (!b.name) return null;
          return [edrpou, `beneficiaries:${id}`, b.name, uaMatchKey(b.name) || null, countryIso(b.country), b.influence, b.share];
        }, 'graph_stage.cur_beneficiary', ['text', 'text', 'text', 'text', 'text', 'text', 'text']);
      });
    }

    // ------------------------------------------------------------ personal numbers in names and texts (LEXAI-2322)
    await timed('personal_ids', async () => {
      counts.person_key_version = `p${PERSON_KEY_VERSION}`;
      counts.names_with_ids = await fixValues(c, 'graph_stage.name_fix', `
        SELECT name AS v FROM edr_hist.founder WHERE name ~ $1 AND ${inScope('edrpou')}
        UNION SELECT name FROM edr_hist.head WHERE name ~ $1 AND ${inScope('edrpou')}
        UNION SELECT name FROM edr_hist.beneficiary WHERE name ~ $1 AND ${inScope('edrpou')}
        UNION SELECT name FROM graph_stage.cur_founder WHERE name ~ $1
        UNION SELECT name FROM graph_stage.cur_head WHERE name ~ $1
        UNION SELECT name FROM graph_stage.cur_beneficiary WHERE name ~ $1`, NAME_ID_PROBE_SQL, v => {
        const clean = stripPersonIds(v);
        return clean === v ? null : [clean, uaMatchKey(clean) || null];
      });
      counts.texts_with_ids = await fixValues(c, 'graph_stage.text_fix', `
        SELECT influence AS v FROM edr_hist.beneficiary WHERE influence ~ $1 AND ${inScope('edrpou')}
        UNION SELECT share FROM edr_hist.beneficiary WHERE share ~ $1 AND ${inScope('edrpou')}
        UNION SELECT role FROM edr_hist.head WHERE role ~ $1 AND ${inScope('edrpou')}
        UNION SELECT influence FROM graph_stage.cur_beneficiary WHERE influence ~ $1
        UNION SELECT share FROM graph_stage.cur_beneficiary WHERE share ~ $1
        UNION SELECT role FROM graph_stage.cur_head WHERE role ~ $1`, TEXT_ID_PROBE_SQL, v => {
        const clean = stripIdNumbers(v);
        return clean === v ? null : [clean, null];
      });
    });
    // the cleaned name / key of an entry (foreign organisations keep theirs: see personal-ids.ts)
    const fixedName = (t: string, nf: string, cond = 'TRUE') =>
      `CASE WHEN ${nf}.raw IS NOT NULL AND ${cond} THEN ${nf}.clean ELSE ${t}.name END AS name,
       CASE WHEN ${nf}.raw IS NOT NULL AND ${cond} THEN ${nf}.clean_key ELSE ${t}.name_latn END AS name_latn`;
    const fixedText = (t: string, col: string, tf: string) => `coalesce(${tf}.clean, ${t}.${col}) AS ${col}`;

    // ------------------------------------------------------------ participations -> one row per entry with its endpoint
    const cd = curDate ? `${lit(curDate)}::date` : 'NULL::date';
    await timed('participations', async () => {
      await c.query(`CREATE UNLOGGED TABLE graph_stage.p_entry (
        edrpou text NOT NULL, rel text NOT NULL, ep_kind text NOT NULL, ep_key text NOT NULL, name text,
        first_seen date NOT NULL, last_seen date NOT NULL, src text NOT NULL, ref text, appointed_on date, code text, attrs jsonb)`);
      // founders: Ukrainian organisation with a code -> company, foreign organisation -> foreign_entity,
      // Ukrainian organisation without a code -> company by unique name (else dropped), person -> person_name
      await c.query(`INSERT INTO graph_stage.p_entry
        WITH f0 AS (
          SELECT edrpou, kind, name, name_latn, code, country_code, contribution, contribution_uah, first_seen, last_seen,
                 'edr_hist' AS src, entry_hash AS ref
          FROM edr_hist.founder WHERE ${inScope('edrpou')}
          UNION ALL
          SELECT edrpou, kind, name, name_latn, code, country_code, contribution, contribution_uah, ${cd}, ${cd}, 'edr_current', ref
          FROM graph_stage.cur_founder
        ), f AS (
          SELECT f0.edrpou, f0.kind, ${fixedName('f0', 'nf', "NOT (f0.kind = 'organisation' AND coalesce(f0.country_code, 'UA') <> 'UA')")},
                 f0.code, f0.country_code, f0.contribution, f0.contribution_uah, f0.first_seen, f0.last_seen, f0.src, f0.ref
          FROM f0 LEFT JOIN graph_stage.name_fix nf ON nf.raw = f0.name
        ), k AS (
          SELECT f.*, graph_stage.placeholder(f.name) AS placeholder,
                 upper(regexp_replace(coalesce(f.code, ''), '[^0-9A-Za-zА-Яа-яІіЇїЄєҐґ]', '', 'g')) AS fcode,
                 CASE WHEN f.kind = 'organisation' AND coalesce(f.country_code, 'UA') = 'UA' THEN
                        CASE WHEN f.code ~ '^0*\\d{1,8}$' AND f.code !~ '^0+$' THEN 'company' ELSE 'ua_org' END
                      WHEN f.kind = 'organisation' THEN 'foreign_entity'
                      ELSE 'person_name' END AS ep
          FROM f
        ), e AS (
          SELECT k.*,
                 CASE k.ep
                   WHEN 'company' THEN lpad(right(regexp_replace(k.code, '^0+(?=\\d{8})', ''), 8), 8, '0')
                   WHEN 'ua_org' THEN u.edrpou
                   WHEN 'foreign_entity' THEN
                     CASE WHEN k.country_code !~ '^[A-Z]{2}$' THEN NULL
                          WHEN NOT k.placeholder AND coalesce(k.name_latn, '') <> '' THEN k.country_code || '|name:' || k.name_latn
                          WHEN length(k.fcode) >= 4 THEN k.country_code || '|code:' || k.fcode END
                   ELSE CASE WHEN NOT k.placeholder THEN nullif(k.name_latn, '') END
                 END AS ep_key,
                 u.edrpou IS NOT NULL AS by_name
          FROM k LEFT JOIN graph_stage.uniq_name u ON k.ep = 'ua_org' AND NOT k.placeholder AND u.name_latn = k.name_latn
        )
        SELECT edrpou, 'founder', CASE WHEN ep = 'ua_org' THEN 'company' ELSE ep END, ep_key, name, first_seen, last_seen, src, ref, NULL,
               CASE WHEN ep = 'foreign_entity' AND length(fcode) >= 4 THEN fcode END,
               jsonb_strip_nulls(jsonb_build_object('contribution', contribution, 'contribution_uah', contribution_uah,
                 'country', country_code, 'resolved_by', CASE WHEN by_name THEN 'unique_name' END))
        FROM e WHERE ep_key IS NOT NULL AND length(edrpou) = 8`);
      // heads / signers: a person -> person_name; an organisation (legal form or code in the name,
      // keys.ts headEndpoint) -> company by the code, else by a unique company name (the founders'
      // rule), else an organisation node; never the company itself
      await c.query(`INSERT INTO graph_stage.p_entry
        WITH h0 AS (
          SELECT edrpou, source, name, name_latn, role, role_class, appointed_on, first_seen, last_seen, 'edr_hist' AS src, entry_hash AS ref
          FROM edr_hist.head WHERE ${inScope('edrpou')}
          UNION ALL
          SELECT edrpou, source, name, name_latn, role, role_class, appointed_on, ${cd}, ${cd}, 'edr_current', ref FROM graph_stage.cur_head
        ), h AS (
          SELECT h0.edrpou, h0.source, ${fixedName('h0', 'nf')}, ${fixedText('h0', 'role', 'tf')},
                 h0.role_class, h0.appointed_on, h0.first_seen, h0.last_seen, h0.src, h0.ref
          FROM h0 LEFT JOIN graph_stage.name_fix nf ON nf.raw = h0.name LEFT JOIN graph_stage.text_fix tf ON tf.raw = h0.role
        ), k AS (
          SELECT h.*, graph_stage.org_name(h.name) AS org, substring(h.name FROM ${lit(CODE8_RE_SOURCE)}) AS code8
          FROM h WHERE coalesce(h.name_latn, '') <> '' AND NOT graph_stage.placeholder(h.name)
        ), e AS (
          SELECT k.*, CASE WHEN k.org AND k.code8 !~ '^0+$' THEN k.code8 END AS ccode FROM k
        ), r AS (
          SELECT e.*, u.edrpou AS by_name FROM e
          LEFT JOIN graph_stage.uniq_name u ON e.org AND e.ccode IS NULL AND u.name_latn = e.name_latn
        )
        SELECT edrpou, CASE WHEN role_class = 'representative' THEN 'signer' ELSE 'head' END,
               CASE WHEN NOT org THEN 'person_name' WHEN coalesce(ccode, by_name) IS NOT NULL THEN 'company' ELSE 'organisation' END,
               CASE WHEN NOT org THEN name_latn ELSE coalesce(ccode, by_name, name_latn) END,
               name, first_seen, last_seen, src, ref, appointed_on, NULL,
               jsonb_strip_nulls(jsonb_build_object('role', role, 'role_class', role_class, 'appointed_on', appointed_on, 'entry', source,
                 'resolved_by', CASE WHEN ccode IS NOT NULL THEN 'code' WHEN by_name IS NOT NULL THEN 'unique_name' END))
        FROM r WHERE NOT org OR coalesce(ccode, by_name) IS DISTINCT FROM edrpou`);
      await c.query(`INSERT INTO graph_stage.p_entry
        WITH b0 AS (
          SELECT edrpou, name, name_latn, country_code, influence, share, first_seen, last_seen, 'edr_hist' AS src, entry_hash AS ref
          FROM edr_hist.beneficiary WHERE name IS NOT NULL AND ${inScope('edrpou')}
          UNION ALL
          SELECT edrpou, name, name_latn, country_code, influence, share, ${cd}, ${cd}, 'edr_current', ref FROM graph_stage.cur_beneficiary
        ), b AS (
          SELECT b0.edrpou, ${fixedName('b0', 'nf')}, b0.country_code, ${fixedText('b0', 'influence', 'ti')}, ${fixedText('b0', 'share', 'ts')},
                 b0.first_seen, b0.last_seen, b0.src, b0.ref
          FROM b0 LEFT JOIN graph_stage.name_fix nf ON nf.raw = b0.name
          LEFT JOIN graph_stage.text_fix ti ON ti.raw = b0.influence LEFT JOIN graph_stage.text_fix ts ON ts.raw = b0.share
        )
        SELECT edrpou, 'beneficiary', 'person_name', name_latn, name, first_seen, last_seen, src, ref, NULL, NULL,
               jsonb_strip_nulls(jsonb_build_object('country', country_code, 'influence', influence, 'share', share))
        FROM b WHERE coalesce(name_latn, '') <> '' AND NOT graph_stage.placeholder(name)`);
      await count('participation_rows', 'SELECT count(*) AS n FROM graph_stage.p_entry');
      await count('founder_resolved_by_name', `SELECT count(*) AS n FROM graph_stage.p_entry WHERE rel = 'founder' AND attrs ? 'resolved_by'`);
      // LEXAI-2318: head / signer entries that name an organisation, by endpoint
      for (const r of (await c.query(`SELECT ep_kind || coalesce('_' || (attrs->>'resolved_by'), '') AS k, count(*) AS n,
          count(DISTINCT (ep_key, edrpou, rel)) AS rels
        FROM graph_stage.p_entry WHERE rel IN ('head', 'signer') AND ep_kind <> 'person_name' GROUP BY 1`)).rows) {
        counts[`head_entries_to_${r.k}`] = Number(r.n);
        counts[`head_relations_to_${r.k}`] = Number(r.rels);
      }
    });

    // ------------------------------------------------------------ addresses
    const renamings = await loadRenamings(c, opts, log);
    const keyVersion = addressKeyVersion(renamings.fingerprint);
    counts.address_key_version = keyVersion;
    await timed('address_runs', async () => {
      await c.query(`CREATE UNLOGGED TABLE graph_stage.addr_run AS
        SELECT edrpou, value AS raw, md5(value) AS raw_md5, first_snapshot, last_snapshot
        FROM edr_hist.history WHERE field = 'address' AND value IS NOT NULL AND value <> '' AND ${inScope('edrpou')}`);
      await count('address_runs', 'SELECT count(*) AS n FROM graph_stage.addr_run');
    });
    await timed('address_keys', async () => {
      counts.addresses_keyed = await keyAddresses(c, keyVersion, renamings.lookup, batch, !!opts.rekeyAddresses, log);
      await count('address_distinct_raw', 'SELECT count(DISTINCT raw_md5) AS n FROM graph_stage.addr_run');
    });
    // LEXAI-2317: ProZorro supplier addresses (graph_stage.pz_run; empty when disabled)
    await timed('prozorro_addresses', async () => {
      Object.assign(counts, await stageProzorroAddresses(c, {
        inScope: col => (opts.prozorroAddresses === false ? 'FALSE' : inScope(col)), keyVersion, batch, log,
        keyRaws: t => keyAddresses(c, keyVersion, renamings.lookup, batch, !!opts.rekeyAddresses, log, t),
      }));
    });

    // ------------------------------------------------------------ edges by (kind, key)
    const fieldOf: Record<string, keyof typeof ranges> = { founder: 'founder', beneficiary: 'beneficiary', head: 'head', signer: 'head' };
    const fieldMin = (rel: string) => ranges[fieldOf[rel]].min;
    const fieldMax = (rel: string) => ranges[fieldOf[rel]].max;
    const caseRel = (f: (rel: string) => string | null) =>
      `CASE p.rel ${Object.keys(fieldOf).map(r => `WHEN '${r}' THEN ${f(r) ? `${lit(f(r)!)}::date` : 'NULL::date'}`).join(' ')} END`;
    await timed('edges_raw', async () => {
      await c.query(`CREATE UNLOGGED TABLE graph_stage.e_raw (
        src_kind text, src_key text, dst_kind text, dst_key text, kind text, valid_from date, valid_to date,
        source text, source_ref jsonb, attrs jsonb, src_label text, codes text[])`);
      // participations: the merged relation is current when the newest dump (current tables, or
      // the newest snapshot publishing the field when history is current) still lists it
      await c.query(`INSERT INTO graph_stage.e_raw
        WITH g AS (
          SELECT p.ep_kind, p.ep_key, p.edrpou, p.rel,
                 min(p.first_seen) AS first_seen, max(p.last_seen) AS last_seen,
                 min(p.first_seen) FILTER (WHERE p.src = 'edr_hist') AS h_first,
                 max(p.last_seen) FILTER (WHERE p.src = 'edr_hist') AS h_last,
                 bool_or(p.src = 'edr_current') AS in_cur, bool_or(p.src = 'edr_hist') AS in_hist,
                 min(p.appointed_on) AS appointed_on,
                 (array_agg(p.attrs ORDER BY p.last_seen DESC, p.src DESC))[1] AS attrs,
                 (array_agg(p.name ORDER BY p.last_seen DESC, p.src DESC))[1] AS label,
                 (array_agg(p.ref ORDER BY p.last_seen DESC) FILTER (WHERE p.src = 'edr_hist'))[1:5] AS h_refs,
                 (array_agg(p.ref ORDER BY p.ref) FILTER (WHERE p.src = 'edr_current'))[1:5] AS c_refs,
                 array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL) AS codes,
                 ${caseRel(fieldMin)} AS f_min, ${caseRel(fieldMax)} AS f_max
          FROM graph_stage.p_entry p
          GROUP BY p.ep_kind, p.ep_key, p.edrpou, p.rel
        )
        SELECT ep_kind, ep_key, 'company', edrpou, rel,
               CASE WHEN appointed_on IS NOT NULL AND appointed_on <= first_seen THEN appointed_on
                    WHEN in_hist AND h_first <= f_min THEN NULL
                    ELSE first_seen END,
               CASE WHEN ${useCurrent ? 'in_cur' : 'last_seen >= f_max'} THEN NULL ELSE last_seen END,
               CASE WHEN in_hist THEN 'edr_hist' ELSE 'edr_current' END,
               jsonb_strip_nulls(jsonb_build_object(
                 'hist', CASE WHEN in_hist THEN jsonb_build_object('first_seen', h_first, 'last_seen', h_last, 'entries', to_jsonb(h_refs)) END,
                 'current', CASE WHEN in_cur THEN jsonb_build_object('dump', ${cd}, 'rows', to_jsonb(c_refs)) END)),
               attrs, label, codes
        FROM g`);
      // registered_at: address runs per (company, building key); the newest dumps publish no
      // addresses, so an open run is the latest known address (attrs.confirmed_until)
      const aMin = ranges.address.min ? `${lit(ranges.address.min)}::date` : 'NULL::date';
      const aMax = ranges.address.max ? `${lit(ranges.address.max)}::date` : 'NULL::date';
      await c.query(`INSERT INTO graph_stage.e_raw
        SELECT 'company', a.edrpou, 'address', k.address_key, 'registered_at',
               CASE WHEN min(a.first_snapshot) <= ${aMin} THEN NULL ELSE min(a.first_snapshot) END,
               CASE WHEN bool_or(a.last_snapshot IS NULL) THEN NULL ELSE max(a.last_snapshot) END,
               'edr_hist',
               jsonb_build_object('hist', jsonb_build_object('field', 'address', 'first_seen', min(a.first_snapshot),
                 'last_seen', coalesce(max(a.last_snapshot) FILTER (WHERE NOT a.open), ${aMax}),
                 'values', to_jsonb((array_agg(DISTINCT a.raw_md5))[1:5]))),
               jsonb_strip_nulls(jsonb_build_object(
                 'premises', (array_agg(k.premises_key ORDER BY a.open DESC, a.last_snapshot DESC NULLS FIRST))[1],
                 'raw', (array_agg(a.raw ORDER BY a.open DESC, a.last_snapshot DESC NULLS FIRST))[1],
                 'confirmed_until', CASE WHEN bool_or(a.open) THEN ${aMax} END)),
               NULL, NULL
        FROM (SELECT r.*, r.last_snapshot IS NULL AS open FROM graph_stage.addr_run r) a
        JOIN graph.address_key k ON k.raw_md5 = a.raw_md5
        WHERE k.address_key IS NOT NULL
        GROUP BY a.edrpou, k.address_key`);
      Object.assign(counts, await prozorroAddressEdges(c, ranges.address.max));
      // reg_neighbour: same registration day, serials (code div 10) at most maxGap apart, chained to
      // the next code of the day; days with more than maxPerDay registrations are skipped
      await c.query(`INSERT INTO graph_stage.e_raw
        WITH d AS (
          SELECT edrpou, registered_on, in_hist, (edrpou::bigint / 10) AS serial,
                 count(*) OVER (PARTITION BY registered_on) AS day_n
          FROM graph_stage.company WHERE registered_on IS NOT NULL AND edrpou ~ '^\\d{8}$'
        ), l AS (
          SELECT d.*, lag(edrpou) OVER w AS prev_code, lag(serial) OVER w AS prev_serial, lag(in_hist) OVER w AS prev_hist
          FROM d WINDOW w AS (PARTITION BY registered_on ORDER BY serial, edrpou)
        )
        SELECT 'company', prev_code, 'company', edrpou, 'reg_neighbour', registered_on, NULL,
               CASE WHEN in_hist AND prev_hist THEN 'edr_hist' ELSE 'edr_current' END,
               jsonb_build_object('registered_on', registered_on),
               jsonb_build_object('gap', serial - prev_serial, 'day_registrations', day_n),
               NULL, NULL
        FROM l WHERE prev_code IS NOT NULL AND serial - prev_serial <= ${gap} AND day_n <= ${perDay}`);
      await count('edges', 'SELECT count(*) AS n FROM graph_stage.e_raw');
      for (const r of (await c.query('SELECT kind, count(*) AS n FROM graph_stage.e_raw GROUP BY kind ORDER BY kind')).rows) counts[`edges_${r.kind}`] = Number(r.n);
      counts.edges_current = Number((await one('SELECT count(*) AS n FROM graph_stage.e_raw WHERE valid_to IS NULL')).n);
      // intermediates are dropped as soon as they are used: the staging peak stays near the size of the graph
      await c.query(`DROP TABLE graph_stage.p_entry, graph_stage.cur_founder, graph_stage.cur_head, graph_stage.cur_beneficiary, graph_stage.addr_todo,
        graph_stage.name_fix, graph_stage.text_fix`);
    });

    // ------------------------------------------------------------ nodes with degree and hub flag
    await timed('nodes', async () => {
      await c.query(`CREATE UNLOGGED TABLE graph_stage.deg AS
        SELECT kind, key, sum(n)::int AS degree, jsonb_object_agg(ek, n) AS by_kind
        FROM (SELECT kind, key, ek, count(*) AS n FROM (
                SELECT src_kind AS kind, src_key AS key, kind AS ek FROM graph_stage.e_raw
                UNION ALL SELECT dst_kind, dst_key, kind FROM graph_stage.e_raw) x
              GROUP BY 1, 2, 3) y
        GROUP BY kind, key`);
      // hub thresholds from the degree distribution of this build (keys.ts HUB_POLICY)
      const ps = hubPercentiles();
      const observed: Partial<Record<NodeKind, Record<string, number>>> = {};
      for (const r of (await c.query(`SELECT kind, percentile_disc($1::float8[]) WITHIN GROUP (ORDER BY degree) AS v
          FROM graph_stage.deg GROUP BY kind`, [ps])).rows) {
        observed[r.kind as NodeKind] = Object.fromEntries(ps.map((p, i) => [String(p), Number(r.v[i])]));
      }
      const ht = computeHubThresholds(observed, hubOverrides, massOverride);
      hubThresholds = ht;
      const t = ht.thresholds;
      log(`  hub thresholds ${JSON.stringify(t)}, mass registration >= ${ht.massRegistrationMinDegree}`);
      const thr = `CASE d.kind ${NODE_KINDS.map(k => `WHEN '${k}' THEN ${t[k]}`).join(' ')} END`;
      const mass = ht.massRegistrationMinDegree;
      // labels and attributes of the participants (persons, foreign entities, companies only seen as founders)
      await c.query(`CREATE UNLOGGED TABLE graph_stage.ep_label AS
        SELECT src_kind AS kind, src_key AS key, mode() WITHIN GROUP (ORDER BY src_label) AS label,
               array_agg(DISTINCT cd) FILTER (WHERE cd IS NOT NULL) AS codes
        FROM graph_stage.e_raw LEFT JOIN LATERAL unnest(codes) AS cd ON true
        WHERE src_kind IN ('person_name', 'foreign_entity', 'company', 'organisation') AND src_label IS NOT NULL
        GROUP BY 1, 2`);
      await c.query(`CREATE UNLOGGED TABLE graph_stage.addr_label AS
        SELECT k.address_key AS key, mode() WITHIN GROUP (ORDER BY k.label) AS label, min(k.settlement_key) AS settlement_key
        FROM (SELECT raw_md5 FROM graph_stage.addr_run UNION ALL SELECT raw_md5 FROM graph_stage.pz_run) a
        JOIN graph.address_key k ON k.raw_md5 = a.raw_md5
        WHERE k.address_key IS NOT NULL GROUP BY 1`);
      for (const ddl of stageDdl('graph_stage')) await c.query(ddl);
      await c.query(`INSERT INTO graph_stage.node (kind, key, label, degree, hub, attrs)
        SELECT d.kind, d.key,
               CASE d.kind WHEN 'company' THEN coalesce(co.name, el.label) WHEN 'address' THEN coalesce(al.label, d.key) ELSE el.label END,
               d.degree,
               CASE WHEN af.flag = 'not_hub' THEN false
                    WHEN d.kind = 'address' AND (af.flag = 'mass_registration' OR d.degree >= ${mass}) THEN true
                    ELSE d.degree > ${thr} END,
               jsonb_strip_nulls(jsonb_build_object('degree_by_kind', d.by_kind)
                 || CASE d.kind
                      WHEN 'company' THEN jsonb_build_object('short_name', co.short_name, 'status', co.status, 'legal_form', co.legal_form,
                        'kved', co.kved, 'registered_on', co.registered_on, 'first_seen', co.first_seen, 'last_seen', co.last_seen,
                        'in_current', co.in_current, 'branch', CASE WHEN co.hist_kind = 'fsu' THEN true END,
                        'unregistered', CASE WHEN co.edrpou IS NULL THEN true END)
                      WHEN 'foreign_entity' THEN jsonb_build_object('country_code', split_part(d.key, '|', 1), 'codes', to_jsonb(el.codes))
                      WHEN 'address' THEN jsonb_build_object('settlement_key', al.settlement_key, 'key_version', ${lit(keyVersion)},
                        'flag', af.flag,
                        'mass_registration', CASE WHEN af.flag = 'not_hub' THEN NULL WHEN af.flag = 'mass_registration' THEN 'list'
                                                  WHEN d.degree >= ${mass} THEN 'degree' END)
                      ELSE '{}'::jsonb END)
        FROM graph_stage.deg d
        LEFT JOIN graph_stage.company co ON d.kind = 'company' AND co.edrpou = d.key
        LEFT JOIN graph_stage.ep_label el ON el.kind = d.kind AND el.key = d.key
        LEFT JOIN graph_stage.addr_label al ON d.kind = 'address' AND al.key = d.key
        LEFT JOIN graph.address_flag af ON d.kind = 'address' AND af.address_key = d.key
        UNION ALL
        SELECT 'company', co.edrpou, co.name, 0, false,
               jsonb_strip_nulls(jsonb_build_object('short_name', co.short_name, 'status', co.status, 'legal_form', co.legal_form,
                 'kved', co.kved, 'registered_on', co.registered_on, 'first_seen', co.first_seen, 'last_seen', co.last_seen,
                 'in_current', co.in_current, 'branch', CASE WHEN co.hist_kind = 'fsu' THEN true END))
        FROM graph_stage.company co
        WHERE NOT EXISTS (SELECT 1 FROM graph_stage.deg d WHERE d.kind = 'company' AND d.key = co.edrpou)`);
      for (const r of (await c.query('SELECT kind, count(*) AS n, count(*) FILTER (WHERE hub) AS hubs FROM graph_stage.node GROUP BY kind ORDER BY kind')).rows) {
        counts[`nodes_${r.kind}`] = Number(r.n);
        counts[`hubs_${r.kind}`] = Number(r.hubs);
      }
      counts.mass_registration_addresses = Number((await one(`SELECT count(*) AS n FROM graph_stage.node WHERE kind = 'address' AND attrs ? 'mass_registration'`)).n);
      await c.query('ALTER TABLE graph_stage.node ADD CONSTRAINT node_kind_key UNIQUE (kind, key)');
    });

    await timed('edges', async () => {
      await c.query(`INSERT INTO graph_stage.edge (src, dst, kind, valid_from, valid_to, source, source_ref, attrs)
        SELECT s.id, d.id, e.kind, e.valid_from, e.valid_to, e.source, e.source_ref, e.attrs
        FROM graph_stage.e_raw e
        JOIN graph_stage.node s ON s.kind = e.src_kind AND s.key = e.src_key
        JOIN graph_stage.node d ON d.kind = e.dst_kind AND d.key = e.dst_key`);
      await c.query('DROP TABLE graph_stage.e_raw, graph_stage.deg, graph_stage.ep_label, graph_stage.addr_label, graph_stage.addr_run, graph_stage.pz_run');
    });
    if (opts.court !== false) {
      await timed('court_edges', async () => {
        Object.assign(counts, await buildCourtEdges(c, opts.court || {}));
      });
    }
    await timed('indexes', async () => {
      await c.query(`SET maintenance_work_mem = '1GB'`);
      for (const ddl of stageIndexDdl('graph_stage').filter(d => !d.includes('node_kind_key'))) await c.query(ddl);
      await c.query('ANALYZE graph_stage.node');
      await c.query('ANALYZE graph_stage.edge');
      await c.query('RESET maintenance_work_mem');
    });
    await timed('check_personal_ids', async () => {
      Object.assign(counts, await checkPersonalIds(c, 'graph_stage'));
    });
    const size = await one(`SELECT pg_total_relation_size('graph_stage.node') AS n, pg_total_relation_size('graph_stage.edge') AS e`);
    counts.bytes_node = Number(size.n);
    counts.bytes_edge = Number(size.e);
    counts.bytes_address_key = Number((await one(`SELECT pg_total_relation_size('graph.address_key') AS n`)).n);

    await timed('swap', async () => {
      await c.query('BEGIN');
      try {
        await c.query(`SET LOCAL lock_timeout = '60s'`);
        await c.query('DROP TABLE IF EXISTS graph.edge');
        await c.query('DROP TABLE IF EXISTS graph.node');
        await c.query('ALTER TABLE graph_stage.node SET SCHEMA graph');
        await c.query('ALTER TABLE graph_stage.edge SET SCHEMA graph');
        await c.query(`INSERT INTO graph.build (started_at, params, sources, counts, seconds, hub_thresholds) VALUES ($1, $2, $3, $4, $5, $6)`,
          [startedAt, params, sources, counts, seconds, hubThresholds]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
    if (!opts.keepStage) await c.query('DROP SCHEMA IF EXISTS graph_stage CASCADE');
    seconds.total = Math.round((Date.now() - startedAt.getTime()) / 100) / 10;
    log(`Graph built in ${seconds.total}s: ${counts.edges} edges`);
    return { dryRun: false, params, sources, counts, seconds, hubThresholds };
  } catch (e) {
    if (!opts.keepStage && !opts.dryRun) await c.query('DROP SCHEMA IF EXISTS graph_stage CASCADE').catch(() => undefined);
    throw e;
  } finally {
    await c.query('RESET statement_timeout').catch(() => undefined);
    await c.query('RESET work_mem').catch(() => undefined);
    await c.query('RESET max_parallel_workers_per_gather').catch(() => undefined);
    if (locked) await c.query(`SELECT pg_advisory_unlock(hashtext('graph_builder'))`).catch(() => undefined);
    c.release();
  }
}

/**
 * The values matching a prefilter (a small set) cleaned in JS into `target` (raw, clean, clean_key);
 * fix returns null for a value it leaves unchanged. Returns the number of changed values.
 */
async function fixValues(c: PoolClient, target: string, selectSql: string, probe: string,
  fix: (v: string) => [string, string | null] | null): Promise<number> {
  await c.query(`CREATE UNLOGGED TABLE ${target} (raw text PRIMARY KEY, clean text NOT NULL, clean_key text)`);
  const rows: Array<[string, string, string | null]> = [];
  for (const r of (await c.query(`SELECT v FROM (${selectSql}) x WHERE v IS NOT NULL`, [probe])).rows) {
    const f = fix(String(r.v));
    if (f) rows.push([String(r.v), f[0], f[1]]);
  }
  for (let i = 0; i < rows.length; i += 20000) {
    const b = rows.slice(i, i + 20000);
    await c.query(`INSERT INTO ${target} SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ON CONFLICT DO NOTHING`,
      [b.map(x => x[0]), b.map(x => x[1]), b.map(x => x[2])]);
  }
  await c.query(`ANALYZE ${target}`);
  return rows.length;
}

/**
 * Post-build check (LEXAI-2322): no standalone 10-digit run (a РНОКПП) in a node label or key, or
 * in an edge attribute. Foreign entities are exempt (their keys / codes are registration numbers,
 * a Russian company's ИНН has 10 digits), so are the amounts contribution / contribution_uah and
 * source_ref (entry hashes). Throws, so a build that leaks personal numbers is never swapped in;
 * --keep-stage leaves graph_stage for inspection. The same check on the live graph:
 *
 *   SELECT count(*) FROM graph.node WHERE kind <> 'foreign_entity'
 *     AND (label ~ '(^|[^0-9])[0-9]{10}([^0-9]|$)' OR key ~ '(^|[^0-9])[0-9]{10}([^0-9]|$)');
 *   SELECT count(*) FROM graph.edge WHERE (attrs - 'contribution' - 'contribution_uah')::text ~ '(^|[^0-9])[0-9]{10}([^0-9]|$)';
 */
export async function checkPersonalIds(c: Pick<PoolClient, 'query'>, schema: string): Promise<{ id_numbers_nodes: number; id_numbers_edges: number }> {
  const n = (await c.query(`SELECT kind, count(*) AS n FROM ${schema}.node
    WHERE kind <> 'foreign_entity' AND (label ~ $1 OR key ~ $1) GROUP BY kind`, [TEN_DIGITS_SQL])).rows as Array<{ kind: string; n: string }>;
  const e = (await c.query(`SELECT kind, count(*) AS n FROM ${schema}.edge
    WHERE (attrs - 'contribution' - 'contribution_uah')::text ~ $1 GROUP BY kind`, [TEN_DIGITS_SQL])).rows as Array<{ kind: string; n: string }>;
  const sum = (rows: Array<{ n: string }>) => rows.reduce((a, r) => a + Number(r.n), 0);
  const res = { id_numbers_nodes: sum(n), id_numbers_edges: sum(e) };
  if (res.id_numbers_nodes || res.id_numbers_edges) {
    const by = (rows: Array<{ kind: string; n: string }>) => rows.map(r => `${r.kind} ${r.n}`).join(', ') || 'none';
    throw new Error(`personal ID numbers (10-digit runs) left in the graph: ${res.id_numbers_nodes} nodes (${by(n)}), `
      + `${res.id_numbers_edges} edges (${by(e)}); see graph-norm/personal-ids.ts. Not swapped in.`);
  }
  return res;
}

/** Read one current dump table in id order (keyset batches), parse each entry, insert the rows. */
async function streamCurrent(
  c: PoolClient, table: string, col: string, batch: number,
  parse: (id: number, edrpou: string, raw: string) => unknown[] | null,
  target: string, types: string[],
): Promise<number> {
  // one join of the whole table, then keyset pages over the staged copy
  const raw = `graph_stage.raw_${table}`;
  await c.query(`CREATE UNLOGGED TABLE ${raw} AS
    SELECT t.id, cc.edrpou, t.${col} AS raw FROM ${table} t
    JOIN graph_stage.cur_company cc ON cc.record = t.entity_record WHERE t.entity_type = 'UO'`);
  await c.query(`ALTER TABLE ${raw} ADD PRIMARY KEY (id)`);
  let last = 0;
  let n = 0;
  for (;;) {
    const r = await c.query(`SELECT id, edrpou, raw FROM ${raw} WHERE id > $1 ORDER BY id LIMIT ${batch}`, [last]);
    if (!r.rows.length) break;
    last = Number(r.rows[r.rows.length - 1].id);
    const rows: unknown[][] = [];
    for (const x of r.rows) {
      const row = parse(Number(x.id), x.edrpou, String(x.raw || ''));
      if (row) rows.push(row);
    }
    if (rows.length) {
      await c.query(`INSERT INTO ${target} SELECT * FROM unnest(${types.map((t, i) => `$${i + 1}::${t}[]`).join(', ')})`,
        types.map((_, i) => rows.map(row => (row[i] === undefined ? null : row[i]))));
    }
    n += rows.length;
  }
  await c.query(`DROP TABLE ${raw}`);
  return n;
}

async function loadRenamings(c: PoolClient, opts: BuildOptions, log: (m: string) => void): Promise<{ lookup: StreetRenamingLookup | null; fingerprint: string | null }> {
  if (opts.streetRenamings !== undefined) return { lookup: opts.streetRenamings, fingerprint: opts.renamingFingerprint ?? null };
  try {
    const idx = await new StreetRenamingsCache(c).get();
    if (!idx.size) return { lookup: null, fingerprint: null };
    const s = idx.stats;
    return { lookup: idx, fingerprint: `${idx.size}.${s.rows}.${s.scoped}.${s.global}.${s.ambiguous}` };
  } catch (e) {
    log(`  street renamings not loaded (${(e as Error).message}): addresses keyed without them`);
    return { lookup: null, fingerprint: null };
  }
}

/** Key the raw addresses of this build (`source`: columns raw_md5, raw) that graph.address_key lacks for this key version. */
async function keyAddresses(c: PoolClient, version: string, renamings: StreetRenamingLookup | null, batch: number,
  rekey: boolean, log: (m: string) => void, source = 'graph_stage.addr_run'): Promise<number> {
  await c.query('DROP TABLE IF EXISTS graph_stage.addr_todo');
  await c.query(`CREATE UNLOGGED TABLE graph_stage.addr_todo AS
    SELECT row_number() OVER () AS i, raw_md5, raw FROM (
      SELECT DISTINCT ON (a.raw_md5) a.raw_md5, a.raw FROM ${source} a
      ${rekey ? '' : 'LEFT JOIN graph.address_key k ON k.raw_md5 = a.raw_md5 AND k.key_version = $1 WHERE k.raw_md5 IS NULL'}
      ORDER BY a.raw_md5) x`, rekey ? [] : [version]);
  const total = Number((await c.query('SELECT count(*) AS n FROM graph_stage.addr_todo')).rows[0].n);
  log(`  ${total} addresses to key (version ${version})`);
  const cols = ['raw_md5', 'raw', 'key_version', 'parse_status', 'settlement_key', 'street_key', 'address_key', 'premises_key', 'label'] as const;
  for (let lo = 0; lo < total; lo += batch) {
    const r = await c.query('SELECT raw FROM graph_stage.addr_todo WHERE i > $1 AND i <= $2', [lo, lo + batch]);
    const rows = r.rows.map(x => addressKeyRow(String(x.raw), version, { streetRenamings: renamings }));
    await c.query(`INSERT INTO graph.address_key (${cols.join(', ')})
      SELECT * FROM unnest(${cols.map((_, i) => `$${i + 1}::text[]`).join(', ')})
      ON CONFLICT (raw_md5) DO UPDATE SET key_version = EXCLUDED.key_version, parse_status = EXCLUDED.parse_status,
        settlement_key = EXCLUDED.settlement_key, street_key = EXCLUDED.street_key, address_key = EXCLUDED.address_key,
        premises_key = EXCLUDED.premises_key, label = EXCLUDED.label, keyed_at = now()`,
      cols.map(col => rows.map(row => row[col])));
    if ((lo / batch) % 20 === 19) log(`  keyed ${Math.min(lo + batch, total)}/${total}`);
  }
  return total;
}

/** --dry-run: source row counts and distinct endpoint keys, read-only. */
async function dryRunCounts(count: (n: string, sql: string, p?: unknown[]) => Promise<number>, scoped: boolean,
  opts: BuildOptions, useCurrent: boolean): Promise<void> {
  const from = (opts.fromEdrpou || '0').padStart(8, '0');
  const scope = scoped
    ? `edrpou IN (SELECT edrpou FROM edr_hist.company WHERE edrpou >= ${lit(from)} ORDER BY edrpou LIMIT ${opts.limit})`
    : 'TRUE';
  await count('hist_companies', `SELECT count(*) AS n FROM edr_hist.company WHERE ${scope}`);
  await count('hist_founder_rows', `SELECT count(*) AS n FROM edr_hist.founder WHERE ${scope}`);
  await count('hist_head_rows', `SELECT count(*) AS n FROM edr_hist.head WHERE ${scope}`);
  await count('hist_beneficiary_rows', `SELECT count(*) AS n FROM edr_hist.beneficiary WHERE name IS NOT NULL AND ${scope}`);
  await count('hist_founder_relations', `SELECT count(*) AS n FROM (SELECT DISTINCT edrpou, coalesce(nullif(code, ''), name_latn) FROM edr_hist.founder WHERE ${scope}) x`);
  await count('hist_head_relations', `SELECT count(*) AS n FROM (SELECT DISTINCT edrpou, name_latn, role_class = 'representative' FROM edr_hist.head WHERE ${scope}) x`);
  await count('hist_beneficiary_relations', `SELECT count(*) AS n FROM (SELECT DISTINCT edrpou, name_latn FROM edr_hist.beneficiary WHERE name IS NOT NULL AND ${scope}) x`);
  await count('hist_person_keys', `SELECT count(*) AS n FROM (
      SELECT name_latn FROM edr_hist.founder WHERE kind = 'person' AND ${scope}
      UNION SELECT name_latn FROM edr_hist.head WHERE ${scope}
      UNION SELECT name_latn FROM edr_hist.beneficiary WHERE ${scope}) x`);
  await count('hist_foreign_keys', `SELECT count(*) AS n FROM (SELECT DISTINCT country_code, name_latn FROM edr_hist.founder
      WHERE kind = 'organisation' AND country_code <> 'UA' AND ${scope}) x`);
  await count('address_runs', `SELECT count(*) AS n FROM edr_hist.history WHERE field = 'address' AND ${scope}`);
  await count('reg_neighbour_candidates', `SELECT count(*) AS n FROM (
      SELECT edrpou::bigint / 10 - lag(edrpou::bigint / 10) OVER (PARTITION BY registered_on ORDER BY edrpou) AS g
      FROM edr_hist.company WHERE registered_on IS NOT NULL AND edrpou ~ '^\\d{8}$' AND ${scope}) x
      WHERE g <= ${opts.regNeighbourMaxGap ?? REG_NEIGHBOUR_MAX_GAP}`);
  if (useCurrent) {
    const cs = scoped ? `entity_record IN (SELECT record FROM legal_entities WHERE ${scope})` : 'TRUE';
    await count('current_companies', `SELECT count(DISTINCT edrpou) AS n FROM legal_entities WHERE ${scope}`);
    await count('current_founder_rows', `SELECT count(*) AS n FROM founders WHERE entity_type = 'UO' AND ${cs}`);
    await count('current_signer_rows', `SELECT count(*) AS n FROM signers WHERE entity_type = 'UO' AND ${cs}`);
    await count('current_beneficiary_rows', `SELECT count(*) AS n FROM beneficiaries WHERE entity_type = 'UO' AND ${cs}`);
  }
}
