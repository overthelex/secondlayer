/**
 * Enrichment layer of the relationship graph (LEXAI-2305, migration 035): flags on graph nodes and
 * extra dated edges from registers other than the ЄДР. Built after the ЄДР graph
 * (scripts/build-graph-enrichment.ts), staged in schema graph_enrich_stage and swapped in with one
 * transaction, like builder.ts; it never touches graph.node / graph.edge.
 *
 * Rows are keyed by the node (kind, key) of graph.node, not by node ids, and only rows whose
 * endpoints are nodes of the current graph are kept (a register entry outside the graph is not
 * copied: data minimisation). Persons are matched by the name key (keys.ts personKey), so a person
 * flag / edge is a candidate, like the person_name node itself (match = 'name').
 *
 * Sources (each optional: a missing table, or the external database not given, keeps the rows of
 * the previous build for that source):
 *   openreyestr database
 *     rnbo_sanctions           flag sanctions: company by the ЄДРПОУ in the identifiers, other
 *                              organisations as foreign_entity by country + name, persons by name
 *     tax_debt / esv_debt      flags tax_debt / esv_debt (8-digit codes only)
 *     debtors                  flag debtor_register (Єдиний реєстр боржників, legal entities)
 *     enforcement_proceedings  flag enforcement (debtor) + edges creditor (стягувач -> боржник, both companies)
 *     termination_started      flag termination
 *     prozorro_contracts       edges supplier (постачальник -> замовник) with contract count and amount
 *     nazk                     НАЗК declarations: edges declared_owner (corporate rights / КБВ of the
 *                              declarant or spouse / parent), family (declarant -> spouse, parents,
 *                              parents-in-law; children and siblings are never taken: they may be
 *                              minors), flag pep_declarant (position and workplace of the latest declaration)
 *   secondlayer database (optional --external connection)
 *     nbu_fin_licenses             flag fin_licence
 *     opendata_securities_owners   edges shareholder (власник >= 5 % -> емітент, НКЦПФР)
 *     opendata_nazk_war_sanctions  flag war_sanctions (War & Sanctions: companies by ЄДРПОУ, persons by name)
 *
 * No tax / document numbers are stored: 10-digit tax numbers (РНОКПП) are never used as keys, and
 * the build FAILS before the swap if a 10-digit run is left in a key or an attribute
 * (checkEnrichmentIds; amounts are exempt).
 */
import { Pool, PoolClient } from 'pg';
import { stripPersonIds, TEN_DIGITS_SQL } from '../graph-norm/personal-ids';
import { foreignEntityKey, personKey } from './keys';
import type { Queryable } from './neighbourhood';
import { useTempTablespace } from './temp-tablespace';

export type EnrichFlag = 'sanctions' | 'war_sanctions' | 'tax_debt' | 'esv_debt' | 'debtor_register'
  | 'enforcement' | 'termination' | 'fin_licence' | 'pep_declarant';
export type EnrichEdgeKind = 'creditor' | 'supplier' | 'declared_owner' | 'family' | 'shareholder';

export const ENRICH_FLAGS: EnrichFlag[] = ['sanctions', 'war_sanctions', 'tax_debt', 'esv_debt', 'debtor_register',
  'enforcement', 'termination', 'fin_licence', 'pep_declarant'];
export const ENRICH_EDGE_KINDS: EnrichEdgeKind[] = ['creditor', 'supplier', 'declared_owner', 'family', 'shareholder'];

export const FLAG_LABELS: Record<EnrichFlag, string> = {
  sanctions: 'санкції РНБО',
  war_sanctions: 'War & Sanctions (НАЗК)',
  tax_debt: 'податковий борг',
  esv_debt: 'борг зі сплати ЄСВ',
  debtor_register: 'Єдиний реєстр боржників',
  enforcement: 'боржник у виконавчих провадженнях',
  termination: 'розпочато припинення',
  fin_licence: 'ліцензія НБУ на фінансові послуги',
  pep_declarant: 'декларант НАЗК (публічна особа)',
};
export const ENRICH_EDGE_LABELS: Record<EnrichEdgeKind, string> = {
  creditor: 'стягувач',
  supplier: 'постачальник',
  declared_owner: 'власник (декларація НАЗК)',
  family: 'член сім\'ї (декларація НАЗК)',
  shareholder: 'акціонер ≥5%',
};

/** НАЗК family relations taken: spouses and parents (adults); children, siblings, cohabitants are not (they may be minors). */
export const NAZK_FAMILY_RELATIONS = ['дружина', 'чоловік', 'мати', 'батько', 'теща', 'тесть', 'свекор', 'свекруха'];
/** Proceedings that are not finished (АСВП statuses). */
export const ENFORCEMENT_OPEN_STATUSES = ['Відкрито', 'Примусове виконання', 'Зупинено'];
/** War & Sanctions categories that list companies / persons. */
export const WAR_SANCTIONS_COMPANY_CATEGORIES = ['sanctions_companies', 'components_companies', 'uav_companies', 'rostec'];
export const WAR_SANCTIONS_PERSON_CATEGORIES = ['sanctions_persons', 'kidnappers_persons', 'propaganda_persons', 'sport_persons',
  'scientists_persons', 'stolen_persons', 'executives'];
/** НКЦПФР: the share from which an owner is a shareholder edge. */
export const SHAREHOLDER_MIN_PERCENT = 5;
/** Attribute keys holding amounts: exempt from the 10-digit check. */
export const AMOUNT_ATTRS = ['amount_uah', 'debt_total', 'debt_amount'];

export const STAGE = 'graph_enrich_stage';

/** DDL of graph.node_flag / graph.enrich_edge (identical to migration 035) in a schema, without indexes. */
export function enrichDdl(schema: string): string[] {
  return [
    `CREATE TABLE ${schema}.node_flag (
    kind        text NOT NULL,
    key         text NOT NULL,
    flag        text NOT NULL CHECK (flag IN (${ENRICH_FLAGS.map(f => `'${f}'`).join(', ')})),
    source      text NOT NULL,
    match       text NOT NULL CHECK (match IN ('code', 'name')),
    as_of       date,
    attrs       jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_ref  jsonb NOT NULL DEFAULT '{}'::jsonb)`,
    `CREATE TABLE ${schema}.enrich_edge (
    id          bigserial,
    src_kind    text NOT NULL,
    src_key     text NOT NULL,
    dst_kind    text NOT NULL,
    dst_key     text NOT NULL,
    kind        text NOT NULL CHECK (kind IN (${ENRICH_EDGE_KINDS.map(f => `'${f}'`).join(', ')})),
    valid_from  date,
    valid_to    date,
    source      text NOT NULL,
    source_ref  jsonb NOT NULL DEFAULT '{}'::jsonb,
    attrs       jsonb NOT NULL DEFAULT '{}'::jsonb)`,
  ];
}

/** Constraints and indexes, added after the bulk load (names as in migration 035). */
export function enrichIndexDdl(schema: string): string[] {
  return [
    `ALTER TABLE ${schema}.node_flag ADD CONSTRAINT node_flag_pkey PRIMARY KEY (kind, key, flag, source)`,
    `ALTER TABLE ${schema}.enrich_edge ADD CONSTRAINT enrich_edge_pkey PRIMARY KEY (id)`,
    `CREATE INDEX enrich_edge_src ON ${schema}.enrich_edge (src_kind, src_key)`,
    `CREATE INDEX enrich_edge_dst ON ${schema}.enrich_edge (dst_kind, dst_key)`,
  ];
}

// ---------------------------------------------------------------- pure helpers

export interface FlagEndpoint { kind: 'company' | 'person_name' | 'foreign_entity'; key: string; match: 'code' | 'name' }

const UA_CODE_RE = /(?:^|[^0-9])([0-9]{8}) (?:Відомості згідно з Єдиним державним реєстром юридичних осіб|Податковий номер Україна)/g;

/** 8-digit ЄДРПОУ codes in an РНБО identifiers text ('12345678 Відомості згідно з Єдиним державним реєстром юридичних осіб ...'). */
export function uaCodesFromIdentifiers(identifiers: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of (identifiers || '').matchAll(UA_CODE_RE)) if (!/^0+$/.test(m[1])) out.add(m[1]);
  return [...out];
}

/** ISO alpha-2 codes of a countries text ('Російська Федерація RU; Україна UA'). */
export function countriesOf(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const part of (text || '').split(';')) {
    const m = part.trim().match(/(?:^|\s)([A-Z]{2})$/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * Graph endpoints of an РНБО sanctions record: an organisation with a Ukrainian code -> company
 * (by code); otherwise, for each non-Ukrainian country, a foreign_entity by name; a person -> person_name by name.
 * Vessels and the rest: none.
 */
export function sanctionEndpoints(r: { schema_type: string | null; name: string | null; identifiers?: string | null; countries?: string | null }): FlagEndpoint[] {
  if (r.schema_type === 'Person') {
    const k = personKey(r.name);
    return k ? [{ kind: 'person_name', key: k, match: 'name' }] : [];
  }
  if (r.schema_type !== 'Organization') return [];
  const codes = uaCodesFromIdentifiers(r.identifiers);
  if (codes.length) return codes.map(code => ({ kind: 'company' as const, key: code, match: 'code' as const }));
  const out: FlagEndpoint[] = [];
  for (const cc of countriesOf(r.countries)) {
    const k = foreignEntityKey(cc, stripPersonIds(r.name));
    if (k && !k.includes('|code:')) out.push({ kind: 'foreign_entity', key: k, match: 'name' });
  }
  return out;
}

/** An НАЗК family relation that is taken (lower case), or null. */
export function nazkRelation(raw: string | null | undefined): string | null {
  const r = (raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return NAZK_FAMILY_RELATIONS.includes(r) ? r : null;
}

// ---------------------------------------------------------------- build

export interface EnrichmentOptions {
  /** the secondlayer database (НБУ, НКЦПФР, War & Sanctions); without it those sources keep their previous rows */
  external?: Queryable | null;
  /** run only these steps (STEP names); the others keep their previous rows */
  only?: string[];
  /** skip these steps (they keep their previous rows) */
  skip?: string[];
  /** schema of the graph (node table read, enrichment tables swapped in); default 'graph' */
  schema?: string;
  /** reference date for "still current" (contracts in force); default today */
  today?: string;
  statementTimeout?: string;   // default '3h'
  workMem?: string;            // default '256MB'
  batchSize?: number;          // JS batches, default 20000
  keepStage?: boolean;
  log?: (m: string) => void;
}

export type SourceState = 'built' | 'missing' | 'excluded' | 'no_external';
export interface EnrichmentResult {
  sources: Record<string, SourceState>;
  counts: Record<string, number | string | null>;
  seconds: Record<string, number>;
}

interface Ctx {
  c: PoolClient;
  ext: Queryable | null;
  batch: number;
  today: string;
  counts: Record<string, number | string | null>;
  log: (m: string) => void;
}

interface Step {
  name: string;
  /** values of the source column the step writes (rows of the previous build kept when it does not run) */
  sources: string[];
  db: 'local' | 'external';
  /** tables that must exist (in db) */
  tables: string[];
  run: (x: Ctx) => Promise<void>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const arr = (xs: string[]) => `ARRAY[${xs.map(lit).join(', ')}]::text[]`;
const S = STAGE;

/** Insert rows (arrays in column order) through unnest. */
async function insertRows(c: Queryable, table: string, cols: string[], types: string[], rows: unknown[][], batch = 20000): Promise<void> {
  for (let i = 0; i < rows.length; i += batch) {
    const b = rows.slice(i, i + batch);
    await c.query(`INSERT INTO ${table} (${cols.join(', ')}) SELECT * FROM unnest(${types.map((t, j) => `$${j + 1}::${t}[]`).join(', ')})`,
      types.map((_, j) => b.map(r => (r[j] === undefined ? null : r[j]))));
  }
}

const FLAG_COLS = ['kind', 'key', 'flag', 'source', 'match', 'as_of', 'attrs', 'ref', 'n'];
const FLAG_TYPES = ['text', 'text', 'text', 'text', 'text', 'date', 'jsonb', 'text', 'int'];
const EDGE_COLS = ['src_kind', 'src_key', 'dst_kind', 'dst_key', 'kind', 'valid_from', 'valid_to', 'source', 'source_ref', 'attrs'];
const EDGE_TYPES = ['text', 'text', 'text', 'text', 'text', 'date', 'date', 'text', 'jsonb', 'jsonb'];

/** Person keys of the distinct names a query returns (column v), added to graph_enrich_stage.name_key. */
async function keyNames(x: Ctx, selectSql: string, params: unknown[] = []): Promise<number> {
  const rows: unknown[][] = [];
  for (const r of (await x.c.query(`SELECT DISTINCT v FROM (${selectSql}) q WHERE v IS NOT NULL AND v <> ''
      AND NOT EXISTS (SELECT 1 FROM ${S}.name_key k WHERE k.raw = q.v)`, params)).rows) {
    rows.push([String(r.v), personKey(String(r.v))]);
  }
  await insertRows(x.c, `${S}.name_key`, ['raw', 'key'], ['text', 'text'], rows, x.batch);
  await x.c.query(`ANALYZE ${S}.name_key`);
  return rows.length;
}

const n = async (c: Queryable, sql: string, p: unknown[] = []) => Number((await c.query(sql, p)).rows[0].n);

export const STEPS: Step[] = [
  {
    name: 'rnbo_sanctions', sources: ['rnbo_sanctions'], db: 'local', tables: ['rnbo_sanctions'],
    async run(x) {
      const rows: unknown[][] = [];
      const r = await x.c.query(`SELECT entity_id, schema_type, name, identifiers, countries, sanctions,
          coalesce(last_seen, updated_at)::date::text AS as_of FROM rnbo_sanctions WHERE schema_type IN ('Person', 'Organization')`);
      for (const s of r.rows) {
        for (const ep of sanctionEndpoints(s)) {
          rows.push([ep.kind, ep.key, 'sanctions', 'rnbo_sanctions', ep.match, s.as_of,
            JSON.stringify({ status: s.sanctions || null, list: 'Державний реєстр санкцій (РНБО)' }), s.entity_id, 1]);
        }
      }
      await insertRows(x.c, `${S}.flag_raw`, FLAG_COLS, FLAG_TYPES, rows, x.batch);
      x.counts.rnbo_records = r.rows.length;
      x.counts.rnbo_endpoints = rows.length;
    },
  },
  {
    name: 'tax_debt', sources: ['tax_debt'], db: 'local', tables: ['tax_debt'],
    async run(x) {
      await x.c.query(`INSERT INTO ${S}.flag_raw (${FLAG_COLS.join(', ')})
        SELECT 'company', tin, 'tax_debt', 'tax_debt', 'code', max(report_date),
               jsonb_build_object('debt_total', round(sum(debt_total), 2), 'report_date', max(report_date)), NULL, count(*)
        FROM tax_debt WHERE tin ~ '^[0-9]{8}$' GROUP BY tin`);
    },
  },
  {
    name: 'esv_debt', sources: ['esv_debt'], db: 'local', tables: ['esv_debt'],
    async run(x) {
      await x.c.query(`INSERT INTO ${S}.flag_raw (${FLAG_COLS.join(', ')})
        SELECT 'company', tin, 'esv_debt', 'esv_debt', 'code', max(coalesce(updated_at, created_at))::date,
               jsonb_build_object('debt_amount', round(sum(debt_amount), 2)), NULL, count(*)
        FROM esv_debt WHERE tin ~ '^[0-9]{8}$' GROUP BY tin`);
    },
  },
  {
    name: 'debtors', sources: ['debtors'], db: 'local', tables: ['debtors'],
    async run(x) {
      await x.c.query(`INSERT INTO ${S}.flag_raw (${FLAG_COLS.join(', ')})
        SELECT 'company', debtor_edrpou, 'debtor_register', 'debtors', 'code', max(coalesce(updated_at, created_at))::date,
               jsonb_build_object('proceedings', count(*),
                 'categories', to_jsonb((array_agg(DISTINCT collection_category) FILTER (WHERE collection_category IS NOT NULL))[1:3])),
               (array_agg(proceeding_number ORDER BY id DESC))[1], count(*)
        FROM debtors WHERE debtor_edrpou ~ '^[0-9]{8}$' AND debtor_edrpou !~ '^0+$' GROUP BY debtor_edrpou`);
    },
  },
  {
    name: 'enforcement_proceedings', sources: ['enforcement_proceedings'], db: 'local', tables: ['enforcement_proceedings'],
    async run(x) {
      await x.c.query(`CREATE UNLOGGED TABLE ${S}.ep AS
        SELECT proceeding_number, opening_date, proceeding_status = ANY(${arr(ENFORCEMENT_OPEN_STATUSES)}) AS open,
               debtor_edrpou, CASE WHEN creditor_edrpou ~ '^[0-9]{8}$' AND creditor_edrpou !~ '^0+$' THEN creditor_edrpou END AS creditor_edrpou,
               coalesce(updated_at, created_at)::date AS seen
        FROM enforcement_proceedings WHERE debtor_edrpou ~ '^[0-9]{8}$' AND debtor_edrpou !~ '^0+$'`);
      x.counts.enforcement_company_debtor_rows = await n(x.c, `SELECT count(*) AS n FROM ${S}.ep`);
      await x.c.query(`INSERT INTO ${S}.flag_raw (${FLAG_COLS.join(', ')})
        SELECT 'company', debtor_edrpou, 'enforcement', 'enforcement_proceedings', 'code', max(seen),
               jsonb_build_object('proceedings', count(*), 'open', count(*) FILTER (WHERE open), 'last_opened', max(opening_date)),
               (array_agg(proceeding_number ORDER BY opening_date DESC NULLS LAST))[1], count(*)
        FROM ${S}.ep GROUP BY debtor_edrpou`);
      await x.c.query(`INSERT INTO ${S}.edge_raw (${EDGE_COLS.join(', ')})
        SELECT 'company', creditor_edrpou, 'company', debtor_edrpou, 'creditor',
               min(opening_date), CASE WHEN bool_or(open) THEN NULL ELSE max(opening_date) END, 'enforcement_proceedings',
               jsonb_build_object('proceedings', to_jsonb((array_agg(proceeding_number ORDER BY opening_date DESC NULLS LAST))[1:5]), 'as_of', max(seen)),
               jsonb_build_object('proceedings', count(*), 'open', count(*) FILTER (WHERE open))
        FROM ${S}.ep WHERE creditor_edrpou IS NOT NULL AND creditor_edrpou <> debtor_edrpou
        GROUP BY creditor_edrpou, debtor_edrpou`);
      await x.c.query(`DROP TABLE ${S}.ep`);
    },
  },
  {
    name: 'termination_started', sources: ['termination_started'], db: 'local', tables: ['termination_started', 'legal_entities'],
    async run(x) {
      await x.c.query(`INSERT INTO ${S}.flag_raw (${FLAG_COLS.join(', ')})
        SELECT DISTINCT ON (le.edrpou) 'company', le.edrpou, 'termination', 'termination_started', 'code', ${S}.ua_date(t.op_date),
               jsonb_strip_nulls(jsonb_build_object('reason', ${S}.no_ids(t.reason), 'state', ${S}.no_ids(t.sbj_state),
                 'creditor_claims_until', ${S}.ua_date(t.creditor_req_end_date))),
               t.id::text, 1
        FROM termination_started t JOIN legal_entities le ON le.record = t.entity_record
        WHERE t.entity_type = 'UO' AND le.edrpou ~ '^[0-9]{8}$'
        ORDER BY le.edrpou, ${S}.ua_date(t.op_date) DESC NULLS LAST, t.id DESC`);
    },
  },
  {
    name: 'prozorro_contracts', sources: ['prozorro_contracts'], db: 'local', tables: ['prozorro_contracts', 'prozorro_tenders'],
    async run(x) {
      await x.c.query(`INSERT INTO ${S}.edge_raw (${EDGE_COLS.join(', ')})
        SELECT 'company', c.supplier_edrpou, 'company', t.buyer_edrpou, 'supplier',
               min(coalesce(c.date_signed, c.contract_date))::date,
               CASE WHEN max(coalesce(c.period_end, coalesce(c.date_signed, c.contract_date)::date)) >= ${lit(x.today)}::date THEN NULL
                    ELSE max(coalesce(c.period_end, coalesce(c.date_signed, c.contract_date)::date)) END,
               'prozorro_contracts',
               jsonb_build_object('tenders', to_jsonb((array_agg(c.tender_id ORDER BY c.date_signed DESC NULLS LAST))[1:5]),
                 'as_of', max(c.tender_date_modified)::date),
               jsonb_strip_nulls(jsonb_build_object('contracts', count(*), 'tenders', count(DISTINCT c.tender_id),
                 'amount_uah', round(sum(c.amount) FILTER (WHERE c.currency = 'UAH')),
                 'last_signed', max(coalesce(c.date_signed, c.contract_date))::date))
        FROM prozorro_contracts c JOIN prozorro_tenders t ON t.tender_id = c.tender_id
        WHERE c.supplier_edrpou ~ '^[0-9]{8}$' AND t.buyer_edrpou ~ '^[0-9]{8}$' AND c.supplier_edrpou <> t.buyer_edrpou
          AND c.supplier_edrpou !~ '^0+$' AND coalesce(c.status, '') <> 'cancelled'
        GROUP BY c.supplier_edrpou, t.buyer_edrpou`);
    },
  },
  {
    name: 'nazk', sources: ['nazk_corporate_rights', 'nazk_family_members', 'nazk_declarations'], db: 'local',
    tables: ['nazk_declarations', 'nazk_corporate_rights', 'nazk_family_members'],
    async run(x) {
      const rel = arr(NAZK_FAMILY_RELATIONS);
      x.counts.nazk_names_keyed = await keyNames(x, `
        SELECT declarant_name AS v FROM nazk_declarations
        UNION SELECT owner_name FROM nazk_corporate_rights WHERE owner_type = 'declarant' OR lower(btrim(owner_relation)) = ANY(${rel})
        UNION SELECT full_name FROM nazk_family_members WHERE lower(btrim(relation)) = ANY(${rel})`);
      // the latest declaration year of each declarant: a relation still declared then is current
      await x.c.query(`CREATE UNLOGGED TABLE ${S}.decl_last AS
        SELECT declarant_id, max(declaration_year) AS y FROM nazk_declarations
        WHERE declarant_id IS NOT NULL GROUP BY declarant_id`); // some list rows have no declarant id (20.11)
      await x.c.query(`ALTER TABLE ${S}.decl_last ADD PRIMARY KEY (declarant_id)`);
      await x.c.query(`INSERT INTO ${S}.edge_raw (${EDGE_COLS.join(', ')})
        WITH r AS (
          SELECT nk.key, cr.edrpou::text AS edrpou, cr.declaration_id, cr.declaration_year, cr.right_kind,
                 CASE WHEN cr.share_percent BETWEEN 0 AND 100 THEN round(cr.share_percent, 4) END AS share_percent, cr.acquired_date, -- a share > 100 is junk; '99.9999999999' would read as a 10-digit run
                 CASE WHEN cr.owner_type = 'declarant' THEN 'declarant' ELSE lower(btrim(cr.owner_relation)) END AS owner, dl.y AS last_year
          FROM nazk_corporate_rights cr
          JOIN ${S}.name_key nk ON nk.raw = cr.owner_name AND nk.key IS NOT NULL
          LEFT JOIN ${S}.decl_last dl ON dl.declarant_id = cr.declarant_id
          WHERE cr.edrpou ~ '^[0-9]{8}$' AND cr.edrpou !~ '^0+$'
            AND (cr.owner_type = 'declarant' OR (cr.owner_type = 'family' AND lower(btrim(cr.owner_relation)) = ANY(${rel})))
        )
        SELECT 'person_name', key, 'company', edrpou, 'declared_owner',
               coalesce(min(acquired_date), make_date(min(declaration_year), 1, 1)),
               CASE WHEN max(declaration_year) >= max(last_year) THEN NULL ELSE make_date(max(declaration_year), 12, 31) END,
               'nazk_corporate_rights',
               jsonb_build_object('declarations', to_jsonb((array_agg(DISTINCT declaration_id))[1:5]), 'as_of', make_date(max(declaration_year), 12, 31)),
               jsonb_strip_nulls(jsonb_build_object('rights', to_jsonb(array_agg(DISTINCT right_kind)),
                 'share_percent', (array_agg(share_percent ORDER BY declaration_year DESC) FILTER (WHERE share_percent IS NOT NULL))[1],
                 'owner', (array_agg(owner ORDER BY declaration_year DESC))[1],
                 'years', jsonb_build_array(min(declaration_year), max(declaration_year))))
        FROM r GROUP BY key, edrpou`);
      await x.c.query(`INSERT INTO ${S}.edge_raw (${EDGE_COLS.join(', ')})
        WITH r AS (
          SELECT dk.key AS dkey, mk.key AS mkey, lower(btrim(fm.relation)) AS relation, fm.declaration_id, fm.declaration_year, dl.y AS last_year
          FROM nazk_family_members fm
          JOIN nazk_declarations d ON d.declaration_id = fm.declaration_id
          JOIN ${S}.name_key dk ON dk.raw = d.declarant_name AND dk.key IS NOT NULL
          JOIN ${S}.name_key mk ON mk.raw = fm.full_name AND mk.key IS NOT NULL
          LEFT JOIN ${S}.decl_last dl ON dl.declarant_id = d.declarant_id
          WHERE lower(btrim(fm.relation)) = ANY(${rel})
        )
        SELECT 'person_name', dkey, 'person_name', mkey, 'family',
               make_date(min(declaration_year), 1, 1),
               CASE WHEN max(declaration_year) >= max(last_year) THEN NULL ELSE make_date(max(declaration_year), 12, 31) END,
               'nazk_family_members',
               jsonb_build_object('declarations', to_jsonb((array_agg(DISTINCT declaration_id))[1:5]), 'as_of', make_date(max(declaration_year), 12, 31)),
               jsonb_build_object('relation', (array_agg(relation ORDER BY declaration_year DESC))[1],
                 'years', jsonb_build_array(min(declaration_year), max(declaration_year)))
        FROM r WHERE dkey <> mkey GROUP BY dkey, mkey`);
      await x.c.query(`INSERT INTO ${S}.flag_raw (${FLAG_COLS.join(', ')})
        SELECT 'person_name', nk.key, 'pep_declarant', 'nazk_declarations', 'name', make_date(max(d.declaration_year), 12, 31),
               jsonb_strip_nulls(jsonb_build_object(
                 'position', ${S}.no_ids((array_agg(d.declarant_position ORDER BY d.declaration_year DESC, d.submission_date DESC NULLS LAST))[1]),
                 'workplace', ${S}.no_ids((array_agg(d.declarant_workplace ORDER BY d.declaration_year DESC, d.submission_date DESC NULLS LAST))[1]),
                 'last_year', max(d.declaration_year), 'declarations', count(*))),
               (array_agg(d.declaration_id ORDER BY d.declaration_year DESC))[1], count(*)
        FROM nazk_declarations d JOIN ${S}.name_key nk ON nk.raw = d.declarant_name AND nk.key IS NOT NULL
        GROUP BY nk.key`);
      await x.c.query(`DROP TABLE ${S}.decl_last`);
      x.counts.nazk_declarations = await n(x.c, `SELECT count(*) AS n FROM nazk_declarations`);
      if (await n(x.c, `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'nazk_declarations' AND column_name = 'relations_extracted_at'`)) {
        // the relations (family, corporate rights) are loaded per declaration: a partial load gives partial edges
        x.counts.nazk_declarations_extracted = await n(x.c, `SELECT count(*) AS n FROM nazk_declarations WHERE relations_extracted_at IS NOT NULL`);
      }
    },
  },
  {
    name: 'nbu_fin_licenses', sources: ['nbu_fin_licenses'], db: 'external', tables: ['nbu_fin_licenses'],
    async run(x) {
      const r = await x.ext!.query(`SELECT edrpou, max(snapshot_date)::text AS as_of, count(*) AS n,
          to_jsonb((array_agg(DISTINCT institution_type) FILTER (WHERE institution_type IS NOT NULL))[1:5]) AS types,
          to_jsonb((array_agg(DISTINCT license_status) FILTER (WHERE license_status IS NOT NULL))[1:5]) AS statuses
        FROM nbu_fin_licenses WHERE edrpou ~ '^[0-9]{8}$' GROUP BY edrpou`);
      await insertRows(x.c, `${S}.flag_raw`, FLAG_COLS, FLAG_TYPES, r.rows.map(row => ['company', row.edrpou, 'fin_licence', 'nbu_fin_licenses', 'code',
        row.as_of, JSON.stringify({ institution_types: row.types, licence_statuses: row.statuses, licences: Number(row.n) }), null, Number(row.n)]), x.batch);
    },
  },
  {
    name: 'opendata_securities_owners', sources: ['opendata_securities_owners'], db: 'external', tables: ['opendata_securities_owners'],
    async run(x) {
      const newest = (await x.ext!.query(`SELECT max(report_date)::text AS d FROM opendata_securities_owners`)).rows[0].d as string | null;
      x.counts.securities_newest_report = newest;
      let total = 0;
      // by the first digit of the issuer code: bounded result sets
      for (let digit = 0; digit <= 9; digit++) {
        const r = await x.ext!.query(`
          WITH s AS (
            SELECT issuer_edrpou, report_date, share_percent,
                   CASE WHEN owner_edrpou ~ '^[0-9]{8}$' AND owner_edrpou !~ '^0+$' THEN 'company' WHEN owner_type = 'individual' THEN 'person_name' END AS ok,
                   CASE WHEN owner_edrpou ~ '^[0-9]{8}$' AND owner_edrpou !~ '^0+$' THEN owner_edrpou ELSE owner_name END AS owner
            FROM opendata_securities_owners
            WHERE share_percent >= ${SHAREHOLDER_MIN_PERCENT} AND share_percent <= 100 AND issuer_edrpou ~ '^[0-9]{8}$' AND left(issuer_edrpou, 1) = $1
          )
          SELECT issuer_edrpou, ok, owner, min(report_date)::text AS first, max(report_date)::text AS last,
                 round((array_agg(share_percent ORDER BY report_date DESC))[1], 4) AS share, count(DISTINCT report_date) AS reports
          FROM s WHERE ok IS NOT NULL AND owner IS NOT NULL AND owner <> '' GROUP BY 1, 2, 3`, [String(digit)]);
        const rows: unknown[][] = [];
        for (const row of r.rows) {
          const key = row.ok === 'company' ? row.owner : personKey(row.owner);
          if (!key || (row.ok === 'company' && key === row.issuer_edrpou)) continue;
          rows.push([row.ok, key, 'company', row.issuer_edrpou, 'shareholder', row.first, row.last === newest ? null : row.last,
            'opendata_securities_owners', JSON.stringify({ reports: [row.first, row.last], as_of: row.last }),
            JSON.stringify({ share_percent: row.share === null ? null : Number(row.share), reports: Number(row.reports) })]);
        }
        await insertRows(x.c, `${S}.edge_raw`, EDGE_COLS, EDGE_TYPES, rows, x.batch);
        total += rows.length;
      }
      // a person may be listed under several spellings: one edge per (owner key, issuer)
      await x.c.query(`CREATE UNLOGGED TABLE ${S}.sh AS
        SELECT DISTINCT ON (src_kind, src_key, dst_key) * FROM ${S}.edge_raw WHERE kind = 'shareholder'
        ORDER BY src_kind, src_key, dst_key, valid_to DESC NULLS FIRST, (attrs->>'share_percent')::numeric DESC NULLS LAST`);
      await x.c.query(`DELETE FROM ${S}.edge_raw WHERE kind = 'shareholder'`);
      await x.c.query(`INSERT INTO ${S}.edge_raw SELECT * FROM ${S}.sh`);
      await x.c.query(`DROP TABLE ${S}.sh`);
      x.counts.securities_owner_rows = total;
    },
  },
  {
    name: 'nazk_war_sanctions', sources: ['nazk_war_sanctions'], db: 'external', tables: ['opendata_nazk_war_sanctions'],
    async run(x) {
      const r = await x.ext!.query(`SELECT id::text AS id, category, tin, name_uk, imported_at::date::text AS as_of FROM opendata_nazk_war_sanctions
        WHERE category = ANY($1::text[]) OR category = ANY($2::text[])`, [WAR_SANCTIONS_COMPANY_CATEGORIES, WAR_SANCTIONS_PERSON_CATEGORIES]);
      const rows: unknown[][] = [];
      for (const s of r.rows) {
        let ep: FlagEndpoint | null = null;
        if (WAR_SANCTIONS_COMPANY_CATEGORIES.includes(s.category)) {
          if (/^[0-9]{8}$/.test(s.tin || '') && !/^0+$/.test(s.tin)) ep = { kind: 'company', key: s.tin, match: 'code' };
        } else {
          const k = personKey(s.name_uk);
          if (k) ep = { kind: 'person_name', key: k, match: 'name' };
        }
        if (ep) rows.push([ep.kind, ep.key, 'war_sanctions', 'nazk_war_sanctions', ep.match, s.as_of, JSON.stringify({ category: s.category }), s.id, 1]);
      }
      await insertRows(x.c, `${S}.flag_raw`, FLAG_COLS, FLAG_TYPES, rows, x.batch);
      x.counts.war_sanctions_endpoints = rows.length;
    },
  },
];

const STAGE_FUNCS = [
  `CREATE FUNCTION ${S}.ua_date(t text) RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
   BEGIN RETURN to_date(substring(t FROM '\\d{2}\\.\\d{2}\\.\\d{4}'), 'DD.MM.YYYY'); EXCEPTION WHEN others THEN RETURN NULL; END $$`,
  // free text without long digit runs (tax numbers): the 10-digit check must pass
  `CREATE FUNCTION ${S}.no_ids(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
   SELECT nullif(btrim(regexp_replace(t, '[0-9]{10,}', '', 'g')), '') $$`,
];

async function tableExists(db: Queryable, t: string): Promise<boolean> {
  return !!(await db.query(`SELECT to_regclass($1) AS t`, [t])).rows[0].t;
}

export async function buildEnrichment(pool: Pool, opts: EnrichmentOptions = {}): Promise<EnrichmentResult> {
  const log = opts.log || ((m: string) => console.log(m));
  const schema = opts.schema || 'graph';
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('bad schema name');
  const today = opts.today || new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(today)) throw new Error(`today must be YYYY-MM-DD, got ${today}`);
  for (const s of [...(opts.only || []), ...(opts.skip || [])]) {
    if (!STEPS.some(st => st.name === s)) throw new Error(`unknown enrichment step ${s} (${STEPS.map(st => st.name).join(', ')})`);
  }
  const startedAt = new Date();
  const seconds: Record<string, number> = {};
  const counts: Record<string, number | string | null> = {};
  const states: Record<string, SourceState> = {};
  const c = await pool.connect();
  let locked = false;
  const timed = async (name: string, f: () => Promise<void>) => {
    const t = Date.now();
    log(`- ${name}`);
    await f();
    seconds[name] = Math.round((Date.now() - t) / 100) / 10;
    log(`  ${name}: ${seconds[name]}s`);
  };
  try {
    await c.query(`SET statement_timeout = ${lit(opts.statementTimeout || '3h')}`);
    await c.query(`SET work_mem = ${lit(opts.workMem || '256MB')}`);
    await c.query('SET max_parallel_workers_per_gather = 0');
    // sort / hash spill of the build to the HDD tablespace, not the NVMe (temp-tablespace.ts)
    await useTempTablespace(c, log);
    const lock = (await c.query(`SELECT pg_try_advisory_lock(hashtext('graph_enrichment')) AS ok`)).rows[0];
    if (!lock.ok) throw new Error('another graph enrichment build is running');
    locked = true;
    if (!(await tableExists(c, `${schema}.node`))) throw new Error(`${schema}.node missing: build the graph first (build-graph.ts)`);
    if (!(await tableExists(c, `${schema}.enrich_build`))) throw new Error(`${schema}.enrich_build missing: run migration 035_graph_enrichment.sql`);

    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.query(`CREATE SCHEMA ${S}`);
    for (const f of STAGE_FUNCS) await c.query(f);
    for (const ddl of enrichDdl(S)) await c.query(ddl);
    await c.query(`CREATE UNLOGGED TABLE ${S}.flag_raw (kind text, key text, flag text, source text, match text, as_of date, attrs jsonb, ref text, n int)`);
    await c.query(`CREATE UNLOGGED TABLE ${S}.edge_raw (src_kind text, src_key text, dst_kind text, dst_key text, kind text,
      valid_from date, valid_to date, source text, source_ref jsonb, attrs jsonb)`);
    await c.query(`CREATE UNLOGGED TABLE ${S}.name_key (raw text PRIMARY KEY, key text)`);

    const ctx: Ctx = { c, ext: opts.external || null, batch: opts.batchSize || 20000, today, counts, log };
    for (const st of STEPS) {
      if ((opts.only && !opts.only.includes(st.name)) || (opts.skip || []).includes(st.name)) { states[st.name] = 'excluded'; continue; }
      if (st.db === 'external' && !ctx.ext) { states[st.name] = 'no_external'; continue; }
      const db = st.db === 'external' ? ctx.ext! : c;
      let missing = false;
      for (const t of st.tables) if (!(await tableExists(db, t))) missing = true;
      if (missing) { states[st.name] = 'missing'; log(`  ${st.name}: source table missing, previous rows kept`); continue; }
      await timed(st.name, () => st.run(ctx));
      states[st.name] = 'built';
    }

    await timed('merge', async () => {
      // flags: one row per (node, flag, source) of a node in the graph
      await c.query(`INSERT INTO ${S}.node_flag (kind, key, flag, source, match, as_of, attrs, source_ref)
        SELECT r.kind, r.key, r.flag, r.source, min(r.match), max(r.as_of),
               (array_agg(r.attrs ORDER BY r.as_of DESC NULLS LAST))[1] || jsonb_build_object('records', sum(coalesce(r.n, 1))),
               jsonb_strip_nulls(jsonb_build_object('ids', to_jsonb((array_agg(DISTINCT r.ref) FILTER (WHERE r.ref IS NOT NULL))[1:5])))
        FROM ${S}.flag_raw r
        WHERE EXISTS (SELECT 1 FROM ${schema}.node g WHERE g.kind = r.kind AND g.key = r.key)
        GROUP BY r.kind, r.key, r.flag, r.source`);
      counts.flag_raw_rows = await n(c, `SELECT count(*) AS n FROM ${S}.flag_raw`);
      counts.edge_raw_rows = await n(c, `SELECT count(*) AS n FROM ${S}.edge_raw`);
      // edges between two nodes of the graph
      await c.query(`INSERT INTO ${S}.enrich_edge (${EDGE_COLS.join(', ')})
        SELECT ${EDGE_COLS.map(k => `e.${k}`).join(', ')} FROM ${S}.edge_raw e
        WHERE NOT (e.src_kind = e.dst_kind AND e.src_key = e.dst_key)
          AND EXISTS (SELECT 1 FROM ${schema}.node g WHERE g.kind = e.src_kind AND g.key = e.src_key)
          AND EXISTS (SELECT 1 FROM ${schema}.node g WHERE g.kind = e.dst_kind AND g.key = e.dst_key)
        ORDER BY e.kind, e.src_kind, e.src_key, e.dst_key`);
      // the sources that did not run keep their rows of the previous build
      const kept = STEPS.filter(st => states[st.name] !== 'built').flatMap(st => st.sources);
      if (kept.length && await tableExists(c, `${schema}.node_flag`)) {
        // (still only rows of nodes in the graph: the graph may have been rebuilt since)
        await c.query(`INSERT INTO ${S}.node_flag SELECT f.* FROM ${schema}.node_flag f WHERE f.source = ANY($1::text[])
          AND EXISTS (SELECT 1 FROM ${schema}.node g WHERE g.kind = f.kind AND g.key = f.key)`, [kept]);
        await c.query(`INSERT INTO ${S}.enrich_edge (${EDGE_COLS.join(', ')}) SELECT ${EDGE_COLS.map(k => `e.${k}`).join(', ')} FROM ${schema}.enrich_edge e
          WHERE e.source = ANY($1::text[])
            AND EXISTS (SELECT 1 FROM ${schema}.node g WHERE g.kind = e.src_kind AND g.key = e.src_key)
            AND EXISTS (SELECT 1 FROM ${schema}.node g WHERE g.kind = e.dst_kind AND g.key = e.dst_key)`, [kept]);
        counts.kept_flags = await n(c, `SELECT count(*) AS n FROM ${S}.node_flag WHERE source = ANY($1::text[])`, [kept]);
        counts.kept_edges = await n(c, `SELECT count(*) AS n FROM ${S}.enrich_edge WHERE source = ANY($1::text[])`, [kept]);
      }
      await c.query(`DROP TABLE ${S}.flag_raw, ${S}.edge_raw, ${S}.name_key`);
      for (const r of (await c.query(`SELECT flag || '_' || kind AS k, count(*) AS n FROM ${S}.node_flag GROUP BY 1 ORDER BY 1`)).rows) counts[`flags_${r.k}`] = Number(r.n);
      for (const r of (await c.query(`SELECT kind, count(*) AS n FROM ${S}.enrich_edge GROUP BY 1 ORDER BY 1`)).rows) counts[`edges_${r.kind}`] = Number(r.n);
      counts.flags = await n(c, `SELECT count(*) AS n FROM ${S}.node_flag`);
      counts.edges = await n(c, `SELECT count(*) AS n FROM ${S}.enrich_edge`);
      counts.flagged_nodes = await n(c, `SELECT count(*) AS n FROM (SELECT DISTINCT kind, key FROM ${S}.node_flag) x`);
    });
    await timed('indexes', async () => {
      for (const ddl of enrichIndexDdl(S)) await c.query(ddl);
      await c.query(`ANALYZE ${S}.node_flag`);
      await c.query(`ANALYZE ${S}.enrich_edge`);
    });
    await timed('check_personal_ids', async () => { Object.assign(counts, await checkEnrichmentIds(c, S)); });

    await timed('swap', async () => {
      await c.query('BEGIN');
      try {
        await c.query(`SET LOCAL lock_timeout = '60s'`);
        await c.query(`DROP TABLE IF EXISTS ${schema}.node_flag`);
        await c.query(`DROP TABLE IF EXISTS ${schema}.enrich_edge`);
        await c.query(`ALTER TABLE ${S}.node_flag SET SCHEMA ${schema}`);
        await c.query(`ALTER TABLE ${S}.enrich_edge SET SCHEMA ${schema}`);
        // the id sequence moves with its table (owned by the bigserial column)
        await c.query(`INSERT INTO ${schema}.enrich_build (started_at, params, sources, counts, seconds) VALUES ($1, $2, $3, $4, $5)`,
          [startedAt, { only: opts.only || null, skip: opts.skip || null, today, external: !!opts.external }, states, counts, seconds]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
    if (!opts.keepStage) await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    seconds.total = Math.round((Date.now() - startedAt.getTime()) / 100) / 10;
    log(`Enrichment built in ${seconds.total}s: ${counts.flags} flags, ${counts.edges} edges`);
    return { sources: states, counts, seconds };
  } catch (e) {
    if (!opts.keepStage) await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => undefined);
    throw e;
  } finally {
    await c.query('RESET statement_timeout').catch(() => undefined);
    await c.query('RESET work_mem').catch(() => undefined);
    await c.query('RESET max_parallel_workers_per_gather').catch(() => undefined);
    await c.query('RESET temp_tablespaces').catch(() => undefined);
    if (locked) await c.query(`SELECT pg_advisory_unlock(hashtext('graph_enrichment'))`).catch(() => undefined);
    c.release();
  }
}

/**
 * Post-build check: no standalone 10-digit run (a РНОКПП) in a key (foreign entities exempt: their
 * registration numbers) or an attribute (amounts exempt). Throws, so such a build is never swapped in.
 */
export async function checkEnrichmentIds(c: Queryable, schema: string): Promise<{ id_numbers_flags: number; id_numbers_enrich_edges: number }> {
  const minus = AMOUNT_ATTRS.map(a => ` - ${lit(a)}`).join('');
  const f = await n(c, `SELECT count(*) AS n FROM ${schema}.node_flag
    WHERE (kind <> 'foreign_entity' AND key ~ $1) OR (attrs${minus})::text ~ $1`, [TEN_DIGITS_SQL]);
  const e = await n(c, `SELECT count(*) AS n FROM ${schema}.enrich_edge
    WHERE (src_kind <> 'foreign_entity' AND src_key ~ $1) OR (dst_kind <> 'foreign_entity' AND dst_key ~ $1) OR (attrs${minus})::text ~ $1`, [TEN_DIGITS_SQL]);
  if (f || e) throw new Error(`personal ID numbers (10-digit runs) left in the enrichment: ${f} flags, ${e} edges. Not swapped in.`);
  return { id_numbers_flags: f, id_numbers_enrich_edges: e };
}

// ---------------------------------------------------------------- reading (find_connections / connection_path)

export interface OutFlag { flag: EnrichFlag; label: string; source: string; match: 'code' | 'name'; as_of: string | null; attrs?: Record<string, unknown> }
export interface OutEnrichEdge {
  from: number; to: number; type: EnrichEdgeKind; label: string;
  valid_from: string | null; valid_to: string | null; source: string; as_of: string | null; attrs?: Record<string, unknown>;
}

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString().slice(0, 10) : d == null ? null : String(d).slice(0, 10));

/**
 * Flags of the nodes and the enrichment edges between them (both ends among the nodes), for the
 * output of the graph tools. Empty when migration 035 / the enrichment build is missing.
 */
export async function enrichmentFor(db: Queryable, nodes: Array<{ id: number; kind: string; key: string }>, schema = 'graph',
  o: { maxEdges?: number } = {}): Promise<{ flags: Map<number, OutFlag[]>; edges: OutEnrichEdge[]; available: boolean }> {
  const flags = new Map<number, OutFlag[]>();
  const edges: OutEnrichEdge[] = [];
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('bad schema name');
  if (!nodes.length) return { flags, edges, available: false };
  const t = (await db.query(`SELECT to_regclass($1) AS f, to_regclass($2) AS e`, [`${schema}.node_flag`, `${schema}.enrich_edge`])).rows[0];
  if (!t.f || !t.e) return { flags, edges, available: false };
  const idOf = new Map<string, number>(nodes.map(x => [`${x.kind}\u0000${x.key}`, x.id]));
  const kinds = nodes.map(x => x.kind);
  const keys = nodes.map(x => x.key);
  const fr = await db.query(`SELECT f.kind, f.key, f.flag, f.source, f.match, f.as_of, f.attrs FROM ${schema}.node_flag f
    JOIN unnest($1::text[], $2::text[]) AS x(kind, key) ON f.kind = x.kind AND f.key = x.key ORDER BY f.flag, f.source`, [kinds, keys]);
  for (const r of fr.rows) {
    const id = idOf.get(`${r.kind}\u0000${r.key}`);
    if (id === undefined) continue;
    const attrs = { ...(r.attrs || {}) };
    delete attrs.records;
    const out: OutFlag = { flag: r.flag, label: FLAG_LABELS[r.flag as EnrichFlag] || r.flag, source: r.source, match: r.match, as_of: iso(r.as_of) };
    if (Object.keys(attrs).length) out.attrs = attrs;
    if (!flags.has(id)) flags.set(id, []);
    flags.get(id)!.push(out);
  }
  const er = await db.query(`SELECT e.src_kind, e.src_key, e.dst_kind, e.dst_key, e.kind, e.valid_from, e.valid_to, e.source, e.source_ref, e.attrs
    FROM unnest($1::text[], $2::text[]) AS a(kind, key)
    JOIN ${schema}.enrich_edge e ON e.src_kind = a.kind AND e.src_key = a.key
    JOIN unnest($1::text[], $2::text[]) AS b(kind, key) ON e.dst_kind = b.kind AND e.dst_key = b.key
    ORDER BY e.kind, e.id LIMIT ${Math.max(1, Math.floor(o.maxEdges ?? 500))}`, [kinds, keys]);
  for (const r of er.rows) {
    const from = idOf.get(`${r.src_kind}\u0000${r.src_key}`);
    const to = idOf.get(`${r.dst_kind}\u0000${r.dst_key}`);
    if (from === undefined || to === undefined) continue;
    const out: OutEnrichEdge = {
      from, to, type: r.kind, label: ENRICH_EDGE_LABELS[r.kind as EnrichEdgeKind] || r.kind,
      valid_from: iso(r.valid_from), valid_to: iso(r.valid_to), source: r.source, as_of: iso(r.source_ref?.as_of),
    };
    if (r.attrs && Object.keys(r.attrs).length) out.attrs = r.attrs;
    edges.push(out);
  }
  return { flags, edges, available: true };
}
