/**
 * Graph builder and neighbourhood query against a real PostgreSQL. Skipped unless
 * GRAPH_TEST_DATABASE_URL points at a throwaway database: the test drops and recreates the schemas
 * edr_hist, graph, graph_stage and the tables legal_entities / founders / signers / beneficiaries.
 *
 *   GRAPH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/graphtest npx jest graph
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { buildGraph, checkPersonalIds } from '../builder';
import { neighbourhood } from '../neighbourhood';
import {
  addressKeyRow, addressKeyVersion, CODE8_RE_SOURCE, isOrganisationName, isPlaceholderName, normName, ORG_FORM_RE_SOURCE,
  organisationKey, PATRONYMIC_RE_SOURCE, PLACEHOLDER_RE_SOURCE, personKey, WEAK_PLACEHOLDER_RE_SOURCE,
} from '../keys';
import { uaMatchKey } from '../../edr-history/norm';

const URL = process.env.GRAPH_TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;
const MIG = path.join(__dirname, '../../../migrations');

const S18 = '2018-09-22';
const S21 = '2021-11-01';
const CUR = '2026-11-18';
const IVANENKO = 'ІВАНЕНКО ІВАН ІВАНОВИЧ';
const TESTENKO = 'ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ';
const ADDR_A = 'Україна, 01001, місто Київ, ВУЛИЦЯ ХРЕЩАТИК, будинок 10, офіс 5';
const ADDR_A2 = 'Україна, 01001, ВУЛ. ХРЕЩАТИК, 10, ОФ. 7, М.КИЇВ';
const ADDR_OLD = 'Україна, 01001, місто Київ, ВУЛИЦЯ ЛЮТЕРАНСЬКА, будинок 3';

d('graph build + neighbourhood (real PostgreSQL)', () => {
  let pool: Pool;
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);

  async function company(edrpou: string, name: string, registered_on: string | null, first = S18, last = S21) {
    await q(`INSERT INTO edr_hist.company (edrpou, kind, name, name_latn, status, registered_on, first_seen, last_seen)
             VALUES ($1, 'uo', $2, $3, 'зареєстровано', $4, $5, $6)`, [edrpou, name, uaMatchKey(name) || null, registered_on, first, last]);
  }
  async function founder(edrpou: string, raw: string, f: { kind: string; name: string; code?: string; cc?: string }, first = S18, last = S21) {
    await q(`INSERT INTO edr_hist.founder (edrpou, entry_hash, raw, kind, name, name_latn, code, country_code, first_seen, last_seen)
             VALUES ($1, md5($2), $2, $3, $4, $5, $6, $7, $8, $9)`,
    [edrpou, raw, f.kind, f.name, uaMatchKey(f.name) || null, f.code || null, f.cc || null, first, last]);
  }
  async function head(edrpou: string, name: string, role_class: string, first = S18, last = S21) {
    await q(`INSERT INTO edr_hist.head (edrpou, entry_hash, raw, source, name, name_latn, role, role_class, first_seen, last_seen)
             VALUES ($1, md5($1 || $2 || $3), $2, 'signer', $2, $4, $3, $3, $5, $6)`, [edrpou, name, role_class, uaMatchKey(name), first, last]);
  }
  async function address(edrpou: string, raw: string, first: string, last: string | null) {
    await q(`INSERT INTO edr_hist.history (edrpou, field, value_hash, value, kind, first_snapshot, last_snapshot)
             VALUES ($1, 'address', md5($2), $2, 'uo', $3, $4)`, [edrpou, raw, first, last]);
  }
  async function current(record: string, edrpou: string, name: string, reg: string,
    entries: { founders?: string[]; signers?: string[]; benefs?: string[] }) {
    await q(`INSERT INTO legal_entities (record, edrpou, name, stan, registration, updated_at) VALUES ($1, $2, $3, 'зареєстровано', $4, $5)`,
      [record, edrpou, name, reg, `${CUR} 05:00:00`]);
    for (const f of entries.founders || []) await q(`INSERT INTO founders (entity_type, entity_record, founder_info) VALUES ('UO', $1, $2)`, [record, f]);
    for (const s of entries.signers || []) await q(`INSERT INTO signers (entity_type, entity_record, signer_info) VALUES ('UO', $1, $2)`, [record, s]);
    for (const b of entries.benefs || []) await q(`INSERT INTO beneficiaries (entity_type, entity_record, beneficiary_info) VALUES ('UO', $1, $2)`, [record, b]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 3 });
    for (const s of ['edr_hist', 'graph', 'graph_stage']) await q(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    for (const t of ['legal_entities', 'founders', 'signers', 'beneficiaries']) await q(`DROP TABLE IF EXISTS public.${t}`);
    await q(fs.readFileSync(path.join(MIG, '027_edr_history.sql'), 'utf8'));
    await q(fs.readFileSync(path.join(MIG, '030_graph_schema.sql'), 'utf8'));
    await q(fs.readFileSync(path.join(MIG, '031_graph_hubs_and_organisations.sql'), 'utf8'));
    // the columns of the current dump tables the builder reads
    await q(`CREATE TABLE legal_entities (id serial PRIMARY KEY, record varchar(50) UNIQUE NOT NULL, edrpou varchar(20), name text,
             short_name text, opf text, stan varchar(100), registration text, updated_at timestamp)`);
    for (const [t, c] of [['founders', 'founder_info'], ['signers', 'signer_info'], ['beneficiaries', 'beneficiary_info']]) {
      await q(`CREATE TABLE ${t} (id serial PRIMARY KEY, entity_type varchar(10) NOT NULL, entity_record varchar(50) NOT NULL, ${c} text NOT NULL)`);
    }
    await q(`INSERT INTO edr_hist.snapshot (kind, snapshot_date, source, subjects, fields) VALUES
      ('uo', '2016-07-25', 't', 0, '{address,head,name}'),
      ('uo', $1, 't', 0, '{address,beneficiary,founder,head,name}'),
      ('uo', $2, 't', 0, '{address,beneficiary,founder,head,name}')`, [S18, S21]);

    // A 11111110: founders a person (spelled two ways in 2018 / 2021), company B by code, a Cypriot
    // company, a placeholder; head Іваненко; a head who left before 2026; two addresses over time.
    await company('11111110', 'ТОВ "АЛЬФА"', '2010-01-01', '2016-07-25');
    await founder('11111110', `${IVANENKO}, країна громадянства: Україна, розмір внеску - 100 грн.`, { kind: 'person', name: IVANENKO }, S18, S18);
    await founder('11111110', `${IVANENKO}; громадянство: Україна; розмір частки - 100,00 грн.`, { kind: 'person', name: 'Іваненко Іван Іванович' }, S21, S21);
    await founder('11111110', 'ТОВ "БЕТА", 22222220, Україна', { kind: 'organisation', name: 'ТОВ "БЕТА"', code: '22222220', cc: 'UA' });
    await founder('11111110', 'СКАРАМАНДЕР ЛІМІТЕД, Кіпр', { kind: 'organisation', name: 'СКАРАМАНДЕР ЛІМІТЕД', code: 'HE123456', cc: 'CY' });
    await founder('11111110', 'АКЦІОНЕРИ ЗГІДНО РЕЄСТРУ', { kind: 'person', name: 'АКЦІОНЕРИ ЗГІДНО РЕЄСТРУ' });
    await founder('11111110', 'ФОНД УНІКАЛЬНИЙ ГАММА', { kind: 'organisation', name: 'ФОНД УНІКАЛЬНИЙ ГАММА', cc: 'UA' });
    await head('11111110', IVANENKO, 'head', '2016-07-25');
    await head('11111110', 'ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ', 'representative', S18, S21);
    await address('11111110', ADDR_OLD, '2016-07-25', S18);
    await address('11111110', ADDR_A, S21, null);
    // B 22222220 and C 22222233: same registration day, serials 2222222 / 2222223 -> reg_neighbour;
    // B at the same building as A (other spelling, other office); its head a namesake of A's founder
    await company('22222220', 'ТОВ "БЕТА"', '2015-05-05');
    await company('22222233', 'ТОВ "ДЕЛЬТА"', '2015-05-05');
    await company('33333330', 'ФОНД УНІКАЛЬНИЙ ГАММА', '2000-01-01');
    await head('22222220', 'Іваненко Іван Іванович', 'head');
    // organisations and placeholders as heads (LEXAI-2318, LEXAI-2319): A is managed by an
    // organisation known by name only; C by the fund (unique company name) and by B (code in the
    // text); B lists itself (dropped) and two placeholders (dropped)
    await head('11111110', 'ПРАТ ГАЄК', 'head');
    await head('22222233', 'ФОНД УНІКАЛЬНИЙ ГАММА', 'head');
    await head('22222233', 'ТОВ "БЕТА" (код 22222220)', 'head');
    await head('22222220', 'ТОВ "БЕТА", 22222220', 'head');
    await head('22222220', 'КЕРІВНИК ПІДПРИЄМСТВА', 'head');
    await head('22222220', 'НЕВИЗНАЧЕНА ОСОБА', 'representative');
    // LEXAI-2322: C's founder written with and without a (synthetic) РНОКПП, a beneficiary with one
    // in the name and in the influence text, a head with an ІПН; a "company" with a 10-digit code
    await founder('22222233', `${TESTENKO} (1234567890), розмір внеску - 100 грн.`, { kind: 'person', name: `${TESTENKO} (1234567890)` }, S18, S18);
    await founder('22222233', `${TESTENKO}, розмір внеску - 100 грн.`, { kind: 'person', name: TESTENKO }, S21, S21);
    await q(`INSERT INTO edr_hist.beneficiary (edrpou, entry_hash, raw, name, name_latn, country_code, influence, share, first_seen, last_seen)
             VALUES ('22222233', md5('b1'), 'b1', $1, $2, 'UA', $3, '50', $4, $5)`,
    [`${TESTENKO}, РНОКПП 1234567890`, uaMatchKey(`${TESTENKO}, РНОКПП 1234567890`), 'опосередкований; через ТОВ "БЕТА" (22222220), РНОКПП 1234567890', S18, S21]);
    await head('22222233', 'ТЕСТОВА ТЕСТА ТЕСТІВНА ІПН 2345678901', 'head');
    await company('1234567890', 'ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ', null);
    await head('1234567890', 'ТЕСТОВА ТЕСТА ТЕСТІВНА', 'head');
    // a curated mass registration address (the old one of A, degree 1)
    await q(`INSERT INTO graph.address_flag (address_key, flag, source) VALUES ($1, 'mass_registration', 'test')`,
      [addressKeyRow(ADDR_OLD, addressKeyVersion(null)).address_key]);
    await address('22222220', ADDR_A2, S18, null);
    // current dump (2026): A keeps Іваненко and Скарамандер, loses Петренко; new company E is founded by A
    await current('r1', '11111110', 'ТОВ "АЛЬФА"', '01.01.2010; 01.01.2010; 1', {
      founders: [`${IVANENKO}; громадянство: Україна; розмір частки - 100,00 грн.`,
        'СКАРАМАНДЕР ЛІМІТЕД, HE123456, Кіпр, Кіпр, Нікосія, розмір внеску до статутного фонду - 10,00 грн.'],
      signers: [`${IVANENKO}; 01.01.2010 - керівник`],
      benefs: [`${IVANENKO}; громадянство: Україна; Прямий вирішальний вплив; відсоток частки - 100`] });
    await current('r5', '55555550', 'ТОВ "ЕПСІЛОН"', '03.03.2024; 03.03.2024; 5', {
      founders: ['ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА", 11111110, Україна, розмір внеску до статутного фонду - 1000,00 грн.'] });
    await current('r2', '22222220', 'ТОВ "БЕТА"', '05.05.2015; 05.05.2015; 2', { signers: ['Іваненко Іван Іванович - керівник'] });
  });

  afterAll(async () => {
    await pool?.end();
  });

  const node = async (kind: string, key: string) => (await q('SELECT * FROM graph.node WHERE kind = $1 AND key = $2', [kind, key])).rows[0];
  const edgesOf = async (dstKey: string) => (await q(`
    SELECT e.kind, s.kind AS src_kind, s.key AS src_key, e.valid_from::text AS valid_from, e.valid_to::text AS valid_to, e.source, e.attrs, e.source_ref
    FROM graph.edge e JOIN graph.node s ON s.id = e.src JOIN graph.node d ON d.id = e.dst
    WHERE d.key = $1 ORDER BY e.kind, s.key`, [dstKey])).rows;

  it('the placeholder pattern reads the same in PostgreSQL', async () => {
    const r = await q(`SELECT x, x ~ $1 AS m FROM unnest($2::text[]) x`, [PLACEHOLDER_RE_SOURCE, ['акціонери згідно реєстру', 'членов петро', 'члени кооперативу', 'іваненко іван']]);
    expect(r.rows.map(x => x.m)).toEqual([true, false, true, false]);
  });

  it('placeholder and organisation rules read the same in PostgreSQL as in JS', async () => {
    const names = ['НЕВИЗНАЧЕНА ОСОБА', 'НЕВІДОМСЬКА ТЕСТА ТЕСТІВНА', 'КОНТРОЛЕР ЮРИДИЧНОЇ ОСОБИ', 'КОНТРОЛЕР ІВАНЕНКО ІВАН ІВАНОВИЧ',
      'КЕРІВНИК ПІДПРИЄМСТВА', 'ТЕРИТОРІАЛЬНА ГРОМАДА СЕЛА', 'ГРОМАДА ОЛЕНА', 'МІСЬКА ГРОМАДСЬКА ОРГАНІЗАЦІЯ "СВІТАНОК"', '100%',
      'УКРАЇНА', 'ФРАНКІВСЬКА ОБЛАСТЬ', 'ПРАТ ГАЄК', 'ТОВ"АЛЬФА"', 'ТОВ ТЕСТ ТЕСТОВИЧ', 'ТЕСТЕНКО ПП', 'БАНК ТЕСТ ТЕСТОВИЧ',
      'УПРАВЛЯЮЧА ФІРМА, 12345678', 'ПЕТРЕНКО 1234567890', 'EXAMPLE HOLDINGS LIMITED', 'ІВАНЕНКО ІВАН ІВАНОВИЧ'];
    const r = await q(`SELECT n ~ $2 OR (n ~ $3 AND n !~ $4) AS ph,
        n <> '' AND n !~ $4 AND (n ~ $5 OR coalesce(substring(x FROM $6), '0') !~ '^0+$') AS org
      FROM unnest($1::text[], $7::text[]) AS t(x, n)`,
    [names, PLACEHOLDER_RE_SOURCE, WEAK_PLACEHOLDER_RE_SOURCE, PATRONYMIC_RE_SOURCE, ORG_FORM_RE_SOURCE, CODE8_RE_SOURCE, names.map(normName)]);
    expect(r.rows.map((x, i) => [names[i], x.ph, x.org])).toEqual(names.map(n => [n, isPlaceholderName(n), isOrganisationName(n)]));
  });

  it('dry run only counts', async () => {
    const r = await buildGraph(pool, { dryRun: true, log: () => undefined });
    expect(r.dryRun).toBe(true);
    expect(r.counts.hist_companies).toBe(5);
    expect(r.counts.current_founder_rows).toBe(3);
    expect((await q(`SELECT to_regnamespace('graph_stage') AS s`)).rows[0].s).toBeNull();
  });

  it('builds nodes and dated edges from history + current dump', async () => {
    const r = await buildGraph(pool, { log: () => undefined, hubThresholds: { address: 1 } });
    expect(r.sources.useCurrent).toBe(true);
    expect(r.sources.currentDate).toBe(CUR);
    const ivan = personKey(IVANENKO)!;
    const a = await edgesOf('11111110');
    const byKey = (kind: string, key: string) => a.filter(e => e.kind === kind && e.src_key === key);
    // the two spellings and the current entry are one founder edge, open start, still current
    const fi = byKey('founder', ivan);
    expect(fi).toHaveLength(1);
    expect(fi[0]).toMatchObject({ valid_from: null, valid_to: null, source: 'edr_hist' });
    expect(fi[0].source_ref.hist.first_seen).toBe(S18);
    expect(fi[0].source_ref.current.dump).toBe(CUR);
    expect(byKey('founder', '22222220')[0]).toMatchObject({ src_kind: 'company', valid_to: S21 });
    expect(byKey('founder', 'CY|name:skaramander')[0]).toMatchObject({ src_kind: 'foreign_entity', valid_to: null });
    expect(byKey('founder', '33333330')[0].attrs.resolved_by).toBe('unique_name');
    expect(a.some(e => /akts/.test(e.src_key))).toBe(false); // placeholder dropped
    // head since 2016 (the first head snapshot), appointed 2010 by the current entry -> exact start
    expect(byKey('head', ivan)[0]).toMatchObject({ valid_from: '2010-01-01', valid_to: null });
    // signer gone from the current dump: closes at the last snapshot that showed him
    expect(byKey('signer', personKey('ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ')!)[0]).toMatchObject({ valid_to: S21, valid_from: S18 });
    // beneficiary only in the current dump
    expect(byKey('beneficiary', ivan)[0]).toMatchObject({ source: 'edr_current', valid_from: CUR, valid_to: null });
    // company -> address: the old address closed, the current one open with confirmed_until
    const addr = (await q(`SELECT d.key, e.valid_from::text vf, e.valid_to::text vt, e.attrs FROM graph.edge e
      JOIN graph.node s ON s.id = e.src JOIN graph.node d ON d.id = e.dst WHERE e.kind = 'registered_at' AND s.key = '11111110' ORDER BY e.valid_to NULLS LAST`)).rows;
    expect(addr).toHaveLength(2);
    expect(addr[0]).toMatchObject({ vf: null, vt: S18 });
    expect(addr[1]).toMatchObject({ vf: S21, vt: null });
    expect(addr[1].attrs.confirmed_until).toBe(S21);
    // B shares A's building (other spelling, other office) -> one address node of degree 2, a hub at threshold 1
    const shared = await node('address', addr[1].key);
    expect(shared.degree).toBe(2);
    expect(shared.hub).toBe(true);
    // B's head is the same candidate person node as A's founder
    const p = await node('person_name', ivan);
    expect(p.degree).toBeGreaterThanOrEqual(4);
    // reg_neighbour B -> C
    const rn = (await q(`SELECT s.key s, d.key d, e.attrs FROM graph.edge e JOIN graph.node s ON s.id = e.src JOIN graph.node d ON d.id = e.dst WHERE e.kind = 'reg_neighbour'`)).rows;
    expect(rn).toEqual([{ s: '22222220', d: '22222233', attrs: { gap: 1, day_registrations: 2 } }]);
    // current-only company E founded by A
    expect((await edgesOf('55555550'))[0]).toMatchObject({ kind: 'founder', src_key: '11111110', source: 'edr_current', valid_from: CUR });
    // no tax / document numbers on person nodes, the swap left no staging schema
    expect((await q(`SELECT count(*)::int n FROM graph.node WHERE kind = 'person_name' AND attrs ? 'codes'`)).rows[0].n).toBe(0);
    expect((await q(`SELECT to_regnamespace('graph_stage') AS s`)).rows[0].s).toBeNull();
    expect((await q('SELECT count(*)::int n FROM graph.build')).rows[0].n).toBe(1);
  });

  it('organisations as heads and placeholder heads (LEXAI-2318)', async () => {
    const hai = organisationKey('ПРАТ ГАЄК')!;
    expect(await node('organisation', hai)).toMatchObject({ label: 'ПРАТ ГАЄК', degree: 1 });
    expect(await node('person_name', personKey('ПРАТ ГАЄК') || '-')).toBeUndefined();
    const a = await edgesOf('11111110');
    expect(a.filter(e => e.src_kind === 'organisation')).toMatchObject([{ kind: 'head', src_key: hai }]);
    const c = await edgesOf('22222233');
    expect(c.filter(e => e.kind === 'head' && e.src_kind !== 'person_name').map(e => [e.src_kind, e.src_key, e.attrs.resolved_by]).sort())
      .toEqual([['company', '22222220', 'code'], ['company', '33333330', 'unique_name']]);
    // no self edge, no placeholder heads
    const b = await edgesOf('22222220');
    expect(b.some(e => e.src_key === '22222220')).toBe(false);
    expect(b.filter(e => e.kind === 'head' || e.kind === 'signer').map(e => e.src_kind)).toEqual(['person_name']);
    const build = (await q('SELECT counts, hub_thresholds FROM graph.build ORDER BY id DESC LIMIT 1')).rows[0];
    expect(build.counts).toMatchObject({ head_relations_to_organisation: 1, head_relations_to_company_code: 1, head_relations_to_company_unique_name: 1 });
  });

  it('personal numbers are stripped from labels, keys and edge attrs; ЄДРПОУ codes stay (LEXAI-2322)', async () => {
    const t = personKey(TESTENKO)!;
    expect(t).not.toMatch(/[0-9]/);
    // the entries with and without the number are one node and one founder edge
    expect(await node('person_name', t)).toMatchObject({ label: TESTENKO });
    const c = await edgesOf('22222233');
    expect(c.filter(e => e.kind === 'founder').map(e => e.src_key)).toEqual([t]);
    const ben = c.filter(e => e.kind === 'beneficiary');
    expect(ben.map(e => e.src_key)).toEqual([t]);
    expect(ben[0].attrs.influence).toBe('опосередкований; через ТОВ "БЕТА" (22222220)');
    const tk = personKey('ТЕСТОВА ТЕСТА ТЕСТІВНА')!;
    expect(c.filter(e => e.kind === 'head' && e.src_kind === 'person_name').map(e => e.src_key)).toEqual([tk]);
    // the company found by the 8-digit code in a head entry is still linked
    expect(c.some(e => e.kind === 'head' && e.src_key === '22222220')).toBe(true);
    // a 10-digit "company" code is an individual's number: no node, no edges
    expect(await node('company', '1234567890')).toBeUndefined();
    expect((await q(`SELECT count(*)::int n FROM graph.node WHERE label ~ '[0-9]{10}' OR key ~ '[0-9]{10}'`)).rows[0].n).toBe(0);
    const build = (await q('SELECT counts FROM graph.build ORDER BY id DESC LIMIT 1')).rows[0];
    expect(build.counts).toMatchObject({ person_key_version: 'p2', id_numbers_nodes: 0, id_numbers_edges: 0, names_with_ids: 3, texts_with_ids: 1 });
    // the check fails loudly on a leaked number (foreign entity codes and amounts are exempt)
    await expect(checkPersonalIds(pool, 'graph')).resolves.toEqual({ id_numbers_nodes: 0, id_numbers_edges: 0 });
    await q(`INSERT INTO graph.node (kind, key, label) VALUES ('foreign_entity', 'RU|code:1234567890', 'ТОВ АЛЬФА')`);
    await q(`INSERT INTO graph.node (kind, key, label) VALUES ('person_name', 'leak test', 'ТЕСТ 1234567890')`);
    await expect(checkPersonalIds(pool, 'graph')).rejects.toThrow(/1 nodes \(person_name 1\)/);
    await q(`DELETE FROM graph.node WHERE key IN ('RU|code:1234567890', 'leak test')`);
  });

  it('computed hub thresholds and the curated mass registration address (LEXAI-2319)', async () => {
    const build = (await q('SELECT hub_thresholds FROM graph.build ORDER BY id DESC LIMIT 1')).rows[0].hub_thresholds;
    // address overridden to 1 in this build, the rest at the floors of a tiny graph
    expect(build.thresholds).toEqual({ address: 1, company: 100, person_name: 30, foreign_entity: 30, organisation: 30 });
    expect(build.basis).toMatchObject({ address: 'override', company: 'floor', mass_registration: 'floor' });
    expect(build.massRegistrationMinDegree).toBe(500);
    expect(build.observed.address['0.9999']).toBe(2);
    const old = await node('address', addressKeyRow(ADDR_OLD, addressKeyVersion(null)).address_key!);
    expect(old).toMatchObject({ degree: 1, hub: true });
    expect(old.attrs).toMatchObject({ flag: 'mass_registration', mass_registration: 'list' });
    expect((await q(`SELECT count(*)::int n FROM graph.node WHERE kind = 'address' AND attrs ? 'mass_registration'`)).rows[0].n).toBe(1);
  });

  it('neighbourhood: depth, hub stop, asOf and kinds', async () => {
    const r1 = await neighbourhood(pool, '11111110', { depth: 1 });
    const keys = (r: any) => r.nodes.map((n: any) => n.key).sort();
    expect(keys(r1)).toEqual(expect.arrayContaining(['22222220', '33333330', '55555550', 'CY|name:skaramander', personKey(IVANENKO)]));
    // depth 2 via the shared address would reach B anyway; C only through B's reg_neighbour at depth 3
    const r3 = await neighbourhood(pool, '11111110', { depth: 3 });
    expect(keys(r3)).toContain('22222233');
    // the shared address is a hub (threshold 1): reached, not expanded
    expect(r3.truncated.hubs.length).toBeGreaterThan(0);
    // as of 2020: E (2026) and the current-only beneficiary edge are out; Петренко is in
    const r20 = await neighbourhood(pool, '11111110', { depth: 1, asOf: '2020-01-01' });
    expect(keys(r20)).not.toContain('55555550');
    expect(keys(r20)).toContain(personKey('ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ'));
    expect(r20.edges.some(e => e.kind === 'beneficiary')).toBe(false);
    const rk = await neighbourhood(pool, '11111110', { depth: 1, kinds: ['registered_at'] });
    expect(rk.nodes.filter(n => n.kind !== 'address').map(n => n.key)).toEqual(['11111110']);
    const rp = await neighbourhood(pool, `person:${IVANENKO}`, { depth: 1 });
    expect(keys(rp)).toEqual(expect.arrayContaining(['11111110', '22222220']));
    expect((await neighbourhood(pool, '99999990')).start).toBeNull();
  });

  it('a rebuild swaps in place and reuses the address keys', async () => {
    const before = (await q('SELECT count(*)::int n FROM graph.address_key')).rows[0].n;
    const r = await buildGraph(pool, { log: () => undefined, limit: 2, fromEdrpou: '11111110' });
    expect(r.counts.scope_companies).toBe(2);
    expect(r.counts.addresses_keyed).toBe(0);
    expect((await q('SELECT count(*)::int n FROM graph.address_key')).rows[0].n).toBe(before);
    expect((await q('SELECT count(*)::int n FROM graph.build')).rows[0].n).toBe(2);
    expect((await q(`SELECT count(*)::int n FROM graph.node WHERE kind = 'company' AND key = '33333330' AND degree = 0`)).rows[0].n).toBe(0);
  });
});
