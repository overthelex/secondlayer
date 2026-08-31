/**
 * Integration tests for ChCourtTools against a real PostgreSQL.
 *
 * A mocked db.query cannot validate SQL, and this handler's FTS predicate must match
 * the exact expression the prod GIN index (idx_ch_court_fts) was built with — that only
 * fails at the server, not against a mock. Set CH_TEST_DATABASE_URL to run; skipped
 * otherwise.
 *
 *   CH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/ch_tools_test npx jest ch-court-tools.pg
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ChCourtTools } from '../ch-court-tools';

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

describeIfPg('ChCourtTools (real PostgreSQL)', () => {
  let client: Client;
  let tools: ChCourtTools;

  const ECLI_DE = 'ECLI:CH:BGER:2017:4A.22.2017';
  const ECLI_FR = 'ECLI:CH:BGER:2021:6B.100.2021';
  const ECLI_IT = 'ECLI:CH:TI:2023:CA.5.2023';
  const ECLI_FAILED = 'ECLI:CH:BGER:2019:5A.1.2019';
  const ECLI_NULL_DATE = 'ECLI:CH:BGER:2020:7B.5.2020';
  const ECLI_CHAMBER = 'ECLI:CH:BGER:2022:9C.4.2022';
  const ECLI_LOOKALIKE = 'ECLI:CH:XX:2022:LOOK.1.2022';
  // CH_BGer/CH_BGE carry the source's three-language header {de,fr,it} verbatim in
  // `languages` regardless of the decision's real language — the real language sits in
  // metadata_json->>'Sprache'.
  const ECLI_SPRACHE_FR = 'ECLI:CH:BGER:2024:5A.9.2024';

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();

    const migrations = join(__dirname, '../../../migrations');
    for (const file of ['134_ch_court_decisions.sql', '196_ch_court_pipeline.sql']) {
      await client.query(readFileSync(join(migrations, file), 'utf-8'));
    }

    tools = new ChCourtTools({
      query: (text: string, params?: any[]) => client.query(text, params),
    } as any);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE ch_court_decisions');

    await client.query(
      `INSERT INTO ch_court_decisions
         (ecli, doc_id, spider, court_code, court_name, chamber, canton, decision_type,
          decision_date, docket_number, languages, parties, abstract, full_text,
          html_url, pdf_url, json_url, stage)
       VALUES
         ($1, $2, 'CH_BGer', 'BGer', 'Bundesgericht', 'I. zivilrechtliche Abteilung', NULL,
          'Urteil', '2017-06-19', '4A_22/2017', ARRAY['de'], 'A. gegen B.',
          'Missbräuchliche Kündigung Art. 336 OR SharedMarkerXYZ',
          'Die Kündigung des Arbeitsverhältnisses durch die Arbeitgeberin war missbräuchlich im Sinne von Art. 336 OR. Die Kündigung erfolgte kurz nach einer Reklamation der Arbeitnehmerin.',
          'https://entscheidsuche.ch/html/CH_BGER_001', 'https://entscheidsuche.ch/pdf/CH_BGER_001', 'https://entscheidsuche.ch/json/CH_BGER_001', 'loaded')`,
      [ECLI_DE, 'CH_BGER_001']
    );

    await client.query(
      `INSERT INTO ch_court_decisions
         (ecli, doc_id, spider, court_code, court_name, chamber, canton, decision_type,
          decision_date, docket_number, languages, parties, abstract, full_text,
          html_url, pdf_url, json_url, stage)
       VALUES
         ($1, $2, 'CH_BGer', 'BGer', 'Bundesgericht', 'I. droit du travail', NULL,
          'Arrêt', '2021-01-01', '6B_100/2021', ARRAY['fr'], 'X. contre Y.',
          'Résiliation abusive du contrat de travail SharedMarkerXYZ',
          'La résiliation abusive du contrat a été retenue par le tribunal cantonal.',
          'https://entscheidsuche.ch/html/CH_BGER_002', 'https://entscheidsuche.ch/pdf/CH_BGER_002', 'https://entscheidsuche.ch/json/CH_BGER_002', 'loaded')`,
      [ECLI_FR, 'CH_BGER_002']
    );

    await client.query(
      `INSERT INTO ch_court_decisions
         (ecli, doc_id, spider, court_code, court_name, chamber, canton, decision_type,
          decision_date, docket_number, languages, parties, abstract, full_text,
          html_url, pdf_url, json_url, stage)
       VALUES
         ($1, $2, 'TI_CA', 'TI_CA', 'Camera di appello', NULL, 'TI',
          'Sentenza', '2023-03-01', 'CA.5.2023', ARRAY['it'], 'A. contro B.',
          'Locazione disdetta abusiva SharedMarkerXYZ',
          'La disdetta della locazione e stata giudicata abusiva dal tribunale.',
          'https://entscheidsuche.ch/html/CH_TI_001', 'https://entscheidsuche.ch/pdf/CH_TI_001', 'https://entscheidsuche.ch/json/CH_TI_001', 'loaded')`,
      [ECLI_IT, 'CH_TI_001']
    );

    await client.query(
      `INSERT INTO ch_court_decisions
         (ecli, doc_id, spider, court_code, court_name, chamber, canton, decision_type,
          decision_date, docket_number, languages, parties, abstract, full_text,
          html_url, pdf_url, json_url, stage)
       VALUES
         ($1, $2, 'CH_BGer', 'BGer', 'Bundesgericht', NULL, NULL,
          'Urteil', '2019-05-01', '5A_1/2019', ARRAY['de'], 'C. gegen D.',
          'Kündigung strittig SharedMarkerXYZ',
          'Die Kündigung ist Gegenstand dieses Verfahrens.',
          NULL, NULL, NULL, 'failed')`,
      [ECLI_FAILED, 'CH_BGER_003']
    );

    await client.query(
      `INSERT INTO ch_court_decisions
         (ecli, doc_id, spider, court_code, court_name, chamber, canton, decision_type,
          decision_date, docket_number, languages, parties, abstract, full_text,
          html_url, pdf_url, json_url, stage)
       VALUES
         ($1, $2, 'CH_BGer', 'BGer', 'Bundesgericht', NULL, NULL,
          'Urteil', NULL, '7B_5/2020', ARRAY['de'], 'E. gegen F.',
          'Datum unbekannt NullDateMarkerABC',
          'Das Datum dieses Entscheids ist im Quellsystem nicht bekannt.',
          'https://entscheidsuche.ch/html/CH_BGER_005', 'https://entscheidsuche.ch/pdf/CH_BGER_005', 'https://entscheidsuche.ch/json/CH_BGER_005', 'loaded')`,
      [ECLI_NULL_DATE, 'CH_BGER_005']
    );

    // A court whose code differs from CH_BGer only where CH_BGer has an underscore:
    // a LIKE prefix match that does not escape '_' would take it for a chamber.
    await client.query(
      `INSERT INTO ch_court_decisions
         (ecli, doc_id, spider, court_code, court_name, chamber, canton, decision_type,
          decision_date, docket_number, languages, parties, abstract, full_text,
          html_url, pdf_url, json_url, stage)
       VALUES
         ($1, $2, 'XX_Look', 'CHXBGer_004', 'Lookalike', NULL, 'XX',
          'Urteil', '2022-02-02', 'LOOK_1/2022', ARRAY['de'], 'G. gegen H.',
          'Lookalike ChamberMarkerABC',
          'Ein Gericht mit einem Code, der CH_BGer nur im Unterstrich gleicht.',
          NULL, NULL, NULL, 'loaded')`,
      [ECLI_LOOKALIKE, 'XX_LOOK_001']
    );

    await client.query(
      `INSERT INTO ch_court_decisions
         (ecli, doc_id, spider, court_code, court_name, chamber, canton, decision_type,
          decision_date, docket_number, languages, parties, abstract, full_text,
          html_url, pdf_url, json_url, stage)
       VALUES
         ($1, $2, 'CH_BGer', 'CH_BGer_004', 'Bundesgericht', 'IV. Kammer', 'CH',
          'Urteil', '2022-01-01', '9C_4/2022', ARRAY['de'], 'G. gegen H.',
          'Kammerspezifischer Fall ChamberMarkerABC',
          'Dieser Fall betrifft eine spezifische Kammer des Bundesgerichts.',
          'https://entscheidsuche.ch/html/CH_BGER_006', 'https://entscheidsuche.ch/pdf/CH_BGER_006', 'https://entscheidsuche.ch/json/CH_BGER_006', 'loaded')`,
      [ECLI_CHAMBER, 'CH_BGER_006']
    );

    // The source's three-language header, with the real language only recoverable from
    // metadata_json->>'Sprache'. languages[1] is 'de' here, but the decision is French.
    await client.query(
      `INSERT INTO ch_court_decisions
         (ecli, doc_id, spider, court_code, court_name, chamber, canton, decision_type,
          decision_date, docket_number, languages, metadata_json, parties, abstract, full_text,
          html_url, pdf_url, json_url, stage)
       VALUES
         ($1, $2, 'CH_BGer', 'BGer', 'Bundesgericht', 'II. droit civil', NULL,
          'Arrêt', '2024-04-04', '5A_9/2024', ARRAY['de','fr','it'], '{"Sprache": "fr"}'::jsonb,
          'M. contre N.',
          'Résiliation abusive du bail SpracheMarkerDEF',
          'La résiliation abusive du bail a été constatée par le tribunal.',
          'https://entscheidsuche.ch/html/CH_BGER_007', 'https://entscheidsuche.ch/pdf/CH_BGER_007', 'https://entscheidsuche.ch/json/CH_BGER_007', 'loaded')`,
      [ECLI_SPRACHE_FR, 'CH_BGER_007']
    );
  });

  describe('ch_search_court_decisions', () => {
    it('finds the German decision by full-text query with a positive rank and a matching snippet', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', { query: 'Kündigung' });
      const body = parse(result!);

      expect(body.results).toHaveLength(1);
      expect(body.results[0].ecli).toBe(ECLI_DE);
      expect(body.results[0].rank).toBeGreaterThan(0);
      expect(body.results[0].snippet).toContain('Kündigung');
    });

    it('excludes the placeholder decision_date row from a date_from filter', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', {
        query: 'SharedMarkerXYZ',
        date_from: '2020-01-01',
      });
      const body = parse(result!);

      // Only the IT row (2023-03-01) has a real date on/after 2020-01-01. The DE row
      // (2017) is filtered out by the date itself; the FR row (placeholder 2021-01-01)
      // must be filtered out too, even though the literal value would satisfy the
      // range, because a placeholder date is not a real date.
      expect(body.results.map((r: any) => r.ecli)).toEqual([ECLI_IT]);
    });

    it('filters by lang falling back to languages[1] when metadata_json has no Sprache', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', {
        query: 'SharedMarkerXYZ',
        lang: 'it',
      });
      const body = parse(result!);

      expect(body.results).toHaveLength(1);
      expect(body.results[0].ecli).toBe(ECLI_IT);
      expect(body.results[0].lang).toBe('it');
    });

    it('filters by lang using metadata_json->>Sprache when languages is the source header {de,fr,it}', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', {
        query: 'SpracheMarkerDEF',
        lang: 'fr',
      });
      const body = parse(result!);

      expect(body.results).toHaveLength(1);
      expect(body.results[0].ecli).toBe(ECLI_SPRACHE_FR);
      expect(body.results[0].lang).toBe('fr');
    });

    it('does not match lang de for a decision whose Sprache is fr, even though languages[1] is de', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', {
        query: 'SpracheMarkerDEF',
        lang: 'de',
      });
      const body = parse(result!);

      expect(body.results).toHaveLength(0);
    });

    it('filters by canton', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', {
        query: 'SharedMarkerXYZ',
        canton: 'TI',
      });
      const body = parse(result!);

      expect(body.results).toHaveLength(1);
      expect(body.results[0].ecli).toBe(ECLI_IT);
    });

    it('never returns a stage=failed row, even when it matches the query', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', { query: 'SharedMarkerXYZ' });
      const body = parse(result!);

      const eclis = body.results.map((r: any) => r.ecli);
      expect(eclis).not.toContain(ECLI_FAILED);
      expect(eclis.sort()).toEqual([ECLI_DE, ECLI_FR, ECLI_IT].sort());
    });

    it('reports decision_date_unknown for a row with a NULL decision_date', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', { query: 'NullDateMarkerABC' });
      const body = parse(result!);

      expect(body.results).toHaveLength(1);
      expect(body.results[0].ecli).toBe(ECLI_NULL_DATE);
      expect(body.results[0].decision_date).toBeNull();
      expect(body.results[0].decision_date_unknown).toBe(true);
    });

    it('matches a chamber-granular court_code by prefix, but not an unrelated prefix', async () => {
      const matched = parse((await tools.executeTool('ch_search_court_decisions', {
        query: 'ChamberMarkerABC', court_code: 'CH_BGer',
      }))!);
      expect(matched.results.map((r: any) => r.ecli)).toEqual([ECLI_CHAMBER]);

      const unmatched = parse((await tools.executeTool('ch_search_court_decisions', {
        query: 'ChamberMarkerABC', court_code: 'ZH_OG',
      }))!);
      expect(unmatched.results).toHaveLength(0);

      // '_' in the caller's prefix must be literal: CHXBGer_004 is not a CH_BGer chamber
      const lookalike = parse((await tools.executeTool('ch_search_court_decisions', {
        query: 'ChamberMarkerABC', court_code: 'CHXBGer',
      }))!);
      expect(lookalike.results.map((r: any) => r.ecli)).toEqual([ECLI_LOOKALIKE]);
    });

    it('matches an exact court_code with no chambers', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', {
        query: 'SharedMarkerXYZ', court_code: 'TI_CA',
      });
      const body = parse(result!);

      expect(body.results.map((r: any) => r.ecli)).toEqual([ECLI_IT]);
    });

    it('rejects an unsupported lang with a Ukrainian error message', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', { query: 'Kündigung', lang: 'en' });
      const text = result!.content[0].text;

      expect(text).toMatch(/[а-яіїєґА-ЯІЇЄҐ]/);
    });

    it('rejects a calendar-invalid date_from (2024-02-31) with a Ukrainian format error, not a DB error', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', {
        query: 'Kündigung',
        date_from: '2024-02-31',
      });
      const text = result!.content[0].text;

      expect(text).toMatch(/YYYY-MM-DD/);
      expect(text).toMatch(/[а-яіїєґА-ЯІЇЄҐ]/);
    });

    it('rejects a calendar-invalid date_to (2024-02-31) with a Ukrainian format error', async () => {
      const result = await tools.executeTool('ch_search_court_decisions', {
        query: 'Kündigung',
        date_to: '2024-02-31',
      });
      const text = result!.content[0].text;

      expect(text).toMatch(/YYYY-MM-DD/);
    });
  });

  describe('ch_get_court_decision', () => {
    it('returns the full row for a known ecli, capping full text and flagging a placeholder date as unknown', async () => {
      const result = await tools.executeTool('ch_get_court_decision', { ecli: ECLI_FR });
      const body = parse(result!);

      expect(body.ecli).toBe(ECLI_FR);
      expect(body.decision_date).toBeNull();
      expect(body.decision_date_unknown).toBe(true);
      expect(body.full_text_truncated).toBe(false);
      expect(body.full_text_length).toBe(body.full_text.length);
      expect(body.full_text).toContain('résiliation abusive');
    });

    it('reports lang from metadata_json->>Sprache, not languages[1]', async () => {
      const result = await tools.executeTool('ch_get_court_decision', { ecli: ECLI_SPRACHE_FR });
      const body = parse(result!);

      expect(body.languages).toEqual(['de', 'fr', 'it']);
      expect(body.lang).toBe('fr');
    });

    it('returns a not_found error for an unknown ecli', async () => {
      const result = await tools.executeTool('ch_get_court_decision', { ecli: 'ECLI:CH:BGER:9999:0.0.0' });
      const body = parse(result!);

      expect(body.error).toBe('not_found');
      expect(body.ecli).toBe('ECLI:CH:BGER:9999:0.0.0');
    });

    it('returns a not_loaded error, not the full row, for a decision still in the pipeline', async () => {
      const result = await tools.executeTool('ch_get_court_decision', { ecli: ECLI_FAILED });
      const body = parse(result!);

      expect(body.error).toBe('not_loaded');
      expect(body.ecli).toBe(ECLI_FAILED);
      expect(body.stage).toBe('failed');
      expect(body.full_text).toBeUndefined();
      expect(body.message).toMatch(/[а-яіїєґА-ЯІЇЄҐ]/);
    });

    it('reports decision_date_unknown for a row with a NULL decision_date', async () => {
      const result = await tools.executeTool('ch_get_court_decision', { ecli: ECLI_NULL_DATE });
      const body = parse(result!);

      expect(body.decision_date).toBeNull();
      expect(body.decision_date_unknown).toBe(true);
    });

    it('reports a Ukrainian error message when neither ecli nor doc_id is given', async () => {
      const result = await tools.executeTool('ch_get_court_decision', {});
      const text = result!.content[0].text;

      expect(text).toMatch(/ecli|doc_id/i);
      expect(text).toMatch(/[а-яіїєґА-ЯІЇЄҐ]/);
    });
  });
});
