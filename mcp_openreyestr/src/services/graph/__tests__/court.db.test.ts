/**
 * Court decision parties -> co_party edges (LEXAI-2304) against a real PostgreSQL. Skipped unless
 * GRAPH_TEST_DATABASE_URL points at a throwaway server: the test creates (once) and uses its own
 * database <name>_court, so it never races build.db.test.ts. The backend tables (edrsr_parties,
 * edrsr_documents, edrsr_parties_coverage) are mocked in schema court_src, read through a second
 * pool with that search_path, as the loader reads the backend database. All data is synthetic.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { buildGraph, checkPersonalIds } from '../builder';
import { loadCourtParties } from '../court';
import { neighbourhood } from '../neighbourhood';
import { uaMatchKey } from '../../edr-history/norm';

const BASE = process.env.GRAPH_TEST_DATABASE_URL;
const d = BASE ? describe : describe.skip;
const MIG = path.join(__dirname, '../../../migrations');

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const A = '11111110';
const B = '22222220';
const C = '22222233';
const D = '44444440';

d('court co_party edges (real PostgreSQL)', () => {
  let pool: Pool;
  let source: Pool;
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
  let doc = 0;

  async function decision(date: string, caseNumber: string | null, parties: Array<[number, string | null, string]>, docId = ++doc) {
    const y = Number(date.slice(0, 4));
    await q(`INSERT INTO court_src.edrsr_documents (doc_id, cause_num, adjudication_date, justice_kind) VALUES ($1, $2, $3, 3)`,
      [docId, caseNumber, `${date} 10:00:00+02`]);
    const ord: Record<number, number> = {};
    for (const [role, code, name] of parties) {
      ord[role] = (ord[role] || 0) + 1;
      await q(`INSERT INTO court_src.edrsr_parties (doc_id, role, ord, name_raw, name_norm, edrpou, court_code, justice_kind, adjudication_date, adj_year)
               VALUES ($1, $2, $3, $4, lower($4), $5, 910, 3, $6, $7)`, [docId, role, ord[role], name, code, `${date} 10:00:00+02`, y]);
    }
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: BASE, max: 1 });
    const name = `${new URL(BASE!).pathname.slice(1) || 'postgres'}_court`;
    const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows.length;
    if (!exists) await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const url = withDb(BASE!, name);
    pool = new Pool({ connectionString: url, max: 3 });
    source = new Pool({ connectionString: url, max: 1, options: '-c search_path=court_src -c default_transaction_read_only=on' });

    for (const s of ['edr_hist', 'graph', 'graph_stage', 'court_src']) await q(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    for (const t of ['legal_entities', 'founders', 'signers', 'beneficiaries']) await q(`DROP TABLE IF EXISTS public.${t}`);
    for (const m of ['027_edr_history.sql', '030_graph_schema.sql', '031_graph_hubs_and_organisations.sql', '032_graph_court_parties.sql']) {
      await q(fs.readFileSync(path.join(MIG, m), 'utf8'));
    }
    await q(`CREATE TABLE legal_entities (id serial PRIMARY KEY, record varchar(50) UNIQUE NOT NULL, edrpou varchar(20), name text,
             short_name text, opf text, stan varchar(100), registration text, updated_at timestamp)`);
    for (const [t, c] of [['founders', 'founder_info'], ['signers', 'signer_info'], ['beneficiaries', 'beneficiary_info']]) {
      await q(`CREATE TABLE ${t} (id serial PRIMARY KEY, entity_type varchar(10) NOT NULL, entity_record varchar(50) NOT NULL, ${c} text NOT NULL)`);
    }
    await q(`INSERT INTO edr_hist.snapshot (kind, snapshot_date, source, subjects, fields) VALUES ('uo', '2021-11-01', 't', 0, '{address,beneficiary,founder,head,name}')`);
    for (const [code, n] of [[A, 'ТОВ "АЛЬФА"'], [B, 'ТОВ "БЕТА"'], [C, 'ТОВ "ДЕЛЬТА"'], [D, 'ТОВ "ОМЕГА"']]) {
      await q(`INSERT INTO edr_hist.company (edrpou, kind, name, name_latn, status, registered_on, first_seen, last_seen)
               VALUES ($1, 'uo', $2, $3, 'зареєстровано', NULL, '2021-11-01', '2021-11-01')`, [code, n, uaMatchKey(n)]);  // no reg_neighbour edges
    }
    // A has a founder, so its ЄДР degree is 1 before the court edges
    await q(`INSERT INTO edr_hist.founder (edrpou, entry_hash, raw, kind, name, name_latn, code, country_code, first_seen, last_seen)
             VALUES ($1, md5('f'), 'f', 'organisation', 'ТОВ "ОМЕГА"', $2, $3, 'UA', '2021-11-01', '2021-11-01')`, [A, uaMatchKey('ТОВ "ОМЕГА"'), D]);

    // the backend side (synthetic): decision parties, the documents with the case numbers, coverage
    await q('CREATE SCHEMA court_src');
    await q(`CREATE TABLE court_src.edrsr_parties (doc_id bigint, role smallint, ord smallint, name_raw text, name_norm text, edrpou text,
             court_code int, justice_kind smallint, adjudication_date timestamptz, adj_year smallint, name_core text)`);
    await q(`CREATE TABLE court_src.edrsr_documents (doc_id bigint, cause_num text, adjudication_date timestamptz, justice_kind smallint)`);
    await q(`CREATE TABLE court_src.edrsr_parties_coverage (adj_year smallint PRIMARY KEY, doc_count bigint, party_count bigint, built_at timestamptz)`);
    await q(`INSERT INTO court_src.edrsr_parties_coverage VALUES (2023, 0, 0, '2026-11-01'), (2024, 5, 9, '2026-11-01'), (2025, 1, 2, '2026-11-01')`);
    // A sues B twice in one case (two spellings of the number), B sues A in another case
    await decision('2024-03-01', '910/100/24', [[1, A, 'ТОВ "АЛЬФА"'], [2, B, 'ТОВ "БЕТА"']]);
    await decision('2024-06-01', '910 / 100/24', [[1, A, 'ТОВ "АЛЬФА"'], [2, B, 'ТОВ "БЕТА"']]);
    await decision('2025-02-01', '911/5/25', [[1, B, 'ТОВ "БЕТА"'], [2, A, 'ТОВ "АЛЬФА"']]);
    // C third party in a case of B
    await decision('2024-07-01', '910/7/24', [[2, B, 'ТОВ "БЕТА"'], [3, C, 'ТОВ "ДЕЛЬТА"']]);
    // a depersonalised individual and a ФОП with a (synthetic) 10-digit РНОКПП: never copied
    await decision('2024-08-01', '2/100/24', [[1, A, 'ТОВ "АЛЬФА"'], [2, null, 'ОСОБА_1'], [2, '1234567890', 'ФОП ТЕСТЕНКО Т.Т.']]);
    // a code that is not in the ЄДР: no node, no edge
    await decision('2024-09-01', '910/9/24', [[1, A, 'ТОВ "АЛЬФА"'], [2, '99999990', 'ТОВ "НЕВІДОМО"']]);
    // a decision with three coded parties: dropped by maxPartiesPerDecision 2 below
    await decision('2024-10-01', '910/10/24', [[1, A, 'ТОВ "АЛЬФА"'], [2, C, 'ТОВ "ДЕЛЬТА"'], [2, D, 'ТОВ "ОМЕГА"']]);
  });

  afterAll(async () => {
    await source?.end();
    await pool?.end();
  });

  it('copies only coded parties, by year, and skips unchanged years', async () => {
    const r = await loadCourtParties(source, pool, { log: () => undefined });
    expect(r.years.map(y => [y.year, y.rows])).toEqual([[2023, 0], [2024, 12], [2025, 2]]);
    const rows = (await q('SELECT * FROM graph.court_party ORDER BY doc_id, role, ord')).rows;
    expect(rows.every(x => /^\d{8}$/.test(x.edrpou))).toBe(true);
    expect(rows.some(x => x.edrpou === '1234567890')).toBe(false);
    expect(Object.keys(rows[0])).not.toContain('name_raw');
    expect(rows.find(x => x.doc_id === '2')).toMatchObject({ case_number: '910 / 100/24', case_key: '910/100/24', role: 1, edrpou: A });
    expect((await q(`SELECT decided_on::text AS d FROM graph.court_party WHERE doc_id = 1 LIMIT 1`)).rows[0].d).toBe('2024-03-01');
    // second run: 2023 is unchanged (and older than the last two years), 2024 / 2025 are refreshed
    const again = await loadCourtParties(source, pool, { log: () => undefined });
    expect(again.years.map(y => [y.year, y.skipped ?? y.rows])).toEqual([[2023, 'unchanged'], [2024, 12], [2025, 2]]);
    expect(Number((await q('SELECT count(*) AS n FROM graph.court_party')).rows[0].n)).toBe(14);
  });

  it('builds co_party edges between companies of the ЄДР, one per pair', async () => {
    const r = await buildGraph(pool, { streetRenamings: null, court: { maxPartiesPerDecision: 2, hubThreshold: 1 }, log: () => undefined });
    expect(r.counts.edges_co_party).toBe(2);
    expect(r.counts.court_decisions_mass).toBe(1);
    expect(r.counts.hubs_court).toBe(1);
    const e = (await q(`SELECT s.key AS src, d.key AS dst, e.valid_from::text AS vf, e.valid_to::text AS vt, e.source, e.attrs, e.source_ref
      FROM graph.edge e JOIN graph.node s ON s.id = e.src JOIN graph.node d ON d.id = e.dst WHERE e.kind = 'co_party' ORDER BY 1, 2`)).rows;
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ src: A, dst: B, vf: '2024-03-01', vt: '2025-02-01', source: 'edrsr' });
    expect(e[0].attrs).toEqual({ decisions: 3, cases: 2, roles: { 'plaintiff-defendant': 2, 'defendant-plaintiff': 1 }, justice_kinds: [3] });
    expect(e[0].source_ref.edrsr.decisions).toEqual([3, 2, 1]);
    expect(e[0].source_ref.edrsr.cases.sort()).toEqual(['910 / 100/24', '910/100/24', '911/5/25']);
    expect(e[1]).toMatchObject({ src: B, dst: C, attrs: { decisions: 1, cases: 1, roles: { 'defendant-third_party': 1 } } });
    // no node for the unknown code nor for any person
    expect((await q(`SELECT count(*) AS n FROM graph.node WHERE key IN ('99999990', '1234567890') OR kind = 'person_name'`)).rows[0].n).toBe('0');
    // degree and hub: B has two counterparties (> 1) -> litigation hub; A keeps its founder edge
    const node = async (k: string) => (await q(`SELECT degree, hub, attrs FROM graph.node WHERE kind = 'company' AND key = $1`, [k])).rows[0];
    const a = await node(A);
    const b = await node(B);
    expect(a).toMatchObject({ degree: 2, hub: false });
    expect(a.attrs.degree_by_kind).toEqual({ founder: 1, co_party: 1 });
    expect(a.attrs.court).toEqual({ counterparties: 1, decisions: 3 });
    expect(b).toMatchObject({ degree: 2, hub: true });
    expect(b.attrs.court).toEqual({ counterparties: 2, decisions: 4, hub: true });
    await expect(checkPersonalIds(pool, 'graph')).resolves.toEqual({ id_numbers_nodes: 0, id_numbers_edges: 0 });
  });

  it('walks co_party edges and stops at a litigation hub', async () => {
    const r = await neighbourhood(pool, A, { depth: 2, kinds: ['co_party'] });
    expect(r.nodes.map(n => n.key).sort()).toEqual([A, B]);
    expect(r.truncated.hubs).toHaveLength(1);
    const all = await neighbourhood(pool, B, { depth: 1, kinds: ['co_party'] });
    expect(all.nodes.map(n => n.key).sort()).toEqual([A, B, C]);
  });

  it('builds without court edges when disabled', async () => {
    const r = await buildGraph(pool, { streetRenamings: null, court: false, log: () => undefined });
    expect(r.counts.edges_co_party).toBeUndefined();
    expect((await q(`SELECT count(*) AS n FROM graph.edge WHERE kind = 'co_party'`)).rows[0].n).toBe('0');
  });
});
