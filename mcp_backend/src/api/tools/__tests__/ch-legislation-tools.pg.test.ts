/**
 * Integration tests for ChLegislationTools against a real PostgreSQL.
 *
 * A mocked db.query cannot validate SQL, and the edition-selection window
 * (date_applicability <= as_of AND (date_end_applicability IS NULL OR as_of <
 * date_end_applicability)) and the derived e_id join in ch_get_act_history only fail
 * at the server, not against a mock. Set CH_TEST_DATABASE_URL to run; skipped
 * otherwise.
 *
 *   CH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/ch_tools_test npx jest ch-legislation-tools.pg
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ChLegislationTools } from '../ch-legislation-tools';

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const DSN = process.env.CH_TEST_DATABASE_URL;
const describeIfPg = DSN ? describe : describe.skip;

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

describeIfPg('ChLegislationTools (real PostgreSQL)', () => {
  let client: Client;
  let tools: ChLegislationTools;

  let actId: string;
  let versionDe2015: string;
  let versionDe2020: string;
  let versionFr2020: string;

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();

    const migrations = join(__dirname, '../../../migrations');
    for (const file of [
      '134_ch_court_decisions.sql',
      '196_ch_court_pipeline.sql',
      '197_ch_legislation_corpus.sql',
      '198_ch_as_bbl.sql',
    ]) {
      await client.query(readFileSync(join(migrations, file), 'utf-8'));
    }

    tools = new ChLegislationTools({
      query: (text: string, params?: any[]) => client.query(text, params),
    } as any);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE ch_article_provenance, ch_act_change, ch_act_article, ch_act_version, ch_act CASCADE');

    const actResult = await client.query(
      `INSERT INTO ch_act
         (eli_work_uri, sr_number, act_type, abbreviation, title_de, title_fr, title_it, date_entry_force, enforcement_status)
       VALUES
         ('eli/cc/27/317_321_377', '220', 'federal_act', 'OR',
          'Bundesgesetz betreffend die Ergänzung des Schweizerischen Zivilgesetzbuches (Fünfter Teil: Obligationenrecht)',
          'Loi fédérale complétant le Code civil suisse (Livre cinquième: Droit des obligations)',
          'Codice delle obbligazioni',
          '1912-01-01', 0)
       RETURNING act_id`
    );
    actId = actResult.rows[0].act_id;

    const versionDe2015Result = await client.query(
      `INSERT INTO ch_act_version
         (act_id, eli_consolidation_uri, lang, date_applicability, date_end_applicability, stage, article_count)
       VALUES ($1, 'eli/cc/27/317_321_377/de/2015-01-01', 'de', '2015-01-01', '2020-01-01', 'parsed', 1)
       RETURNING version_id`,
      [actId]
    );
    versionDe2015 = versionDe2015Result.rows[0].version_id;

    const versionDe2020Result = await client.query(
      `INSERT INTO ch_act_version
         (act_id, eli_consolidation_uri, lang, date_applicability, date_end_applicability, stage, article_count)
       VALUES ($1, 'eli/cc/27/317_321_377/de/2020-01-01', 'de', '2020-01-01', NULL, 'parsed', 2)
       RETURNING version_id`,
      [actId]
    );
    versionDe2020 = versionDe2020Result.rows[0].version_id;

    const versionFr2020Result = await client.query(
      `INSERT INTO ch_act_version
         (act_id, eli_consolidation_uri, lang, date_applicability, date_end_applicability, stage, article_count)
       VALUES ($1, 'eli/cc/27/317_321_377/fr/2020-01-01', 'fr', '2020-01-01', NULL, 'parsed', 1)
       RETURNING version_id`,
      [actId]
    );
    versionFr2020 = versionFr2020Result.rows[0].version_id;

    await client.query(
      `INSERT INTO ch_act_article (version_id, e_id, article_number, marginal_note, text, ordinal)
       VALUES ($1, 'art_336', '336', 'Kündigungsschutz', 'Die Kündigung ist alt anfechtbar.', 1)`,
      [versionDe2015]
    );

    await client.query(
      `INSERT INTO ch_act_article (version_id, e_id, article_number, marginal_note, text, ordinal)
       VALUES ($1, 'art_336', '336', 'Kündigungsschutz', 'Die Kündigung ist neu anfechtbar.', 1)`,
      [versionDe2020]
    );
    await client.query(
      `INSERT INTO ch_act_article (version_id, e_id, article_number, marginal_note, text, ordinal)
       VALUES ($1, 'art_336_a', '336a', 'Massenentlassung', 'Bei Massenentlassungen gilt neu Folgendes.', 2)`,
      [versionDe2020]
    );

    await client.query(
      `INSERT INTO ch_act_article (version_id, e_id, article_number, marginal_note, text, ordinal)
       VALUES ($1, 'art_336', '336', 'Protection contre le congé', 'Le congé est annulable.', 1)`,
      [versionFr2020]
    );

    await client.query(
      `INSERT INTO ch_act_change (act_id, lang, from_version_id, to_version_id, e_id, article_number, change_type, date_applicability)
       VALUES ($1, 'de', $2, $3, 'art_336_a', '336a', 'added', '2020-01-01')`,
      [actId, versionDe2015, versionDe2020]
    );

    await client.query(
      `INSERT INTO ch_article_provenance (version_id, e_id, action, as_reference, effective_date, raw_note, anchor_level)
       VALUES ($1, 'art_336_a', 'inserted', 'AS 2019 1234', '2020-01-01',
               'Eingefügt durch Ziff. I des BG vom 5. Okt. 2018, in Kraft seit 1. Jan. 2020 (AS 2019 1234; BBl 2018 1667).',
               'article')`,
      [versionDe2020]
    );
  });

  describe('ch_search_legislation', () => {
    it('finds SR 220 first by abbreviation OR', async () => {
      const result = await tools.executeTool('ch_search_legislation', { query: 'OR' });
      const body = parse(result!);

      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].sr_number).toBe('220');
      expect(body.results[0].abbreviation).toBe('OR');
    });

    it('finds SR 220 by exact sr_number 220', async () => {
      const result = await tools.executeTool('ch_search_legislation', { query: '220' });
      const body = parse(result!);

      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].sr_number).toBe('220');
    });

    it('finds SR 220 by German title substring Obligationenrecht', async () => {
      const result = await tools.executeTool('ch_search_legislation', { query: 'Obligationenrecht', lang: 'de' });
      const body = parse(result!);

      expect(body.results.map((r: any) => r.sr_number)).toContain('220');
    });

    it('reports editions_count and latest_edition_date for the requested lang', async () => {
      const result = await tools.executeTool('ch_search_legislation', { query: '220', lang: 'de' });
      const body = parse(result!);

      const row = body.results.find((r: any) => r.sr_number === '220');
      expect(row.editions_count).toBe(2);
      expect(row.latest_edition_date).toBe('2020-01-01');
    });
  });

  describe('ch_get_act_article', () => {
    it('returns the alt text for 336 at as_of 2016-06-01 (the 2015 edition)', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '2016-06-01',
      });
      const body = parse(result!);

      expect(body.article.text).toContain('alt');
      expect(body.version.date_applicability).toBe('2015-01-01');
      expect(body.version.date_end_applicability).toBe('2020-01-01');
    });

    it('returns the neu text for 336 at as_of 2026-01-01 (the 2020 edition)', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '2026-01-01',
      });
      const body = parse(result!);

      expect(body.article.text).toContain('neu');
      expect(body.version.date_applicability).toBe('2020-01-01');
      expect(body.version.date_end_applicability).toBeNull();
    });

    it('reports article_not_found for 336a at as_of 2016-06-01 (not yet inserted)', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336a',
        as_of: '2016-06-01',
      });
      const body = parse(result!);

      expect(body.error).toBe('article_not_found');
      expect(body.available_examples).toEqual(['336']);
    });

    it('reports no_edition_for_date for as_of 2010-01-01, before any machine-readable edition', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '2010-01-01',
      });
      const body = parse(result!);

      expect(body.error).toBe('no_edition_for_date');
      expect(body.earliest_edition).toBe('2015-01-01');
    });

    it('returns the fr version at as_of 2026-01-01', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        lang: 'fr',
        as_of: '2026-01-01',
      });
      const body = parse(result!);

      expect(body.lang).toBe('fr');
      expect(body.version.eli_consolidation_uri).toBe('eli/cc/27/317_321_377/fr/2020-01-01');
      expect(body.article.text).toContain('congé');
    });

    it('rejects a malformed as_of with a Ukrainian error message', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '01-01-2020',
      });
      const text = result!.content[0].text;

      expect(text).toMatch(/[а-яіїєґА-ЯІЇЄҐ]/);
    });
  });

  describe('ch_get_act_history', () => {
    it('returns editions, the added change, and the AS provenance for article 336a', async () => {
      const result = await tools.executeTool('ch_get_act_history', {
        sr_number: '220',
        article: '336a',
      });
      const body = parse(result!);

      expect(body.editions.length).toBe(2);

      expect(body.changes).toHaveLength(1);
      expect(body.changes[0].change_type).toBe('added');
      expect(body.changes[0].article_number).toBe('336a');
      expect(body.changes[0].date_applicability).toBe('2020-01-01');

      expect(body.provenance).toHaveLength(1);
      expect(body.provenance[0].as_reference).toBe('AS 2019 1234');
      expect(body.provenance[0].e_id).toBe('art_336_a');
    });
  });
});
