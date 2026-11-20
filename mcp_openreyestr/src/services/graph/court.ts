/**
 * Co-party edges from court decisions (LEXAI-2304): companies that were parties of the same
 * decisions of the state court decision registry (ЄДРСР).
 *
 * Cross-database design. The decision parties (edrsr_parties, extracted from the claim clause
 * "за позовом X до Y", LEXAI-1760) live in the backend database; the graph is built in the
 * openreyestr database. Two independent steps:
 *   1. loadCourtParties (scripts/load-court-parties.ts) copies, year by year, the parties that
 *      carry an 8-digit ЄДРПОУ printed in the caption into graph.court_party (migration 032). A
 *      year is replaced in one transaction and logged in graph.court_party_load; unchanged years
 *      (edrsr_parties_coverage.built_at not newer than the copy) are skipped, the last two years
 *      are always refreshed (new decisions arrive through the harvest triggers).
 *   2. buildCourtEdges, a builder step, aggregates graph.court_party into co_party edges.
 * So the builder keeps one connection to one database (its staging / swap / advisory lock stay
 * in one transaction scope), the copy is small (≈2.6M rows, all years) and cheap (≈1-2 s per
 * year on prod, a partition scan), and a failed or missing copy only means no court edges.
 *
 * Personal data: only company codes cross the databases. Parties without a code, or with a
 * 10-digit code (a ФОП / individual's РНОКПП), are never copied; names are not copied at all.
 * There are no person or case nodes: individuals in ЄДРСР texts are depersonalised, and court
 * cases are linked for companies only (cases are not searched by private persons).
 *
 * Model: one edge per pair of companies (src = lower code, dst = higher code), over all their
 * common decisions: attrs.decisions / cases (distinct case numbers) / roles (role pair counts,
 * 'plaintiff-defendant' = src was a plaintiff and dst a defendant) / justice_kinds;
 * valid_from / valid_to = first / last decision date (a court relation is an event, not a state:
 * currentOnly walks leave it out); source_ref.edrsr = the load date, the newest decision ids
 * and up to five case numbers.
 * Chosen over case nodes + party edges: one hop between companies (the question asked is "who
 * litigates with whom"), one edge per pair instead of one per decision (≈1M pair-decisions fold
 * into ≈200K edges on prod), no new node kind for traversals and hubs to handle.
 *
 * Volume bounds: decisions with more than maxPartiesPerDecision coded parties are skipped (mass
 * decisions, quadratic in pairs; 3 decisions on prod); both endpoints must be companies of the
 * build (graph_stage.company, so a sample build stays a sample and a mistyped code makes no
 * node). Litigation hubs: a company with more co-party counterparties than the threshold
 * (COURT_HUB_POLICY over the counterparty distribution, the hub rule of keys.ts) is marked
 * node.hub (banks, tax offices, utilities with thousands of debtors) so a walk reaches it but
 * does not expand it; attrs.court records the counts and why. The ЄДР hub flags are computed
 * before this step and are not changed otherwise.
 */
import type { Pool, PoolClient } from 'pg';
import type { HubPolicy } from './keys';

export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

/** edrsr_parties.role -> the name used in edge attrs */
export const COURT_ROLES: Record<number, string> = { 1: 'plaintiff', 2: 'defendant', 3: 'third_party' };
/** Decisions with more coded parties than this make no pairs (prod: 3 of 670K multi-party decisions). */
export const COURT_MAX_PARTIES_PER_DECISION = 10;
/**
 * Litigation hub: more co-party counterparties than max(floor, counterparties at the percentile).
 * Prod, all years (20.11.2026): 119K companies with co-party edges, counterparties p99 27,
 * p99.9 245, p99.99 1053, max 6402.
 */
export const COURT_HUB_POLICY: HubPolicy = { percentile: 0.999, floor: 100 };
/** References kept per edge (newest decisions first). */
export const COURT_REFS = 5;

/** Case number as a key: blanks removed, lower case ('910 / 1234/24' -> '910/1234/24'). */
export function caseKey(n: string | null | undefined): string | null {
  const k = (n || '').replace(/\s+/g, '').toLowerCase();
  return k || null;
}

/** Role pair label of an edge, src role first. */
export function rolePair(srcRole: number, dstRole: number): string {
  return `${COURT_ROLES[srcRole] || `role${srcRole}`}-${COURT_ROLES[dstRole] || `role${dstRole}`}`;
}

/** The litigation hub threshold for an observed counterparty degree at the policy percentile. */
export function courtHubThreshold(observed: number | null | undefined, override?: number): { threshold: number; basis: 'override' | 'percentile' | 'floor' } {
  if (override !== undefined) return { threshold: override, basis: 'override' };
  const v = Number(observed || 0);
  return v > COURT_HUB_POLICY.floor ? { threshold: v, basis: 'percentile' } : { threshold: COURT_HUB_POLICY.floor, basis: 'floor' };
}

// ---------------------------------------------------------------- 1. copy from the backend database

export interface LoadOptions {
  /** years to copy; default: every year of edrsr_parties_coverage that changed, plus the last two */
  years?: number[];
  /** copy the years even when unchanged */
  force?: boolean;
  /** count only, nothing written */
  dryRun?: boolean;
  batchSize?: number;   // default 20000
  log?: (m: string) => void;
}

export interface LoadResult { years: Array<{ year: number; rows: number; skipped?: string }>; rows: number; dryRun: boolean }

const PARTY_COLS = ['doc_id', 'adj_year', 'role', 'ord', 'edrpou', 'justice_kind', 'court_code', 'decided_on', 'case_number', 'case_key'] as const;
const PARTY_TYPES = ['bigint', 'smallint', 'smallint', 'smallint', 'text', 'smallint', 'integer', 'date', 'text', 'text'];

/**
 * The source query of one year: coded parties of the year with the case number of the decision.
 * edrsr_documents is partitioned by adjudication_date (Kyiv year bounds): the date range, two days
 * wider than the year, prunes it to the year's partition.
 */
export function sourceYearSql(year: number): string {
  if (!Number.isInteger(year)) throw new Error(`bad year ${year}`);
  return `SELECT p.doc_id, p.adj_year, p.role, p.ord, p.edrpou, p.justice_kind, p.court_code,
                 (p.adjudication_date AT TIME ZONE 'Europe/Kiev')::date AS decided_on, d.cause_num AS case_number
          FROM edrsr_parties p
          LEFT JOIN edrsr_documents d ON d.doc_id = p.doc_id
            AND d.adjudication_date >= make_date(${year}, 1, 1) - 2 AND d.adjudication_date < make_date(${year + 1}, 1, 1) + 2
          WHERE p.adj_year = ${year} AND p.edrpou ~ '^[0-9]{8}$'`;
}

/**
 * Copy the coded parties of the chosen years from the backend database (source, read only) into
 * graph.court_party of the openreyestr database (target).
 */
export async function loadCourtParties(source: Pool, target: Pool, opts: LoadOptions = {}): Promise<LoadResult> {
  const log = opts.log || ((m: string) => console.log(m));
  const batch = opts.batchSize || 20000;
  if (!(await target.query(`SELECT to_regclass('graph.court_party') AS t`)).rows[0].t) {
    throw new Error('graph.court_party missing: run migration 032_graph_court_parties.sql');
  }
  const coverage = new Map<number, string | null>();
  for (const r of (await source.query(`SELECT adj_year, built_at FROM edrsr_parties_coverage ORDER BY adj_year`)).rows) {
    coverage.set(Number(r.adj_year), r.built_at ? new Date(r.built_at).toISOString() : null);
  }
  const loaded = new Map<number, string | null>();
  for (const r of (await target.query(`SELECT adj_year, source_built_at FROM graph.court_party_load`)).rows) {
    loaded.set(Number(r.adj_year), r.source_built_at ? new Date(r.source_built_at).toISOString() : null);
  }
  const all = [...coverage.keys()].sort((a, b) => a - b);
  const years = opts.years && opts.years.length ? [...opts.years].sort((a, b) => a - b) : all;
  for (const y of years) if (!Number.isInteger(y) || y < 1990 || y > 2100) throw new Error(`bad year ${y}`);
  const recent = all.length ? all[all.length - 1] - 1 : Infinity;
  const res: LoadResult = { years: [], rows: 0, dryRun: !!opts.dryRun };

  for (const year of years) {
    const built = coverage.get(year) ?? null;
    const prev = loaded.get(year);
    if (!opts.force && !(opts.years && opts.years.length) && prev !== undefined && year < recent && built !== null && prev === built) {
      res.years.push({ year, rows: 0, skipped: 'unchanged' });
      continue;
    }
    const src = await source.connect();
    const dst = opts.dryRun ? null : await target.connect();
    let rows = 0;
    let maxDate: string | null = null;
    try {
      await src.query('BEGIN READ ONLY');
      await src.query(`SET LOCAL statement_timeout = '30min'`);
      await src.query(`DECLARE court_party_cur NO SCROLL CURSOR FOR ${sourceYearSql(year)}`);
      if (dst) {
        await dst.query('BEGIN');
        await dst.query('DELETE FROM graph.court_party WHERE adj_year = $1', [year]);
      }
      for (;;) {
        const r = await src.query(`FETCH ${batch} FROM court_party_cur`);
        if (!r.rows.length) break;
        rows += r.rows.length;
        for (const x of r.rows) {
          const dd = x.decided_on instanceof Date ? toIsoDate(x.decided_on) : x.decided_on;
          if (dd && (!maxDate || dd > maxDate)) maxDate = dd;
        }
        if (dst) {
          const cols: unknown[][] = PARTY_COLS.map(() => []);
          for (const x of r.rows) {
            const row: Record<string, unknown> = { ...x, case_key: caseKey(x.case_number) };
            if (row.decided_on instanceof Date) row.decided_on = toIsoDate(row.decided_on as Date);
            PARTY_COLS.forEach((c, i) => cols[i].push(row[c] ?? null));
          }
          await dst.query(`INSERT INTO graph.court_party (${PARTY_COLS.join(', ')})
            SELECT * FROM unnest(${PARTY_TYPES.map((t, i) => `$${i + 1}::${t}[]`).join(', ')})
            ON CONFLICT DO NOTHING`, cols);
        }
      }
      await src.query('CLOSE court_party_cur');
      await src.query('COMMIT');
      if (dst) {
        await dst.query(`INSERT INTO graph.court_party_load (adj_year, rows, source_built_at, source_max_date, loaded_at)
          VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (adj_year) DO UPDATE SET rows = EXCLUDED.rows, source_built_at = EXCLUDED.source_built_at,
            source_max_date = EXCLUDED.source_max_date, loaded_at = EXCLUDED.loaded_at`, [year, rows, built, maxDate]);
        await dst.query('COMMIT');
      }
    } catch (e) {
      await src.query('ROLLBACK').catch(() => undefined);
      if (dst) await dst.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      src.release();
      dst?.release();
    }
    log(`  ${year}: ${rows} coded parties${opts.dryRun ? ' (dry run)' : ''}`);
    res.years.push({ year, rows });
    res.rows += rows;
  }
  if (!opts.dryRun) await target.query('ANALYZE graph.court_party');
  return res;
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 2. builder step

export interface CourtEdgeOptions {
  maxPartiesPerDecision?: number;
  /** override of the computed litigation hub threshold (counterparties) */
  hubThreshold?: number;
}

/**
 * Builder step (after graph_stage.node / graph_stage.edge are filled, before their indexes):
 * co_party edges from graph.court_party between companies of graph_stage.company, appended to
 * graph_stage.edge; degree / attrs.degree_by_kind / attrs.court / hub of the companies updated.
 * A database without graph.court_party, or with an empty one, gets no court edges.
 */
export async function buildCourtEdges(c: Pick<PoolClient, 'query'>, opts: CourtEdgeOptions = {}): Promise<Record<string, number | string | null>> {
  const maxParties = opts.maxPartiesPerDecision ?? COURT_MAX_PARTIES_PER_DECISION;
  if (!(Number.isInteger(maxParties) && maxParties >= 2)) throw new Error('maxPartiesPerDecision must be an integer >= 2');
  if (opts.hubThreshold !== undefined && !(Number.isInteger(opts.hubThreshold) && opts.hubThreshold > 0)) throw new Error('court hub threshold must be a positive integer');
  const counts: Record<string, number | string | null> = {};
  if (!(await c.query(`SELECT to_regclass('graph.court_party') AS t`)).rows[0].t) {
    counts.court_source = 'missing';
    return counts;
  }
  const load = (await c.query(`SELECT count(*) AS years, coalesce(sum(rows), 0) AS rows, max(loaded_at)::date::text AS loaded,
      max(source_max_date)::text AS newest FROM graph.court_party_load`)).rows[0];
  counts.court_years = Number(load.years);
  counts.court_loaded_on = load.loaded;
  counts.court_newest_decision = load.newest;

  // one row per (decision, company of the build): a company named twice keeps its first role
  await c.query(`CREATE UNLOGGED TABLE graph_stage.court_doc AS
    SELECT p.doc_id, p.edrpou, min(p.role) AS role, min(p.decided_on) AS decided_on, min(p.case_number) AS case_number,
           min(p.case_key) AS case_key, min(p.justice_kind) AS justice_kind, max(p.loaded_on) AS loaded_on
    FROM graph.court_party p JOIN graph_stage.company co ON co.edrpou = p.edrpou
    GROUP BY p.doc_id, p.edrpou`);
  await c.query('ANALYZE graph_stage.court_doc');
  counts.court_party_rows = Number((await c.query('SELECT count(*) AS n FROM graph_stage.court_doc')).rows[0].n);
  await c.query(`CREATE UNLOGGED TABLE graph_stage.court_ndoc AS
    SELECT doc_id, count(*) AS n FROM graph_stage.court_doc GROUP BY doc_id HAVING count(*) >= 2`);
  await c.query('ANALYZE graph_stage.court_ndoc');
  counts.court_decisions_multi = Number((await c.query('SELECT count(*) AS n FROM graph_stage.court_ndoc')).rows[0].n);
  counts.court_decisions_mass = Number((await c.query('SELECT count(*) AS n FROM graph_stage.court_ndoc WHERE n > $1', [maxParties])).rows[0].n);
  counts.court_max_parties_per_decision = maxParties;

  const pairs = Object.keys(COURT_ROLES).flatMap(a => Object.keys(COURT_ROLES).map(b => [Number(a), Number(b)]));
  const roleCounts = pairs.map(([a, b]) =>
    `'${rolePair(a, b)}', nullif(count(*) FILTER (WHERE x.src_role = ${a} AND x.dst_role = ${b}), 0)`).join(', ');
  await c.query(`CREATE UNLOGGED TABLE graph_stage.court_edge AS
    WITH x AS (
      SELECT a.edrpou AS src, b.edrpou AS dst, a.doc_id, a.role AS src_role, b.role AS dst_role, a.decided_on,
             a.case_number, a.case_key, a.justice_kind, greatest(a.loaded_on, b.loaded_on) AS loaded_on
      FROM graph_stage.court_ndoc n
      JOIN graph_stage.court_doc a ON a.doc_id = n.doc_id
      JOIN graph_stage.court_doc b ON b.doc_id = n.doc_id AND a.edrpou < b.edrpou
      WHERE n.n <= ${maxParties}
    )
    SELECT x.src, x.dst, min(x.decided_on) AS valid_from, max(x.decided_on) AS valid_to,
           jsonb_build_object('edrsr', jsonb_strip_nulls(jsonb_build_object(
             'loaded_on', max(x.loaded_on),
             'decisions', to_jsonb((array_agg(x.doc_id ORDER BY x.decided_on DESC NULLS LAST, x.doc_id DESC))[1:${COURT_REFS}]),
             'cases', to_jsonb((array_agg(DISTINCT x.case_number) FILTER (WHERE x.case_number IS NOT NULL))[1:${COURT_REFS}])))) AS source_ref,
           jsonb_strip_nulls(jsonb_build_object(
             'decisions', count(*), 'cases', count(DISTINCT x.case_key),
             'roles', jsonb_strip_nulls(jsonb_build_object(${roleCounts})),
             'justice_kinds', to_jsonb(array_agg(DISTINCT x.justice_kind) FILTER (WHERE x.justice_kind IS NOT NULL)))) AS attrs
    FROM x GROUP BY x.src, x.dst`);
  await c.query('ANALYZE graph_stage.court_edge');
  const n = Number((await c.query('SELECT count(*) AS n FROM graph_stage.court_edge')).rows[0].n);
  counts.edges_co_party = n;

  // counterparties per company and the litigation hub threshold
  await c.query(`CREATE UNLOGGED TABLE graph_stage.court_deg AS
    SELECT edrpou, count(*)::int AS counterparties, sum(decisions)::int AS decisions FROM (
      SELECT src AS edrpou, (attrs->>'decisions')::int AS decisions FROM graph_stage.court_edge
      UNION ALL SELECT dst, (attrs->>'decisions')::int FROM graph_stage.court_edge) z
    GROUP BY edrpou`);
  await c.query('ANALYZE graph_stage.court_deg');
  const obs = (await c.query(`SELECT percentile_disc($1::float8) WITHIN GROUP (ORDER BY counterparties) AS v FROM graph_stage.court_deg`,
    [COURT_HUB_POLICY.percentile])).rows[0].v;
  const hub = courtHubThreshold(obs === null ? null : Number(obs), opts.hubThreshold);
  counts.court_hub_threshold = hub.threshold;
  counts.court_hub_basis = hub.basis;

  // graph_stage.node is not analysed yet at this point of the build; planned without statistics, this
  // INSERT wrote ~300 GB of temp files and filled the disk on prod (20.11). With them it takes < 1 s.
  await c.query('ANALYZE graph_stage.node');
  await c.query(`INSERT INTO graph_stage.edge (src, dst, kind, valid_from, valid_to, source, source_ref, attrs)
    SELECT s.id, d.id, 'co_party', e.valid_from, e.valid_to, 'edrsr', e.source_ref, e.attrs
    FROM graph_stage.court_edge e
    JOIN graph_stage.node s ON s.kind = 'company' AND s.key = e.src
    JOIN graph_stage.node d ON d.kind = 'company' AND d.key = e.dst
    ORDER BY e.src, e.dst`);
  await c.query(`UPDATE graph_stage.node n
    SET degree = n.degree + g.counterparties,
        hub = n.hub OR g.counterparties > ${hub.threshold},
        attrs = jsonb_set(n.attrs, '{degree_by_kind}', coalesce(n.attrs->'degree_by_kind', '{}'::jsonb) || jsonb_build_object('co_party', g.counterparties))
                || jsonb_build_object('court', jsonb_strip_nulls(jsonb_build_object('counterparties', g.counterparties, 'decisions', g.decisions,
                     'hub', CASE WHEN g.counterparties > ${hub.threshold} THEN true END)))
    FROM graph_stage.court_deg g
    WHERE n.kind = 'company' AND n.key = g.edrpou`);
  counts.court_companies = Number((await c.query('SELECT count(*) AS n FROM graph_stage.court_deg')).rows[0].n);
  counts.hubs_court = Number((await c.query(`SELECT count(*) AS n FROM graph_stage.court_deg WHERE counterparties > ${hub.threshold}`)).rows[0].n);
  await c.query('DROP TABLE graph_stage.court_doc, graph_stage.court_ndoc, graph_stage.court_edge, graph_stage.court_deg');
  return counts;
}
