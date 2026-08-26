/**
 * Integration tests for ChLegislationTools against a real PostgreSQL.
 *
 * A mocked db.query cannot validate SQL, and the edition-selection window
 * (date_applicability <= as_of AND (date_end_applicability IS NULL OR as_of <=
 * date_end_applicability)) and the derived e_id join in ch_get_act_history only fail
 * at the server, not against a mock. Set CH_TEST_DATABASE_URL to run; skipped
 * otherwise.
 *
 * date_end_applicability is the LAST DAY an edition is in force (inclusive), not an
 * exclusive end — verified against prod on 2026-08-23 across 19,428 consecutive parsed
 * editions of the same act/lang (next.date_applicability = prev.date_end_applicability +
 * 1 day). Fixtures below mirror that shape: consecutive editions with no gap and no
 * overlap, e.g. [2015-01-01 .. 2019-12-31] followed by [2020-01-01 .. NULL].
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

// This suite applies migrations and TRUNCATEs tables against whatever CH_TEST_DATABASE_URL
// points to. Refuse to run against anything that isn't obviously a disposable test database.
if (DSN) {
  const dbName = new URL(DSN).pathname.split('/').pop() || '';
  if (!dbName.includes('test')) {
    throw new Error('CH_TEST_DATABASE_URL must point to a database whose name contains "test"');
  }
}

describeIfPg('ChLegislationTools (real PostgreSQL)', () => {
  let client: Client;
  let tools: ChLegislationTools;

  let actId: string;
  let versionDe2015: string;
  let versionDe2020: string;
  let versionFr2020: string;

  const SR_COMPTABILITE = '221.431';
  const SR_CO_COMMERCIAL = '221.432';

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();

    const migrations = join(__dirname, '../../../migrations');
    for (const file of [
      '134_ch_court_decisions.sql',
      '196_ch_court_pipeline.sql',
      '197_ch_legislation_corpus.sql',
      '198_ch_as_bbl.sql',
      '201_ch_cantonal_legislation.sql',
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
       VALUES ($1, 'eli/cc/27/317_321_377/de/2015-01-01', 'de', '2015-01-01', '2019-12-31', 'parsed', 1)
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

    // article_number is not unique within a version: transitional provisions carry the
    // same number nested under a disposition path (e_id like 'disp_u17/art_7'). The
    // top-level article (e_id 'art_336', no '/') must be the one chosen by default, with
    // this one surfaced via other_matches instead of silently shadowing it.
    await client.query(
      `INSERT INTO ch_act_article (version_id, e_id, article_number, marginal_note, text, ordinal)
       VALUES ($1, 'disp_u17/art_336', '336', 'Übergangsbestimmung zu Art. 336', 'Übergangsrecht zu Art. 336.', 3)`,
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

    // Fixtures for the short-query word-boundary fix: "comptabilité" contains "co" as a
    // substring but not as a standalone word, and must not match a "CO" search; the second
    // act's title contains "CO" as a standalone word and must match.
    await client.query(
      `INSERT INTO ch_act (eli_work_uri, sr_number, abbreviation, title_de, title_fr, title_it, date_entry_force, enforcement_status)
       VALUES ('eli/cc/comptabilite', $1, 'XYZ', 'Buchführungsverordnung', 'Ordonnance sur la comptabilité', 'Ordinanza sulla contabilità', '2013-01-01', 0)`,
      [SR_COMPTABILITE]
    );
    await client.query(
      `INSERT INTO ch_act (eli_work_uri, sr_number, abbreviation, title_de, title_fr, title_it, date_entry_force, enforcement_status)
       VALUES ('eli/cc/co-commercial', $1, 'ZZZ', 'Handelsregisterverordnung', 'Ordonnance relative au CO commercial', 'Ordinanza CO commerciale', '2013-01-01', 0)`,
      [SR_CO_COMMERCIAL]
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

    it('matches a title containing the standalone word "CO", but not "comptabilité"', async () => {
      const result = await tools.executeTool('ch_search_legislation', { query: 'CO', lang: 'fr' });
      const body = parse(result!);

      const srNumbers = body.results.map((r: any) => r.sr_number);
      expect(srNumbers).toContain(SR_CO_COMMERCIAL);
      expect(srNumbers).not.toContain(SR_COMPTABILITE);
    });

    it('still substring-matches a query longer than 5 characters', async () => {
      const result = await tools.executeTool('ch_search_legislation', { query: 'comptabilité', lang: 'fr' });
      const body = parse(result!);

      expect(body.results.map((r: any) => r.sr_number)).toContain(SR_COMPTABILITE);
    });

    describe('with the ch_act_alias table present', () => {
      beforeEach(async () => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ch_act_alias (
            abbr text NOT NULL,
            lang text NOT NULL,
            sr_number text NOT NULL,
            source text
          )
        `);
        await client.query('TRUNCATE ch_act_alias');
        await client.query(
          `INSERT INTO ch_act_alias (abbr, lang, sr_number, source) VALUES ('CO', 'fr', '220', 'curated')`
        );
      });

      afterEach(async () => {
        await client.query('DROP TABLE IF EXISTS ch_act_alias');
      });

      it('ranks SR 220 first for query "CO" lang fr via the curated alias, ahead of the CO-commercial title match', async () => {
        const result = await tools.executeTool('ch_search_legislation', { query: 'CO', lang: 'fr' });
        const body = parse(result!);

        expect(body.results.length).toBeGreaterThan(0);
        expect(body.results[0].sr_number).toBe('220');
      });
    });

    describe('without the ch_act_alias table', () => {
      beforeEach(async () => {
        await client.query('DROP TABLE IF EXISTS ch_act_alias');
      });

      it('returns no substring garbage: matches the standalone "CO" title, not "comptabilité", and OR (220) has no alias to rank on', async () => {
        const result = await tools.executeTool('ch_search_legislation', { query: 'CO', lang: 'fr' });
        const body = parse(result!);

        const srNumbers = body.results.map((r: any) => r.sr_number);
        expect(srNumbers).toContain(SR_CO_COMMERCIAL);
        expect(srNumbers).not.toContain(SR_COMPTABILITE);
        expect(srNumbers).not.toContain('220');
      });
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
      expect(body.version.date_end_applicability).toBe('2019-12-31');
    });

    it('returns the alt text for 336 at as_of 2019-12-31, the last day the 2015 edition is in force', async () => {
      // date_end_applicability is inclusive: 2019-12-31 is still within the 2015 edition,
      // not already inside the 2020 one. A '<' predicate against date_end_applicability
      // would wrongly skip this edition (or return no_edition_for_date) on this exact date.
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '2019-12-31',
      });
      const body = parse(result!);

      expect(body.article.text).toContain('alt');
      expect(body.version.date_applicability).toBe('2015-01-01');
      expect(body.version.date_end_applicability).toBe('2019-12-31');
    });

    it('returns the neu text for 336 at as_of 2020-01-01, the first day the 2020 edition is in force', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '2020-01-01',
      });
      const body = parse(result!);

      expect(body.article.text).toContain('neu');
      expect(body.version.date_applicability).toBe('2020-01-01');
      expect(body.version.date_end_applicability).toBeNull();
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

    it('prefers the top-level article over a transitional-provision duplicate, and surfaces the duplicate in other_matches', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '2026-01-01',
      });
      const body = parse(result!);

      expect(body.article.e_id).toBe('art_336');
      expect(body.article.text).toContain('neu');
      expect(body.other_matches).toEqual([
        { e_id: 'disp_u17/art_336', marginal_note: 'Übergangsbestimmung zu Art. 336' },
      ]);
    });

    it('reports an empty other_matches for an article with no duplicate', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336a',
        as_of: '2026-01-01',
      });
      const body = parse(result!);

      expect(body.other_matches).toEqual([]);
    });

    it('adds a Ukrainian note when the selected edition is the latest and other editions exist', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '2026-01-01',
      });
      const body = parse(result!);

      expect(body.other_editions).toBe(1);
      expect(body.note).toMatch(/[а-яіїєґА-ЯІЇЄҐ]/);
    });

    it('adds a Ukrainian note about the sole machine-readable edition when other_editions is 0', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        lang: 'fr',
        as_of: '2026-01-01',
      });
      const body = parse(result!);

      expect(body.other_editions).toBe(0);
      expect(body.note).toMatch(/[а-яіїєґА-ЯІЇЄҐ]/);
      expect(body.note).toMatch(/PDF/);
    });

    it('omits the note when the selected edition is not the latest one', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '2016-06-01',
      });
      const body = parse(result!);

      expect(body.note).toBeUndefined();
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

    it('reports a not_found error with entity "act" for an unknown sr_number', async () => {
      const result = await tools.executeTool('ch_get_act_article', { sr_number: '999999', article: '1' });
      const body = parse(result!);

      expect(body.error).toBe('not_found');
      expect(body.entity).toBe('act');
      expect(body.sr_number).toBe('999999');
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

      expect(body.changes_truncated).toBe(false);
      expect(body.provenance_truncated).toBe(false);
    });

    it('de-duplicates the same provenance footnote repeated across editions to a single row', async () => {
      // A parsed footnote is carried verbatim on every edition that includes the article
      // it documents — the same (e_id, action, as_reference, bbl_reference, effective_date)
      // tuple would otherwise be reported once per edition.
      const versionDe2010Result = await client.query(
        `INSERT INTO ch_act_version
           (act_id, eli_consolidation_uri, lang, date_applicability, date_end_applicability, stage, article_count)
         VALUES ($1, 'eli/cc/27/317_321_377/de/2010-01-01', 'de', '2010-01-01', '2014-12-31', 'parsed', 1)
         RETURNING version_id`,
        [actId]
      );
      const versionDe2010 = versionDe2010Result.rows[0].version_id;

      await client.query(
        `INSERT INTO ch_article_provenance (version_id, e_id, action, as_reference, effective_date, raw_note, anchor_level)
         VALUES ($1, 'art_dup', 'amended', 'AS 2001 0099', '2001-01-01', 'note repeated across editions', 'article')`,
        [versionDe2010]
      );
      await client.query(
        `INSERT INTO ch_article_provenance (version_id, e_id, action, as_reference, effective_date, raw_note, anchor_level)
         VALUES ($1, 'art_dup', 'amended', 'AS 2001 0099', '2001-01-01', 'note repeated across editions', 'article')`,
        [versionDe2015]
      );

      const result = await tools.executeTool('ch_get_act_history', { sr_number: '220' });
      const body = parse(result!);

      const dupRows = body.provenance.filter((p: any) => p.e_id === 'art_dup');
      expect(dupRows).toHaveLength(1);
      expect(dupRows[0].action).toBe('amended');
      expect(dupRows[0].as_reference).toBe('AS 2001 0099');
    });

    it('reports changes_truncated when the 200-row cap is hit', async () => {
      await client.query(
        `INSERT INTO ch_act_change (act_id, lang, from_version_id, to_version_id, e_id, article_number, change_type, date_applicability)
         SELECT $1, 'de', $2, $3, 'bulk_' || g, g::text, 'modified', '2020-01-01'
           FROM generate_series(1, 205) AS g`,
        [actId, versionDe2015, versionDe2020]
      );

      const result = await tools.executeTool('ch_get_act_history', { sr_number: '220' });
      const body = parse(result!);

      expect(body.changes).toHaveLength(200);
      expect(body.changes_truncated).toBe(true);
    });

    it('rejects an unsupported lang with a Ukrainian error message', async () => {
      const result = await tools.executeTool('ch_get_act_history', { sr_number: '220', lang: 'en' });
      const text = result!.content[0].text;

      expect(text).toMatch(/[а-яіїєґА-ЯІЇЄҐ]/);
    });

    it('reports a not_found error with entity "act" for an unknown sr_number', async () => {
      const result = await tools.executeTool('ch_get_act_history', { sr_number: '999999' });
      const body = parse(result!);

      expect(body.error).toBe('not_found');
      expect(body.entity).toBe('act');
      expect(body.sr_number).toBe('999999');
    });

    it('rejects a calendar-invalid as_of (2025-13-01) with a Ukrainian format error, not a DB error', async () => {
      const result = await tools.executeTool('ch_get_act_article', {
        sr_number: '220',
        article: '336',
        as_of: '2025-13-01',
      });
      const text = result!.content[0].text;

      expect(text).toMatch(/YYYY-MM-DD/);
      expect(text).toMatch(/[а-яіїєґА-ЯІЇЄҐ]/);
    });

    it('correlates provenance to the article number per edition, not globally across editions', async () => {
      // Same e_id ('art_7') resolves to a different article_number in each edition — a
      // parsed-globally lookup would wrongly pull provenance from both editions for a query
      // on article '7'. Provenance must only surface from the edition where art_7 IS
      // article 7 (versionDe2015 here); the versionDe2020 row (art_7 == '7a' there) must not
      // leak in, even though it shares the same e_id.
      await client.query(
        `INSERT INTO ch_act_article (version_id, e_id, article_number, marginal_note, text, ordinal)
         VALUES ($1, 'art_7', '7', 'Art. 7 in the 2015 edition', 'Text 7 (2015).', 10)`,
        [versionDe2015]
      );
      await client.query(
        `INSERT INTO ch_act_article (version_id, e_id, article_number, marginal_note, text, ordinal)
         VALUES ($1, 'art_7', '7a', 'art_7 renumbered to 7a in the 2020 edition', 'Text 7a (2020).', 10)`,
        [versionDe2020]
      );

      await client.query(
        `INSERT INTO ch_article_provenance (version_id, e_id, action, as_reference, effective_date, raw_note, anchor_level)
         VALUES ($1, 'art_7', 'inserted', 'AS 2015 0007 (from 2015 edition)', '2015-01-01', 'note', 'article')`,
        [versionDe2015]
      );
      await client.query(
        `INSERT INTO ch_article_provenance (version_id, e_id, action, as_reference, effective_date, raw_note, anchor_level)
         VALUES ($1, 'art_7', 'amended', 'AS 2020 0007 (from 2020 edition)', '2020-01-01', 'note', 'article')`,
        [versionDe2020]
      );

      const result = await tools.executeTool('ch_get_act_history', { sr_number: '220', article: '7' });
      const body = parse(result!);

      expect(body.provenance).toHaveLength(1);
      expect(body.provenance[0].action).toBe('inserted');
      expect(body.provenance[0].as_reference).toBe('AS 2015 0007 (from 2015 edition)');
    });
  });

  describe('deterministic act selection for a duplicated sr_number', () => {
    beforeEach(async () => {
      // enforcement_status = 0 (in force) must win over a more recent date_entry_force
      // on a not-in-force act sharing the same sr_number.
      await client.query(
        `INSERT INTO ch_act (eli_work_uri, sr_number, abbreviation, title_de, date_entry_force, enforcement_status)
         VALUES ('eli/cc/dup/aaa', '999', 'AAA', 'Not in force, later date', '2020-01-01', 3)`
      );
      await client.query(
        `INSERT INTO ch_act (eli_work_uri, sr_number, abbreviation, title_de, date_entry_force, enforcement_status)
         VALUES ('eli/cc/dup/bbb', '999', 'BBB', 'In force, earlier date', '2010-01-01', 0)`
      );

      // Both in force: the later date_entry_force wins.
      await client.query(
        `INSERT INTO ch_act (eli_work_uri, sr_number, abbreviation, title_de, date_entry_force, enforcement_status)
         VALUES ('eli/cc/dup/ccc', '888', 'CCC', 'In force, earlier date', '2015-01-01', 0)`
      );
      await client.query(
        `INSERT INTO ch_act (eli_work_uri, sr_number, abbreviation, title_de, date_entry_force, enforcement_status)
         VALUES ('eli/cc/dup/ddd', '888', 'DDD', 'In force, later date', '2020-01-01', 0)`
      );
    });

    it('prefers the in-force act over a not-in-force one with a later date_entry_force', async () => {
      const result = await tools.executeTool('ch_get_act_history', { sr_number: '999' });
      const body = parse(result!);

      expect(body.abbreviation).toBe('BBB');
    });

    it('prefers the act with the later date_entry_force when both are in force', async () => {
      const result = await tools.executeTool('ch_get_act_history', { sr_number: '888' });
      const body = parse(result!);

      expect(body.abbreviation).toBe('DDD');
    });
  });

  describe('a cantonal act sharing a federal sr_number (migration 201)', () => {
    beforeEach(async () => {
      // Cantonal collections reuse numbers freely; ZH 220 must never shadow SR 220
      // for a caller that did not ask for a canton, and must be reachable for one that did.
      const zh = await client.query(
        `INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number, abbreviation, title_de, date_entry_force, enforcement_status)
         VALUES ('https://www.zh.ch/zhlex/220', 'ZH', '220', 'ZHX', 'Zuercher Erlass 220', '2021-01-01', 0)
         RETURNING act_id`
      );
      await client.query(
        `INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, stage, article_count, source)
         VALUES ($1, 'https://www.zh.ch/zhlex/220/v1', 'de', '2021-01-01', 'parsed', 1, 'lexwork')`,
        [zh.rows[0].act_id]
      );
      const v = await client.query(`SELECT version_id FROM ch_act_version WHERE act_id = $1`, [zh.rows[0].act_id]);
      await client.query(
        `INSERT INTO ch_act_article (version_id, e_id, article_number, marginal_note, text, ordinal)
         VALUES ($1, 't-0--a-336', '336', 'Zuercher Randtitel', 'Kantonaler Text.', 0)`,
        [v.rows[0].version_id]
      );
    });

    it('answers federally by default', async () => {
      const body = parse((await tools.executeTool('ch_get_act_article', {
        sr_number: '220', article: '336', as_of: '2021-06-01',
      }))!);
      expect(body.jurisdiction).toBe('CH');
      expect(body.abbreviation).toBe('OR');
    });

    it('answers for the canton when asked', async () => {
      const body = parse((await tools.executeTool('ch_get_act_article', {
        sr_number: '220', article: '336', as_of: '2021-06-01', canton: 'ZH',
      }))!);
      expect(body.jurisdiction).toBe('ZH');
      expect(body.abbreviation).toBe('ZHX');
      expect(body.article.text).toBe('Kantonaler Text.');
    });

    it('search scopes by canton and reports the jurisdiction', async () => {
      const federal = parse((await tools.executeTool('ch_search_legislation', { query: '220' }))!);
      expect(federal.results.map((r: any) => r.jurisdiction)).toEqual(['CH']);
      const zh = parse((await tools.executeTool('ch_search_legislation', { query: '220', canton: 'ZH' }))!);
      expect(zh.results.map((r: any) => r.jurisdiction)).toEqual(['ZH']);
      const all = parse((await tools.executeTool('ch_search_legislation', { query: '220', canton: 'all' }))!);
      expect(all.results.map((r: any) => r.jurisdiction).sort()).toEqual(['CH', 'ZH']);
    });
  });
});
