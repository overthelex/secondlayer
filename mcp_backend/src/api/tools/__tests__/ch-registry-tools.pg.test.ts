/**
 * Integration tests for ChRegistryTools against a real PostgreSQL.
 *
 * A mocked db.query cannot validate SQL, and this handler leans on Postgres-side
 * expressions that only fail at the server: the word-bounded `~*` short-query match,
 * the LATERAL SHAB aggregate, and — above all — the normalised-name join used to line
 * Zefix companies up with FINMA / SECO / Kantonsblatt rows. That normalisation is
 * written twice (once in TS, once as a SQL expression) and the two have to agree
 * character for character; only a real server proves they do.
 *
 * Set CH_TEST_DATABASE_URL to run; skipped otherwise.
 *
 *   CH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/ch_tools_test npx jest ch-registry-tools.pg
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ChRegistryTools } from '../ch-registry-tools';

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const DSN = process.env.CH_TEST_DATABASE_URL;
const describeIfPg = DSN ? describe : describe.skip;

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function text(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

// This suite applies migrations and TRUNCATEs tables against whatever CH_TEST_DATABASE_URL
// points to. Refuse to run against anything that isn't obviously a disposable test database.
if (DSN) {
  const dbName = new URL(DSN).pathname.split('/').pop() || '';
  if (!dbName.includes('test')) {
    throw new Error('CH_TEST_DATABASE_URL must point to a database whose name contains "test"');
  }
}

describeIfPg('ChRegistryTools (real PostgreSQL)', () => {
  let client: Client;
  let tools: ChRegistryTools;

  const UID_AG = 'CHE-123.456.789';
  const UID_INACTIVE = 'CHE-987.654.321';
  const UID_GE = 'CHE-111.222.333';
  // Its name carries the letters 'ag' inside a word ("Ragusa") but never as a word —
  // the discriminator between a word-bounded short-query match and a bare substring one.
  const UID_SUBSTRING = 'CHE-444.555.666';
  const UID_UNKNOWN = 'CHE-555.555.555';

  // 2,400 characters — over the 2,000-char content cap of ch_get_company.
  const LONG_CONTENT = 'Eintragung der Gesellschaft. '.repeat(83).slice(0, 2400);
  // 480 characters — over the 300-char purpose preview of ch_search_companies.
  const LONG_PURPOSE = ('Handel mit Waren aller Art sowie Beratung. '.repeat(12)).slice(0, 480);

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();

    const migrations = join(__dirname, '../../../migrations');
    for (const file of [
      '129_offshore_jurisdictions_data.sql',
      '132_ch_seco_sanctions.sql',
      '133_ch_kantonsblatt.sql',
      '201_ch_registries.sql',
    ]) {
      await client.query(readFileSync(join(migrations, file), 'utf-8'));
    }

    tools = new ChRegistryTools({
      query: (sql: string, params?: any[]) => client.query(sql, params),
    } as any);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await client.query(
      'TRUNCATE ch_zefix_companies, ch_shab_publications, ch_finma_regulated, ch_seco_sanctions, ch_kantonsblatt_publications'
    );

    await client.query(
      `INSERT INTO ch_zefix_companies
         (uid, name, legal_form, legal_form_code, legal_seat, register_office, status,
          purpose, capital, capital_currency, address, canton, chid, ehraid, shab_pub_date)
       VALUES
         ($1, 'Muster Handels AG', 'Aktiengesellschaft', '0106', 'Zürich', 'Handelsregister ZH',
          'active', $2, 100000, 'CHF', 'Bahnhofstrasse 1, 8001 Zürich', 'ZH', 'CH-020.3.000.001-1', 1234567,
          '2024-01-15'),
         ($3, 'Alte Muster GmbH', 'Gesellschaft mit beschränkter Haftung', '0107', 'Genève',
          'Registre du commerce GE', 'inactive', 'Erloschene Gesellschaft.', 20000, 'CHF',
          'Rue du Rhône 5, 1204 Genève', 'GE', 'CH-660.1.000.002-2', 2234567, '2015-03-03'),
         ($4, 'Genève Services SA', 'Société anonyme', '0106', 'Genève', 'Registre du commerce GE',
          'active', 'Prestations de services.', 250000, 'CHF', 'Rue de Berne 9, 1201 Genève', 'GE',
          'CH-660.1.000.003-3', 3234567, '2022-09-09'),
         ($5, 'Ragusa Trading GmbH', 'Gesellschaft mit beschränkter Haftung', '0107', 'Zürich',
          'Handelsregister ZH', 'active', 'Handel mit Lebensmitteln.', 20000, 'CHF',
          'Seestrasse 3, 8002 Zürich', 'ZH', 'CH-020.4.000.004-4', 4234567, '2023-11-11')`,
      [UID_AG, LONG_PURPOSE, UID_INACTIVE, UID_GE, UID_SUBSTRING]
    );

    await client.query(
      `INSERT INTO ch_shab_publications
         (shab_id, publication_date, publication_type, rubric, sub_rubric, company_uid,
          company_name, canton, content, language, publication_number, title,
          registration_office, legal_form, seat, detail_fetched_at)
       VALUES
         ('SHAB-HR01', '2024-01-15', 'Neueintragung', 'HR', 'HR01', $1, 'Muster Handels AG', 'ZH',
          $2, 'de', '1000001', 'Muster Handels AG', 'Handelsregister ZH', 'Aktiengesellschaft',
          'Zürich', now()),
         ('SHAB-HR02', '2024-06-01', 'Mutation', 'HR', 'HR02', $1, 'Muster Handels AG', 'ZH',
          'Mutation der Organe.', 'de', '1000002', 'Muster Handels AG', 'Handelsregister ZH',
          'Aktiengesellschaft', 'Zürich', now()),
         ('SHAB-KK01', '2025-02-02', 'Konkurseröffnung', 'KK', 'KK01', $1, 'Muster Handels AG', 'ZH',
          'Konkurseroeffnung ueber die Gesellschaft.', 'de', '1000003', 'Konkurs Muster Handels AG',
          'Konkursamt ZH', 'Aktiengesellschaft', 'Zürich', now()),
         ('SHAB-HR03', '2019-05-05', 'Neueintragung', 'HR', 'HR01', NULL,
          'Verschwundene Treuhand AG', 'BE', 'Eintragung einer Treuhandgesellschaft.', 'de',
          '1000004', 'Verschwundene Treuhand AG', 'Handelsregister BE', 'Aktiengesellschaft',
          'Bern', now()),
         ('SHAB-HR04', '2020-07-07', 'Mutation', 'HR', 'HR02', NULL,
          'Verschwundene Treuhand AG', 'BE', 'Mutation der Treuhandgesellschaft.', 'de',
          '1000005', 'Verschwundene Treuhand AG', 'Handelsregister BE', 'Aktiengesellschaft',
          'Bern', now()),
         -- A second SHAB-only name that also matches 'Muster'. Zefix has exactly one
         -- active 'Muster' company, so a fallback that fired on an exhausted page would
         -- hand back this row instead of an empty page.
         ('SHAB-HR05', '2018-01-01', 'Loeschung', 'HR', 'HR03', NULL,
          'Muster Alt AG', 'ZH', 'Loeschung der Gesellschaft.', 'de',
          '1000006', 'Muster Alt AG', 'Handelsregister ZH', 'Aktiengesellschaft',
          'Zürich', now())`,
      [UID_AG, LONG_CONTENT]
    );

    // What shab-detail writes into metadata_json: ch_shab_publications has no capital
    // column, so the amounts the register states live in the jsonb.
    await client.query(
      `UPDATE ch_shab_publications
          SET metadata_json = '{"capital": "100000.00", "capital_currency": "CHF"}'::jsonb
        WHERE shab_id = 'SHAB-HR01'`
    );

    // Two renderings of the same company (exact, and upper-cased with a comma before the
    // legal-form suffix) plus one unrelated bank that must never match.
    await client.query(
      `INSERT INTO ch_finma_regulated
         (entity_name, authorization_type, authorization_number, status, city, canton, country, effective_date)
       VALUES
         ('Muster Handels AG', 'Vermögensverwalter', 'FINMA-001', 'aktiv', 'Zürich', 'ZH', 'CH', '2020-01-01'),
         ('MUSTER HANDELS, AG', 'Versicherungsvermittler', 'FINMA-002', 'aktiv', 'Zürich', 'ZH', 'CH', '2021-01-01'),
         ('Andere Bank AG', 'Bank', 'FINMA-003', 'aktiv', 'Basel', 'BS', 'CH', '2019-01-01')`
    );

    await client.query(
      `INSERT INTO ch_seco_sanctions
         (ssid, sanctions_set_id, target_type, primary_name, programme, origin, legal_basis, listed_at)
       VALUES
         (900001, 1, 'entity', 'Muster Handels AG', 'Ukraine', 'CH', 'SR 946.231.176.72', '2022-03-04'),
         (900002, 1, 'entity', 'Genève Services SA', 'Syrien', 'CH', 'SR 946.231.172.7', '2021-06-06')`
    );

    await client.query(
      `INSERT INTO ch_kantonsblatt_publications
         (publication_uuid, publication_number, publication_date, sub_rubric, cantons, title,
          publication_text_de, company_uid)
       VALUES
         ('11111111-1111-1111-1111-111111111111', 'KB-1', '2024-02-20', 'HR01', ARRAY['ZH'],
          'Muster Handels AG', 'Kantonale Publikation zur Gesellschaft.', $1),
         ('22222222-2222-2222-2222-222222222222', 'KB-2', '2024-03-20', 'HR02', ARRAY['ZH'],
          'MUSTER HANDELS, AG', 'Kantonale Publikation ohne UID.', NULL),
         ('33333333-3333-3333-3333-333333333333', 'KB-3', '2024-04-20', 'HR01', ARRAY['GE'],
          'Genève Services SA', 'Publication cantonale sans rapport.', $2)`,
      [UID_AG, UID_GE]
    );
  });

  // ─── ch_search_companies ────────────────────────────────────────────

  describe('ch_search_companies', () => {
    it('finds an active company by a name fragment and reports its SHAB aggregates', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'Muster Handels' }))!);

      expect(body.results).toHaveLength(1);
      const row = body.results[0];
      expect(row.uid).toBe(UID_AG);
      expect(row.name).toBe('Muster Handels AG');
      expect(row.legal_form).toBe('Aktiengesellschaft');
      expect(row.legal_seat).toBe('Zürich');
      expect(row.canton).toBe('ZH');
      expect(row.status).toBe('active');
      expect(row.source).toBe('zefix');
      expect(row.shab_count).toBe(3);
      expect(row.last_shab_date).toBe('2025-02-02');
      expect(row.bankruptcy).toBe(true);
      // Never written by any stage — see the company-card test.
      expect(row).not.toHaveProperty('capital');
      expect(row).not.toHaveProperty('register_office');
      expect(row).not.toHaveProperty('shab_pub_date');
    });

    it('truncates purpose to 300 characters', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'Muster Handels' }))!);
      expect(body.results[0].purpose).toHaveLength(300);
      expect(LONG_PURPOSE.length).toBeGreaterThan(300);
    });

    it('defaults to active companies only, hiding the inactive namesake', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'Muster' }))!);
      expect(body.results.map((r: any) => r.uid)).toEqual([UID_AG]);
    });

    it("status: 'all' returns both the active and the inactive namesake", async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'Muster', status: 'all' }))!);
      expect(body.results.map((r: any) => r.uid).sort()).toEqual([UID_INACTIVE, UID_AG].sort());
    });

    it("status: 'inactive' returns only the inactive company", async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'Muster', status: 'inactive' }))!);
      expect(body.results.map((r: any) => r.uid)).toEqual([UID_INACTIVE]);
      expect(body.results[0].shab_count).toBe(0);
      expect(body.results[0].last_shab_date).toBeNull();
      expect(body.results[0].bankruptcy).toBe(false);
    });

    it('finds a company by its dotted UID', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: UID_AG }))!);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].uid).toBe(UID_AG);
      expect(body.query_kind).toBe('uid');
    });

    it('finds the same company by its undotted UID', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'CHE123456789' }))!);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].uid).toBe(UID_AG);
      expect(body.normalized_uid).toBe(UID_AG);
    });

    it('a UID lookup is not constrained by the default active filter', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: UID_INACTIVE }))!);
      expect(body.results.map((r: any) => r.uid)).toEqual([UID_INACTIVE]);
    });

    it('filters by canton', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', {
        query: 'Muster', canton: 'GE', status: 'all',
      }))!);
      expect(body.results.map((r: any) => r.uid)).toEqual([UID_INACTIVE]);
    });

    it('filters by legal_form', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', {
        query: 'Muster', legal_form: 'Aktiengesellschaft', status: 'all',
      }))!);
      expect(body.results.map((r: any) => r.uid)).toEqual([UID_AG]);
    });

    it('filters by legal_form as a case-insensitive prefix of the stored label', async () => {
      // The labels are read from the LINDAS graph and some are composite: the eCH-0097
      // 0107 label is stored as 'Gesellschaft mit beschränkter Haftung GMBH / SARL'. An
      // equality filter on the German name a caller would actually type matched nothing.
      await client.query(
        `INSERT INTO ch_zefix_companies (uid, name, legal_form, legal_form_code, legal_seat, status, canton)
         VALUES ('CHE-777.888.999', 'Komposit Handels GmbH',
                 'Gesellschaft mit beschränkter Haftung GMBH / SARL', '0107', 'Zug', 'active', 'ZG')`
      );

      const exact = parse((await tools.executeTool('ch_search_companies', {
        query: 'Komposit', legal_form: 'Gesellschaft mit beschränkter Haftung',
      }))!);
      expect(exact.results.map((r: any) => r.uid)).toEqual(['CHE-777.888.999']);

      const lower = parse((await tools.executeTool('ch_search_companies', {
        query: 'Komposit', legal_form: 'gesellschaft mit beschränkter haftung',
      }))!);
      expect(lower.results.map((r: any) => r.uid)).toEqual(['CHE-777.888.999']);
    });

    it('treats % and _ in legal_form as literal characters', async () => {
      // The filter is an ILIKE, so a caller-supplied wildcard must not turn into one.
      const body = parse((await tools.executeTool('ch_search_companies', {
        query: 'Muster', status: 'all', legal_form: 'Aktien%',
      }))!);
      expect(body.results).toEqual([]);

      const underscore = parse((await tools.executeTool('ch_search_companies', {
        query: 'Muster', status: 'all', legal_form: 'Aktiengesellschaf_',
      }))!);
      expect(underscore.results).toEqual([]);
    });

    it('filters the SHAB fallback by legal_form the same way', async () => {
      await client.query(
        `INSERT INTO ch_shab_publications
           (shab_id, publication_date, rubric, sub_rubric, company_name, canton, language, legal_form)
         VALUES ('SHAB-HR08', '2021-05-05', 'HR', 'HR02', 'Ausgeloeschte GmbH', 'ZG', 'de',
                 'Gesellschaft mit beschränkter Haftung GMBH / SARL')`
      );

      const body = parse((await tools.executeTool('ch_search_companies', {
        query: 'Ausgeloeschte', legal_form: 'Gesellschaft mit beschränkter Haftung',
      }))!);
      expect(body.results.map((r: any) => r.name)).toEqual(['Ausgeloeschte GmbH']);
      expect(body.results[0].source).toBe('shab');
    });

    it('matches a short query on a word boundary, not as a bare substring', async () => {
      // 'AG' is a word of "Muster Handels AG" but only a substring inside "Ragusa Trading
      // GmbH"; the word-bounded match must return the AG and nothing else.
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'AG', status: 'all' }))!);
      expect(body.results.map((r: any) => r.uid)).toEqual([UID_AG]);
    });

    it('falls back to SHAB company names when Zefix has no hit', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'Verschwundene' }))!);


      expect(body.results).toHaveLength(1);
      const row = body.results[0];
      expect(row.source).toBe('shab');
      expect(row.name).toBe('Verschwundene Treuhand AG');
      expect(row.uid).toBeNull();
      expect(row.canton).toBe('BE');
      // Both SHAB rows collapse into one company, newest publication wins.
      expect(row.shab_count).toBe(2);
      expect(row.last_shab_date).toBe('2020-07-07');
      expect(row.bankruptcy).toBe(false);
      expect(body.total_count).toBe(1);
    });

    it('does not fall back to SHAB for a query too short to be indexable', async () => {
      // The fallback matches company_name across 2.5M publications and has no index
      // unless pg_trgm is installed, so a one- or two-character query is refused rather
      // than served with a sequential scan.
      await client.query(
        `INSERT INTO ch_shab_publications
           (shab_id, publication_date, rubric, sub_rubric, company_name, canton, language)
         VALUES ('SHAB-HR06', '2021-03-03', 'HR', 'HR02', 'XY Trading AG', 'ZG', 'de'),
                ('SHAB-HR07', '2021-04-04', 'HR', 'HR02', 'XYZ Trading AG', 'ZG', 'de')`
      );

      const short = parse((await tools.executeTool('ch_search_companies', { query: 'XY' }))!);
      expect(short.results).toEqual([]);

      const long = parse((await tools.executeTool('ch_search_companies', { query: 'XYZ' }))!);
      expect(long.results.map((r: any) => r.name)).toEqual(['XYZ Trading AG']);
      expect(long.results[0].source).toBe('shab');
    });

    it('does not fall back to SHAB when Zefix already matched', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'Muster', status: 'all' }))!);
      expect(body.results.every((r: any) => r.source === 'zefix')).toBe(true);
    });

    it('returns an empty result rather than a SHAB fallback when paginating past the Zefix matches', async () => {
      // Zefix has exactly one active 'Muster' company, so offset 1 is past the end. SHAB
      // has two distinct 'Muster' names, so a fallback firing here would return a row —
      // silently switching register mid-pagination.
      const first = parse((await tools.executeTool('ch_search_companies', { query: 'Muster' }))!);
      expect(first.results).toHaveLength(1);

      const body = parse((await tools.executeTool('ch_search_companies', {
        query: 'Muster', offset: 1,
      }))!);
      expect(body.results).toEqual([]);
    });

    it('keeps the real total on a page past the last row', async () => {
      // The total came off the rows, so an empty page reported total_count 0 — a caller
      // who had paged one step too far was told the search had matched nothing at all,
      // which is the opposite of what this branch knows.
      const body = parse((await tools.executeTool('ch_search_companies', {
        query: 'Muster', status: 'all', offset: 50,
      }))!);

      expect(body.results).toEqual([]);
      expect(body.total_count).toBe(2);
      expect(body.has_more).toBe(false);
    });

    it('returns nothing at all for a query no register matches', async () => {
      const body = parse((await tools.executeTool('ch_search_companies', { query: 'Nichtvorhanden' }))!);
      expect(body.results).toEqual([]);
      expect(body.total_count).toBe(0);
    });

    it('asks for a query in Ukrainian when it is missing', async () => {
      const result = (await tools.executeTool('ch_search_companies', {}))!;
      expect(text(result)).toContain('query');
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
      expect(result.isError).toBeFalsy();
    });

    it('rejects an unknown status in Ukrainian', async () => {
      const result = (await tools.executeTool('ch_search_companies', { query: 'Muster', status: 'zombie' }))!;
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
      expect(text(result)).toContain('status');
    });

    it('paginates with limit and offset over a shared name fragment', async () => {
      const page1 = parse((await tools.executeTool('ch_search_companies', {
        query: 'Muster', status: 'all', limit: 1, offset: 0,
      }))!);
      const page2 = parse((await tools.executeTool('ch_search_companies', {
        query: 'Muster', status: 'all', limit: 1, offset: 1,
      }))!);

      expect(page1.results).toHaveLength(1);
      expect(page2.results).toHaveLength(1);
      expect(page1.total_count).toBe(2);
      expect(page1.has_more).toBe(true);
      expect(page2.has_more).toBe(false);
      expect(page1.results[0].uid).not.toBe(page2.results[0].uid);
    });

    it('carries the SHAB aggregates on a later page, not only on the first', async () => {
      // The aggregates come from a LATERAL that must run over the page, not
      // over every WHERE match: `count(*) OVER()` in the same SELECT blocked
      // the LIMIT from being pushed under the join and made the lateral run
      // 792K times for a one-letter query (6.9 s, measured).
      const page2 = parse((await tools.executeTool('ch_search_companies', {
        query: 'Muster', status: 'all', limit: 1, offset: 1,
      }))!);

      expect(page2.results).toHaveLength(1);
      expect(page2.results[0].uid).toBe(UID_AG);
      expect(page2.results[0].shab_count).toBe(3);
      expect(page2.results[0].last_shab_date).toBe('2025-02-02');
      expect(page2.results[0].bankruptcy).toBe(true);
      expect(page2.total_count).toBe(2);
      expect(page2.has_more).toBe(false);
    });

    it('sorts an exact name match first even when the query needs escaping', async () => {
      // The boost compares the company name against the caller's query, so it
      // has to be bound as its own parameter: $1 is the regex-escaped token
      // for a short query ('B\.C') and the UID for a UID lookup, and against
      // either of those `lower(name) = $1` is never true.
      await client.query(
        `INSERT INTO ch_zefix_companies (uid, name, legal_form, legal_seat, status, canton)
         VALUES ('CHE-222.333.444', 'B.C', 'Aktiengesellschaft', 'Zug', 'active', 'ZG'),
                ('CHE-333.444.555', 'A B.C Holding', 'Aktiengesellschaft', 'Zug', 'active', 'ZG')`
      );

      const body = parse((await tools.executeTool('ch_search_companies', { query: 'B.C' }))!);

      // Alphabetically 'A B.C Holding' comes first; the exact match must not.
      expect(body.results.map((r: any) => r.name)).toEqual(['B.C', 'A B.C Holding']);
    });
  });

  // ─── ch_get_company ─────────────────────────────────────────────────

  describe('ch_get_company', () => {
    it('returns the company card with every register section', async () => {
      const body = parse((await tools.executeTool('ch_get_company', { uid: UID_AG }))!);

      expect(body.error).toBeUndefined();
      expect(body.company.uid).toBe(UID_AG);
      expect(body.company.name).toBe('Muster Handels AG');
      expect(body.company.legal_form).toBe('Aktiengesellschaft');
      expect(body.company.legal_seat).toBe('Zürich');
      expect(body.company.canton).toBe('ZH');
      expect(body.company.status).toBe('active');
      // capital / capital_currency / register_office / shab_pub_date exist in migration
      // 129's table but no stage writes them, so the card does not pretend to have them.
      expect(body.company).not.toHaveProperty('capital');
      expect(body.company).not.toHaveProperty('capital_currency');
      expect(body.company).not.toHaveProperty('register_office');
      expect(body.company).not.toHaveProperty('shab_pub_date');

      // SHAB: all three rows, newest first.
      expect(body.shab.map((p: any) => p.shab_id)).toEqual(['SHAB-KK01', 'SHAB-HR02', 'SHAB-HR01']);
      expect(body.shab[0].rubric).toBe('KK');
      expect(body.shab[2].publication_date).toBe('2024-01-15');

      // Bankruptcies: only the KK row.
      expect(body.bankruptcies.map((p: any) => p.shab_id)).toEqual(['SHAB-KK01']);

      // FINMA: both renderings of the name, never the unrelated bank.
      expect(body.finma.map((r: any) => r.authorization_number).sort()).toEqual(['FINMA-001', 'FINMA-002']);
      expect(body.finma.some((r: any) => r.entity_name === 'Andere Bank AG')).toBe(false);
      expect(body.finma[0].authorization_type).toBeTruthy();

      // SECO: only the matching programme entry.
      expect(body.seco.map((r: any) => Number(r.ssid))).toEqual([900001]);
      expect(body.seco[0].programme).toBe('Ukraine');

      // Kantonsblatt: the UID is a key and the title is a heuristic, so a company the
      // cantonal office published a UID for is answered from the UID alone — KB-2, which
      // only matches on the normalised title, is not mixed into an exact answer.
      expect(body.kantonsblatt.map((r: any) => r.publication_number)).toEqual(['KB-1']);

      expect(body.normalized_name).toBe('muster handels');
      expect(body.name_match_note).toMatch(/[Ѐ-ӿ]/);
    });

    it('truncates SHAB content to 2000 characters and flags it', async () => {
      const body = parse((await tools.executeTool('ch_get_company', { uid: UID_AG }))!);
      const first = body.shab.find((p: any) => p.shab_id === 'SHAB-HR01');

      expect(LONG_CONTENT.length).toBeGreaterThan(2000);
      expect(first.content).toHaveLength(2000);
      expect(first.content_truncated).toBe(true);

      const short = body.shab.find((p: any) => p.shab_id === 'SHAB-HR02');
      expect(short.content_truncated).toBe(false);
    });

    it('surfaces the capital SHAB states on the publication that states it', async () => {
      // The only reachable capital in the corpus: shab-detail parses it out of the
      // publication and merges it into metadata_json, which has no column of its own.
      const body = parse((await tools.executeTool('ch_get_company', { uid: UID_AG }))!);
      const first = body.shab.find((p: any) => p.shab_id === 'SHAB-HR01');
      const later = body.shab.find((p: any) => p.shab_id === 'SHAB-HR02');

      expect(first.capital).toBe('100000.00');
      expect(first.capital_currency).toBe('CHF');
      expect(later.capital).toBeNull();
    });

    it('accepts an undotted UID', async () => {
      const body = parse((await tools.executeTool('ch_get_company', { uid: 'che123456789' }))!);
      expect(body.company.uid).toBe(UID_AG);
    });

    it('returns empty register sections for a company nobody else lists', async () => {
      const body = parse((await tools.executeTool('ch_get_company', { uid: UID_INACTIVE }))!);
      expect(body.company.uid).toBe(UID_INACTIVE);
      expect(body.shab).toEqual([]);
      expect(body.bankruptcies).toEqual([]);
      expect(body.finma).toEqual([]);
      expect(body.seco).toEqual([]);
      expect(body.kantonsblatt).toEqual([]);
    });

    it('matches SECO by the normalised name and Kantonsblatt by the UID', async () => {
      const body = parse((await tools.executeTool('ch_get_company', { uid: UID_GE }))!);
      expect(body.normalized_name).toBe('genève services');
      expect(body.seco.map((r: any) => Number(r.ssid))).toEqual([900002]);
      expect(body.kantonsblatt.map((r: any) => r.publication_number)).toEqual(['KB-3']);
      expect(body.finma).toEqual([]);
    });

    it('does not answer Kantonsblatt from a title when no row carries the UID', async () => {
      // Matching the title means normalising it, which no index can serve — a sequential
      // scan of 2.18M rows on every card whose company has no UID-bearing cantonal
      // publication, which is most of them. The UID rows are the authoritative ones and
      // name_match_note says so; a UID-less publication is a miss, not a quiet guess.
      await client.query(
        `INSERT INTO ch_kantonsblatt_publications
           (publication_uuid, publication_number, publication_date, sub_rubric, cantons,
            title, publication_text_de, company_uid)
         VALUES ('44444444-4444-4444-4444-444444444444', 'KB-4', '2024-05-20', 'HR02',
                 ARRAY['GE'], 'ALTE MUSTER, GmbH', 'Kantonale Publikation ohne UID.', NULL)`
      );

      const body = parse((await tools.executeTool('ch_get_company', { uid: UID_INACTIVE }))!);
      expect(body.kantonsblatt).toEqual([]);
      expect(body.name_match_note).toContain('UID');
    });

    it('reports every register section as complete when none of them is capped', async () => {
      const body = parse((await tools.executeTool('ch_get_company', { uid: UID_AG }))!);

      expect(body.shab_truncated).toBe(false);
      expect(body.bankruptcies_truncated).toBe(false);
      expect(body.finma_truncated).toBe(false);
      expect(body.seco_truncated).toBe(false);
      expect(body.kantonsblatt_truncated).toBe(false);
    });

    it('caps a long register section and says the register held more', async () => {
      // A section at exactly its cap is indistinguishable from a section that was cut,
      // and the evidence panel presented both as the company's total. 51 cantonal
      // publications against a cap of 50, and 101 SHAB rows against a cap of 100: the
      // card returns the cap and flags it.
      await client.query(
        `INSERT INTO ch_kantonsblatt_publications
           (publication_uuid, publication_number, publication_date, sub_rubric, cantons,
            title, publication_text_de, company_uid)
         SELECT gen_random_uuid(), 'KB-BULK-' || g, '2023-01-01', 'HR01', ARRAY['ZH'],
                'Muster Handels AG', 'Kantonale Publikation.', $1
           FROM generate_series(1, 51) AS g`,
        [UID_AG]
      );
      await client.query(
        `INSERT INTO ch_shab_publications
           (shab_id, publication_date, publication_type, rubric, sub_rubric, company_uid,
            company_name, canton, content, language)
         SELECT 'SHAB-BULK-' || g, '2023-01-01', 'Mutation', 'HR', 'HR02', $1,
                'Muster Handels AG', 'ZH', 'Mutation.', 'de'
           FROM generate_series(1, 101) AS g`,
        [UID_AG]
      );

      const body = parse((await tools.executeTool('ch_get_company', { uid: UID_AG }))!);

      expect(body.kantonsblatt).toHaveLength(50);
      expect(body.kantonsblatt_truncated).toBe(true);
      expect(body.shab).toHaveLength(100);
      expect(body.shab_truncated).toBe(true);
      // The bankruptcy section is untouched by either bulk insert.
      expect(body.bankruptcies_truncated).toBe(false);
    });

    it('returns not_found for an unknown UID', async () => {
      const body = parse((await tools.executeTool('ch_get_company', { uid: UID_UNKNOWN }))!);
      expect(body.error).toBe('not_found');
      expect(body.uid).toBe(UID_UNKNOWN);
    });

    it('rejects a malformed UID in Ukrainian', async () => {
      const result = (await tools.executeTool('ch_get_company', { uid: 'not-a-uid' }))!;
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
      expect(text(result)).toContain('CHE-');
    });

    it('asks for a uid in Ukrainian when it is missing', async () => {
      const result = (await tools.executeTool('ch_get_company', {}))!;
      expect(text(result)).toContain('uid');
      expect(text(result)).toMatch(/[Ѐ-ӿ]/);
    });
  });

  it('returns null for a tool it does not handle', async () => {
    expect(await tools.executeTool('some_other_tool', {})).toBeNull();
  });
});
