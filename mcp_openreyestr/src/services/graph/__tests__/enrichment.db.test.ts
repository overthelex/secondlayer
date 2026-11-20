/**
 * Graph enrichment build (LEXAI-2305) against a real PostgreSQL. Skipped unless
 * GRAPH_TEST_DATABASE_URL points at a throwaway database. Uses its own schemas (graph_et for the
 * graph, enrich_src for the source registers, graph_enrich_stage), so it does not clash with
 * build.db.test.ts. All names and numbers are synthetic.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { stageDdl } from '../builder';
import { buildEnrichment, checkEnrichmentIds, enrichmentFor } from '../enrichment';
import { foreignEntityKey, personKey } from '../keys';

const URL = process.env.GRAPH_TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;
const MIG = path.join(__dirname, '../../../migrations');
const G = 'graph_et';

const IVAN = 'ІВАНЕНКО ІВАН ІВАНОВИЧ';
const WIFE = 'ТЕСТЕНКО ТЕСТА ТЕСТІВНА';
const SON = 'ІВАНЕНКО ПЕТРО ІВАНОВИЧ';
const SHARE_OWNER = 'ПРИКЛАДЕНКО ПРИКЛАД ПРИКЛАДОВИЧ';
const ROMASHKA = 'Товариство з обмеженою відповідальністю "Ромашка"';
const EDR_IDS = 'Відомості згідно з Єдиним державним реєстром юридичних осіб, фізичних осіб-підприємців та громадських формувань';

d('graph enrichment build (real PostgreSQL)', () => {
  let pool: Pool;
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
  const flags = async (kind: string, key: string) =>
    (await q(`SELECT flag, source, match, as_of::text AS as_of, attrs FROM ${G}.node_flag WHERE kind = $1 AND key = $2 ORDER BY flag`, [kind, key])).rows;
  const edges = async (kind: string) =>
    (await q(`SELECT src_kind, src_key, dst_kind, dst_key, valid_from::text AS valid_from, valid_to::text AS valid_to, source, source_ref, attrs
              FROM ${G}.enrich_edge WHERE kind = $1 ORDER BY src_key, dst_key`, [kind])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 3, options: '-c search_path=enrich_src,public' });
    for (const s of [G, 'enrich_src', 'graph_enrich_stage']) await q(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await q(`CREATE SCHEMA ${G}`);
    await q('CREATE SCHEMA enrich_src');
    for (const ddl of stageDdl(G)) await q(ddl);
    await q(`ALTER TABLE ${G}.node ADD CONSTRAINT node_kind_key UNIQUE (kind, key)`);
    await q(fs.readFileSync(path.join(MIG, '032_graph_enrichment.sql'), 'utf8').replace(/graph\./g, `${G}.`));
    // graph nodes: three companies, the persons, a Russian founder
    const nodes: Array<[string, string, string]> = [
      ['company', '11111110', 'ТОВ "АЛЬФА"'], ['company', '22222220', 'ТОВ "БЕТА"'], ['company', '33333330', 'КП "ГАММА"'],
      ['person_name', personKey(IVAN)!, IVAN], ['person_name', personKey(WIFE)!, WIFE], ['person_name', personKey(SON)!, SON],
      ['person_name', personKey(SHARE_OWNER)!, SHARE_OWNER],
      ['foreign_entity', foreignEntityKey('RU', 'ТОВ «РОМАШКА»')!, 'ТОВ «РОМАШКА»'],
    ];
    for (const [kind, key, label] of nodes) await q(`INSERT INTO ${G}.node (kind, key, label) VALUES ($1, $2, $3)`, [kind, key, label]);

    // ---- source registers (the columns the build reads)
    await q(`CREATE TABLE rnbo_sanctions (id serial, entity_id text, schema_type text, name text, identifiers text, countries text,
             sanctions text, last_seen timestamp, updated_at timestamp)`);
    await q(`INSERT INTO rnbo_sanctions (entity_id, schema_type, name, identifiers, countries, sanctions, last_seen) VALUES
      ('s1', 'Organization', 'ТОВ "АЛЬФА"', $1, 'Україна UA', 'active', '2026-07-03'),
      ('s2', 'Person', 'Іваненко Іван Іванович', '1234567890 Податковий номер Україна', 'Україна UA', 'active', '2026-07-03'),
      ('s3', 'Organization', $2, '9990001112223 ОГРН', 'Російська Федерація RU', 'expired', '2026-07-03'),
      ('s4', 'Organization', 'ТОВ "ПОЗА ГРАФОМ"', '44444440 Податковий номер Україна', 'Україна UA', 'active', '2026-07-03')`,
    [`11111110 ${EDR_IDS}`, ROMASHKA]);
    await q(`CREATE TABLE tax_debt (id serial, report_date date, tin text, debt_total numeric)`);
    await q(`INSERT INTO tax_debt (report_date, tin, debt_total) VALUES ('2022-02-22', '11111110', 100.5), ('2022-02-22', '11111110', 200),
             ('2022-02-22', '1234567890', 50)`);
    await q(`CREATE TABLE debtors (id serial, proceeding_number text, debtor_type text, debtor_edrpou text, collection_category text,
             created_at timestamp, updated_at timestamp)`);
    await q(`INSERT INTO debtors (proceeding_number, debtor_type, debtor_edrpou, collection_category, updated_at) VALUES
             ('70000001', 'legal', '22222220', 'стягнення коштів', '2026-11-10')`);
    await q(`CREATE TABLE enforcement_proceedings (id serial, proceeding_number text, opening_date date, proceeding_status text,
             debtor_edrpou text, creditor_edrpou text, created_at timestamp, updated_at timestamp)`);
    await q(`INSERT INTO enforcement_proceedings (proceeding_number, opening_date, proceeding_status, debtor_edrpou, creditor_edrpou, updated_at) VALUES
      ('71000001', '2020-03-01', 'Завершено', '22222220', '33333330', '2026-11-17'),
      ('71000002', '2024-05-01', 'Відкрито', '22222220', '33333330', '2026-11-17'),
      ('71000003', '2023-01-10', 'Завершено', '11111110', '33333330', '2026-11-17'),
      ('71000004', '2025-01-10', 'Відкрито', '11111110', NULL, '2026-11-17'),
      ('71000005', '2025-02-10', 'Відкрито', '22222220', '22222220', '2026-11-17')`);
    await q(`CREATE TABLE legal_entities (id serial, record text, edrpou text)`);
    await q(`INSERT INTO legal_entities (record, edrpou) VALUES ('r3', '33333330')`);
    await q(`CREATE TABLE termination_started (id serial, entity_type text, entity_record text, op_date text, reason text, sbj_state text, creditor_req_end_date text)`);
    await q(`INSERT INTO termination_started (entity_type, entity_record, op_date, reason, sbj_state, creditor_req_end_date) VALUES
             ('UO', 'r3', '15.10.2026', 'рішення засновника 1234567890', 'в стані припинення', '15.12.2026')`);
    await q(`CREATE TABLE prozorro_tenders (id serial, tender_id text, buyer_edrpou text)`);
    await q(`INSERT INTO prozorro_tenders (tender_id, buyer_edrpou) VALUES ('t1', '33333330'), ('t2', '33333330')`);
    await q(`CREATE TABLE prozorro_contracts (contract_id text, tender_id text, status text, supplier_edrpou text, amount numeric, currency text,
             date_signed timestamptz, contract_date timestamptz, period_end date, tender_date_modified timestamptz)`);
    await q(`INSERT INTO prozorro_contracts VALUES
      ('c1', 't1', 'active', '11111110', 1500000000, 'UAH', '2023-04-01', NULL, '2023-12-31', '2023-04-02'),
      ('c2', 't2', 'active', '11111110', 1000, 'UAH', '2026-02-01', NULL, '2099-12-31', '2026-02-02'),
      ('c3', 't2', 'cancelled', '22222220', 10, 'UAH', '2026-02-01', NULL, NULL, '2026-02-02'),
      ('c4', 't2', 'active', '1234567890', 10, 'UAH', '2026-02-01', NULL, NULL, '2026-02-02')`);
    await q(`CREATE TABLE nazk_declarations (declaration_id text, declarant_id bigint, declaration_year int, declarant_name text,
             declarant_position text, declarant_workplace text, submission_date timestamp, relations_extracted_at timestamptz)`);
    await q(`INSERT INTO nazk_declarations VALUES
      ('00000000-0000-0000-0000-000000000001', 7, 2024, $1, 'головний спеціаліст', 'КП "ГАММА"', '2025-03-01', now()),
      ('00000000-0000-0000-0000-000000000002', 7, 2025, $1, 'начальник відділу', 'КП "ГАММА"', '2026-03-01', now())`, [IVAN]);
    await q(`CREATE TABLE nazk_family_members (declaration_id text, declarant_id bigint, declaration_year int, full_name text, relation text)`);
    await q(`INSERT INTO nazk_family_members VALUES
      ('00000000-0000-0000-0000-000000000001', 7, 2024, $1, 'дружина'),
      ('00000000-0000-0000-0000-000000000002', 7, 2025, $1, 'дружина'),
      ('00000000-0000-0000-0000-000000000002', 7, 2025, $2, 'син')`, [WIFE, SON]);
    await q(`CREATE TABLE nazk_corporate_rights (declaration_id text, declarant_id bigint, declaration_year int, right_kind text, owner_type text,
             owner_name text, owner_relation text, edrpou char(8), share_percent numeric, acquired_date date)`);
    await q(`INSERT INTO nazk_corporate_rights VALUES
      ('00000000-0000-0000-0000-000000000001', 7, 2024, 'corporate_rights', 'declarant', $1, NULL, '22222220', 50, NULL),
      ('00000000-0000-0000-0000-000000000001', 7, 2024, 'corporate_rights', 'family', $2, 'дружина', '11111110', 10, '2019-05-05'),
      ('00000000-0000-0000-0000-000000000002', 7, 2025, 'corporate_rights', 'family', $3, 'син', '33333330', 100, NULL)`, [IVAN, WIFE, SON]);
    // the secondlayer registers (here: the same database as the external connection)
    await q(`CREATE TABLE nbu_fin_licenses (id serial, edrpou text, institution_type text, license_status text, snapshot_date date)`);
    await q(`INSERT INTO nbu_fin_licenses (edrpou, institution_type, license_status, snapshot_date) VALUES
             ('22222220', 'Фінансова компанія', 'Діюча', '2026-11-16'), ('22222220', 'Фінансова компанія', 'Діюча', '2026-11-16')`);
    await q(`CREATE TABLE opendata_securities_owners (id serial, report_date date, issuer_edrpou text, owner_edrpou text, owner_name text,
             owner_type text, share_percent numeric)`);
    await q(`INSERT INTO opendata_securities_owners (report_date, issuer_edrpou, owner_edrpou, owner_name, owner_type, share_percent) VALUES
      ('2025-12-31', '11111110', '33333330', 'КП "ГАММА"', 'legal', 30), ('2026-06-30', '11111110', '33333330', 'КП "ГАММА"', 'legal', 25),
      ('2024-12-31', '22222220', NULL, $1, 'individual', 12), ('2026-06-30', '22222220', NULL, $2, 'individual', 3)`, [SHARE_OWNER, IVAN]);
    await q(`CREATE TABLE opendata_nazk_war_sanctions (id serial, category text, tin text, name_uk text, imported_at timestamptz)`);
    await q(`INSERT INTO opendata_nazk_war_sanctions (category, tin, name_uk, imported_at) VALUES
      ('sanctions_companies', '33333330', 'КП "ГАММА"', '2026-07-03'), ('sanctions_companies', '1234567890', 'ООО "ТЕСТ"', '2026-07-03'),
      ('sanctions_persons', NULL, $1, '2026-07-03'), ('stolen_objects', NULL, 'картина', '2026-07-03')`, [SHARE_OWNER]);
  });

  afterAll(async () => {
    if (pool) {
      for (const s of [G, 'enrich_src', 'graph_enrich_stage']) await q(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
      await pool.end();
    }
  });

  it('builds flags and edges from the registers, only for graph nodes, without tax numbers', async () => {
    const r = await buildEnrichment(pool, { schema: G, external: pool, today: '2026-11-20', log: () => undefined });
    expect(r.sources).toMatchObject({ rnbo_sanctions: 'built', tax_debt: 'built', esv_debt: 'missing', nazk: 'built',
      nbu_fin_licenses: 'built', opendata_securities_owners: 'built', nazk_war_sanctions: 'built' });
    expect(r.counts).toMatchObject({ id_numbers_flags: 0, id_numbers_enrich_edges: 0 });

    const alpha = await flags('company', '11111110');
    expect(alpha.map((f: any) => f.flag)).toEqual(['enforcement', 'sanctions', 'tax_debt']);
    expect(alpha.find((f: any) => f.flag === 'tax_debt')).toMatchObject({ match: 'code', as_of: '2022-02-22', attrs: { debt_total: 300.5, records: 2 } });
    expect(alpha.find((f: any) => f.flag === 'enforcement').attrs).toMatchObject({ proceedings: 2, open: 1 });
    expect((await flags('person_name', personKey(IVAN)!)).map((f: any) => [f.flag, f.match])).toEqual([['pep_declarant', 'name'], ['sanctions', 'name']]);
    expect((await flags('person_name', personKey(IVAN)!)).find((f: any) => f.flag === 'pep_declarant'))
      .toMatchObject({ as_of: '2025-12-31', attrs: { position: 'начальник відділу', last_year: 2025, declarations: 2 } });
    expect(await flags('foreign_entity', foreignEntityKey('RU', 'ТОВ «РОМАШКА»')!)).toEqual([
      expect.objectContaining({ flag: 'sanctions', match: 'name', attrs: expect.objectContaining({ status: 'expired' }) })]);
    expect((await flags('company', '22222220')).map((f: any) => f.flag)).toEqual(['debtor_register', 'enforcement', 'fin_licence']);
    const gamma = await flags('company', '33333330');
    expect(gamma.map((f: any) => f.flag)).toEqual(['termination', 'war_sanctions']);
    expect(gamma[0]).toMatchObject({ as_of: '2026-10-15', attrs: { reason: 'рішення засновника', creditor_claims_until: '2026-12-15' } });
    expect((await flags('person_name', personKey(SHARE_OWNER)!)).map((f: any) => f.flag)).toEqual(['war_sanctions']);
    // not in the graph: no row
    expect(await flags('company', '44444440')).toEqual([]);

    // creditor -> debtor, per pair; open proceeding = current; self-claims dropped
    expect(await edges('creditor')).toEqual([
      expect.objectContaining({ src_key: '33333330', dst_key: '11111110', valid_from: '2023-01-10', valid_to: '2023-01-10', attrs: { proceedings: 1, open: 0 } }),
      expect.objectContaining({ src_key: '33333330', dst_key: '22222220', valid_from: '2020-03-01', valid_to: null, attrs: { proceedings: 2, open: 1 } }),
    ]);
    // supplier -> buyer; cancelled contracts and ФОП (10-digit) suppliers dropped; a contract in force = current
    const sup = await edges('supplier');
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ src_key: '11111110', dst_key: '33333330', valid_from: '2023-04-01', valid_to: null,
      attrs: { contracts: 2, tenders: 2, amount_uah: 1500001000 } });
    // НАЗК: declarant and spouse as owners, the son never; family: spouse only
    expect((await edges('declared_owner')).map((e: any) => [e.src_key, e.dst_key, e.valid_from, e.valid_to, e.attrs.owner])).toEqual([
      [personKey(IVAN), '22222220', '2024-01-01', '2024-12-31', 'declarant'],
      [personKey(WIFE), '11111110', '2019-05-05', '2024-12-31', 'дружина'],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect((await edges('family')).map((e: any) => [e.src_key, e.dst_key, e.valid_to, e.attrs.relation])).toEqual([
      [personKey(IVAN), personKey(WIFE), null, 'дружина']]);
    // НКЦПФР: >= 5 % only, current when in the newest report
    expect((await edges('shareholder')).map((e: any) => [e.src_kind, e.src_key, e.dst_key, e.valid_to, e.attrs.share_percent])).toEqual([
      ['company', '33333330', '11111110', null, 25],
      ['person_name', personKey(SHARE_OWNER), '22222220', '2024-12-31', 12],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
    // no 10-digit run anywhere in the stored rows (amounts aside)
    const all = JSON.stringify((await q(`SELECT kind, key, attrs - 'debt_total' AS a FROM ${G}.node_flag`)).rows)
      + JSON.stringify((await q(`SELECT src_key, dst_key, attrs - 'amount_uah' AS a FROM ${G}.enrich_edge`)).rows);
    expect(all).not.toMatch(/(^|[^0-9])[0-9]{10}([^0-9]|$)/);
    expect((await q(`SELECT count(*)::int AS n FROM ${G}.enrich_build`)).rows[0].n).toBe(1);
  });

  it('a partial run keeps the other sources; flags and edges are read by node', async () => {
    await q(`UPDATE tax_debt SET debt_total = 1`);
    const r = await buildEnrichment(pool, { schema: G, only: ['tax_debt'], today: '2026-11-20', log: () => undefined });
    expect(r.sources).toMatchObject({ tax_debt: 'built', rnbo_sanctions: 'excluded', nbu_fin_licenses: 'excluded' });
    expect((await flags('company', '11111110')).find((f: any) => f.flag === 'tax_debt').attrs.debt_total).toBe(2);
    expect((await flags('company', '11111110')).map((f: any) => f.flag)).toEqual(['enforcement', 'sanctions', 'tax_debt']);
    expect((await edges('supplier'))).toHaveLength(1);

    const nodes = (await q(`SELECT id::int AS id, kind, key FROM ${G}.node WHERE key IN ('11111110', '33333330')`)).rows;
    const e = await enrichmentFor(pool, nodes, G);
    expect(e.available).toBe(true);
    const alpha = nodes.find((x: any) => x.key === '11111110').id;
    const gamma = nodes.find((x: any) => x.key === '33333330').id;
    expect(e.flags.get(alpha)!.map(f => f.flag)).toEqual(['enforcement', 'sanctions', 'tax_debt']);
    expect(e.flags.get(alpha)![0].label).toBe('боржник у виконавчих провадженнях');
    expect(e.edges.map(x => [x.type, x.from, x.to]).sort()).toEqual([
      ['creditor', gamma, alpha], ['shareholder', gamma, alpha], ['supplier', alpha, gamma]].sort());
    expect(e.edges.find(x => x.type === 'supplier')).toMatchObject({ source: 'prozorro_contracts', as_of: '2026-02-02', label: 'постачальник' });
    // without the enrichment tables the reader is a no-op
    expect((await enrichmentFor(pool, nodes, 'public')).available).toBe(false);
  });

  it('the 10-digit check fails a build that would leak a tax number', async () => {
    await q(`CREATE SCHEMA IF NOT EXISTS graph_enrich_stage`);
    await q(`CREATE TABLE graph_enrich_stage.node_flag (LIKE ${G}.node_flag INCLUDING DEFAULTS)`);
    await q(`CREATE TABLE graph_enrich_stage.enrich_edge (LIKE ${G}.enrich_edge INCLUDING DEFAULTS)`);
    await q(`INSERT INTO graph_enrich_stage.node_flag (kind, key, flag, source, match, attrs) VALUES ('company', '11111110', 'tax_debt', 't', 'code', '{"x": "1234567890"}')`);
    await expect(checkEnrichmentIds(pool, 'graph_enrich_stage')).rejects.toThrow(/10-digit/);
    await q(`DROP SCHEMA graph_enrich_stage CASCADE`);
  });
});
