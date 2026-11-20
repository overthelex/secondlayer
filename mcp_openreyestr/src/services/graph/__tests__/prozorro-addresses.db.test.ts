/**
 * ProZorro supplier addresses in the graph build (LEXAI-2317) against a real PostgreSQL. Skipped
 * unless GRAPH_TEST_DATABASE_URL points at a throwaway database (drops and recreates the schemas
 * edr_hist, graph, graph_stage and the tables legal_entities / founders / signers / beneficiaries /
 * prozorro_contracts). Synthetic companies and addresses only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { buildGraph } from '../builder';
import { normAddress } from '../../graph-norm/address';
import { uaMatchKey } from '../../edr-history/norm';

const URL = process.env.GRAPH_TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;
const MIG = path.join(__dirname, '../../../migrations');
const S18 = '2018-09-22';
const S21 = '2021-11-01';

const EDR_X = 'Україна, 01001, місто Київ, ВУЛИЦЯ ТЕСТОВА, будинок 10, офіс 5';
const EDR_P = 'Україна, 01001, місто Київ, ПРОСПЕКТ ПРОБНИЙ, будинок 5';
const EDR_B = 'Україна, 01001, місто Київ, ВУЛИЦЯ ЗРАЗКОВА, будинок 1';
const k = (raw: string) => normAddress(raw).addressKey!;

d('graph build: ProZorro supplier addresses (real PostgreSQL)', () => {
  let pool: Pool;
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
  let n = 0;
  async function contract(edrpou: string, region: string | null, locality: string | null, street: string | null, signed: string | null, date?: string) {
    n++;
    await q(`INSERT INTO prozorro_contracts (contract_id, tender_id, supplier_edrpou, supplier_scheme, supplier_region, supplier_locality,
               supplier_address, date_signed, contract_date) VALUES ($1, 't' || $1, $2, 'UA-EDR', $3, $4, $5, $6, $7)`,
    [`c${String(n).padStart(4, '0')}`, edrpou, region, locality, street, signed, date || signed]);
  }
  async function company(edrpou: string, name: string, registered_on: string, first = S18) {
    await q(`INSERT INTO edr_hist.company (edrpou, kind, name, name_latn, status, registered_on, first_seen, last_seen)
             VALUES ($1, 'uo', $2, $3, 'зареєстровано', $4, $5, $6)`, [edrpou, name, uaMatchKey(name) || null, registered_on, first, S21]);
  }
  async function address(edrpou: string, raw: string, first: string, last: string | null) {
    await q(`INSERT INTO edr_hist.history (edrpou, field, value_hash, value, kind, first_snapshot, last_snapshot)
             VALUES ($1, 'address', md5($2), $2, 'uo', $3, $4)`, [edrpou, raw, first, last]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 3 });
    for (const s of ['edr_hist', 'graph', 'graph_stage']) await q(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    for (const t of ['legal_entities', 'founders', 'signers', 'beneficiaries', 'prozorro_contracts']) await q(`DROP TABLE IF EXISTS public.${t}`);
    for (const f of ['027_edr_history.sql', '030_graph_schema.sql', '031_graph_hubs_and_organisations.sql', '032_graph_court_parties.sql', '033_graph_prozorro_source.sql', '025_prozorro_contracts.sql']) {
      await q(fs.readFileSync(path.join(MIG, f), 'utf8'));
    }
    await q(`CREATE TABLE legal_entities (id serial PRIMARY KEY, record varchar(50) UNIQUE NOT NULL, edrpou varchar(20), name text,
             short_name text, opf text, stan varchar(100), registration text, updated_at timestamp)`);
    for (const [t, c] of [['founders', 'founder_info'], ['signers', 'signer_info'], ['beneficiaries', 'beneficiary_info']]) {
      await q(`CREATE TABLE ${t} (id serial PRIMARY KEY, entity_type varchar(10) NOT NULL, entity_record varchar(50) NOT NULL, ${c} text NOT NULL)`);
    }
    await q(`INSERT INTO edr_hist.snapshot (kind, snapshot_date, source, subjects, fields) VALUES
      ('uo', $1, 't', 0, '{address,head,name}'), ('uo', $2, 't', 0, '{address,head,name}')`, [S18, S21]);

    // A: ЄДР address X (open). ProZorro confirms X in 2019 (spelled the OCDS way, street type
    // omitted), then a new building Y from 2024: A moved after the last ЄДР address snapshot.
    await company('11111110', 'ТОВ "АЛЬФА"', '2010-01-01');
    await address('11111110', EDR_X, S18, null);
    await contract('11111110', 'м. Київ', 'Київ', 'Тестова, 10, оф. 7', '2019-03-01T10:00:00+02:00');
    await contract('11111110', 'м. Київ', 'Київ', 'вул. Нова, 3', '2024-02-01T10:00:00+02:00');
    await contract('11111110', 'м. Київ', 'м. Київ', 'вулиця Нова, буд. 3, тел. 0441234567', '2025-06-01T10:00:00+02:00');
    // B: ЄДР address (open, confirmed 2021). A ProZorro address of 2020 is older: the ЄДР wins.
    await company('22222220', 'ТОВ "БЕТА"', '2012-01-01');
    await address('22222220', EDR_B, S18, null);
    await contract('22222220', 'м. Київ', 'Київ', 'вул. Стара, 9', '2020-05-01T10:00:00+02:00');
    // C: ЄДР 'проспект Пробний 5'; ProZorro 'Пробний, 5' (read as вулиця) is the same building
    await company('33333330', 'ТОВ "ГАММА"', '2014-01-01');
    await address('33333330', EDR_P, S18, null);
    await contract('33333330', 'м. Київ', 'Київ', 'Пробний, 5', '2025-01-10T10:00:00+02:00');
    // E: registered after 2021, no ЄДР address: two ProZorro addresses, the newer one is current;
    // a contract without dateSigned dated by the contract date; one with a broken year; a village
    // without a postcode (skipped)
    await company('55555550', 'ТОВ "ЕПСІЛОН"', '2023-03-03', S21);
    await contract('55555550', 'Львівська область', 'м. Львів', 'вул. Перша, 1', '2023-05-01T10:00:00+03:00');
    await contract('55555550', 'Львівська область', 'м. Львів', 'вул. Друга, 2', null, '2026-01-15T10:00:00+02:00');
    await contract('55555550', 'Львівська область', 'м. Львів', 'вул. Третя, 3', '0516-01-01T00:00:00+00:00');
    await contract('55555550', 'Львівська область', 'село Тестове', 'вул. Садова, 1', '2025-02-01T10:00:00+02:00');
    // a supplier unknown to the ЄДР and an individual (10-digit code): ignored
    await contract('99999990', 'м. Київ', 'м. Київ', 'вул. Тестова, 1', '2025-01-01T10:00:00+02:00');
    await contract('1234567890', 'м. Київ', 'м. Київ', 'вул. Тестова, 2', '2025-01-01T10:00:00+02:00');
  });

  afterAll(async () => {
    // the other graph tests build over the same database and expect no ProZorro data
    await pool?.query('DROP TABLE IF EXISTS prozorro_contracts, prozorro_contracts_off');
    await pool?.end();
  });

  const regAt = async (edrpou: string) => (await q(`
    SELECT d.key, e.valid_from::text AS vf, e.valid_to::text AS vt, e.source, e.attrs, e.source_ref
    FROM graph.edge e JOIN graph.node s ON s.id = e.src JOIN graph.node d ON d.id = e.dst
    WHERE e.kind = 'registered_at' AND s.key = $1 ORDER BY e.valid_from NULLS FIRST, d.key`, [edrpou])).rows;

  it('adds dated ProZorro addresses, ЄДР first when it is newer', async () => {
    const r = await buildGraph(pool, { log: () => undefined });
    const X = k(EDR_X);
    const Y = k('Україна, місто Київ, вулиця Нова, будинок 3');

    // A: X confirmed by ProZorro, closed when the newer building Y appears after the ЄДР snapshot
    const a = await regAt('11111110');
    expect(a.map(e => [e.key, e.source])).toEqual([[X, 'edr_hist'], [Y, 'prozorro']]);
    expect(a[0]).toMatchObject({ vf: null, vt: '2024-02-01' });
    expect(a[0].attrs).toMatchObject({ prozorro_confirmed_until: '2019-03-01', closed_by: 'prozorro', confirmed_until: S21 });
    expect(a[0].source_ref.prozorro).toMatchObject({ table: 'prozorro_contracts', contracts: 1, contract_ids: ['c0001'] });
    expect(a[1]).toMatchObject({ vf: '2024-02-01', vt: null });
    expect(a[1].attrs).toMatchObject({ confirmed_until: '2025-06-01', contracts: 2 });
    expect(a[1].source_ref.prozorro).toMatchObject({ first_seen: '2024-02-01', last_seen: '2025-06-01', contract_ids: ['c0003'] }); // the newest spelling's contracts
    expect(JSON.stringify(a[1].attrs)).not.toMatch(/[0-9]{10}/);

    // B: the ЄДР address stays current, the older ProZorro address is closed at its last contract
    const b = await regAt('22222220');
    expect(b.map(e => [e.source, e.vf, e.vt])).toEqual([['edr_hist', null, null], ['prozorro', '2020-05-01', '2020-05-01']]);

    // C: another street type, same building -> no new edge
    const c = await regAt('33333330');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ key: k(EDR_P), source: 'edr_hist', vt: null });
    expect(c[0].attrs.prozorro_confirmed_until).toBe('2025-01-10');

    // E: first addresses from ProZorro; the newer is current; bad dates and the village are skipped
    const e = await regAt('55555550');
    expect(e.map(x => [x.source, x.vf, x.vt])).toEqual([['prozorro', '2023-05-01', '2023-05-01'], ['prozorro', '2026-01-15', null]]);

    // ignored suppliers have no node
    expect((await q(`SELECT count(*)::int n FROM graph.node WHERE kind = 'company' AND key IN ('99999990', '1234567890')`)).rows[0].n).toBe(0);
    // the ProZorro-only buildings got labelled address nodes
    expect((await q(`SELECT label FROM graph.node WHERE kind = 'address' AND key = $1`, [Y])).rows[0].label).toMatch(/нова, 3$/);

    expect(r.counts).toMatchObject({
      prozorro_suppliers: 4, prozorro_runs: 6, edges_prozorro_address: 4, edges_prozorro_address_current: 2,
      prozorro_confirms_edr: 2, edr_closed_by_prozorro: 1, prozorro_first_address_companies: 1,
      prozorro_differs_from_edr_companies: 2, prozorro_same_as_edr_companies: 1, prozorro_spellings_village_no_postcode: 1,
      id_numbers_nodes: 0, id_numbers_edges: 0,
    });
    expect((await q(`SELECT count(*)::int n FROM graph.edge WHERE source = 'prozorro'`)).rows[0].n).toBe(4);
  });

  it('--no-prozorro leaves them out; a database without prozorro_contracts builds as before', async () => {
    const off = await buildGraph(pool, { log: () => undefined, prozorroAddresses: false });
    expect(off.counts.prozorro_runs).toBe(0);
    expect((await q(`SELECT count(*)::int n FROM graph.edge WHERE source = 'prozorro'`)).rows[0].n).toBe(0);
    await q('ALTER TABLE prozorro_contracts RENAME TO prozorro_contracts_off');
    try {
      const r = await buildGraph(pool, { log: () => undefined });
      expect(r.counts.prozorro).toBe('absent');
      expect((await regAt('11111110')).map(e => [e.source, e.vt])).toEqual([['edr_hist', null]]);
    } finally {
      await q('ALTER TABLE prozorro_contracts_off RENAME TO prozorro_contracts');
    }
  });
});
