/**
 * Integration tests for ChEchrTools against a real PostgreSQL: the tsv column, the
 * respondent-as-whole-code filter, the article regex and the substr slice only fail at
 * the server. Set CH_TEST_DATABASE_URL to run; skipped otherwise.
 *
 *   CH_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55499/ch_tools_test npx jest ch-echr-tools.pg
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ChEchrTools } from '../ch-echr-tools';

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const DSN = process.env.CH_TEST_DATABASE_URL;
const describeIfPg = DSN ? describe : describe.skip;

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

if (DSN) {
  const dbName = new URL(DSN).pathname.split('/').pop() || '';
  if (!dbName.includes('test')) {
    throw new Error('CH_TEST_DATABASE_URL must point to a database whose name contains "test"');
  }
}

const GLOR = 'PROCEDURE\n' + 'The applicant, a Swiss national, was declared unfit for military service and had to pay the exemption tax. '.repeat(30);
const GLOR_FR = 'PROCÉDURE\n' + "Le requérant, ressortissant suisse, a été déclaré inapte au service militaire et astreint à la taxe d'exemption. ".repeat(30);

describeIfPg('ChEchrTools (real PostgreSQL)', () => {
  let client: Client;
  let tools: ChEchrTools;

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();
    await client.query('DROP TABLE IF EXISTS echr_cases');
    await client.query(readFileSync(join(__dirname, '../../../migrations/215_echr_cases_ch.sql'), 'utf-8'));
    const rows: Array<[string, string, string, string, string, number, string, string, string, string, string | null]> = [
      // item_id, app_no, doc_name, doc_type, collection2, importance, date, conclusion, respondent, lang, text
      ['001-92353', '13444/04', 'CASE OF GLOR v. SWITZERLAND', 'HEJUD', 'CASELAW;JUDGMENTS;CHAMBER;ENG', 1, '2009-04-30', 'Violation of Art. 14+8', 'CHE', 'ENG', GLOR],
      ['001-92354', '13444/04', 'AFFAIRE GLOR c. SUISSE', 'HFJUD', 'CASELAW;JUDGMENTS;CHAMBER;FRE', 1, '2009-04-30', 'Violation de l\'art. 14+8', 'CHE', 'FRE', GLOR_FR],
      ['001-92355', '13444/04', 'GLOR v. SWITZERLAND - [German Translation]', 'HJUDGER', 'CASELAW;JUDGMENTS;CHAMBER;GER', 1, '2009-04-30', 'Violation of Art. 14+8', 'CHE', 'GER', 'Der Beschwerdeführer wurde für militärdienstuntauglich erklärt.'],
      ['001-70000', '13444/04', 'GLOR v. SWITZERLAND (dec.)', 'HEDEC', 'CASELAW;DECISIONS;CHAMBER;ENG', 4, '2006-01-10', 'Partly inadmissible', 'CHE', 'ENG', 'The applicant complained about the military service exemption tax. Admissible in part.'],
      ['001-60000', '30210/96', 'CASE OF KUDLA v. POLAND', 'HEJUD', 'CASELAW;JUDGMENTS;GRANDCHAMBER;ENG', 1, '2000-10-26', 'Violation of Art. 13;No violation of Art. 3', 'POL', 'ENG', 'The applicant complained of the length of the proceedings and of the military service he did not do. ' + 'Article 13 requires an effective remedy. '.repeat(20)],
      ['001-50000', '1111/99', 'CASE OF X v. ITALY AND SWITZERLAND', 'HEJUD', 'CASELAW;JUDGMENTS;CHAMBER;ENG', 3, '2001-05-05', 'No violation of P1-1', 'ITA;CHE', 'ENG', 'Property and the exemption tax. '.repeat(20)],
      ['001-40000', '2222/99', 'CASE OF NOTEXT v. SWITZERLAND', 'HEJUD', 'CASELAW;JUDGMENTS;CHAMBER;ENG', 3, '2002-05-05', 'Violation of Art. 6-1', 'CHE', 'ENG', null],
    ];
    for (const r of rows) {
      await client.query(
        `INSERT INTO echr_cases (item_id, app_no, doc_name, doc_type, document_collection_id2, importance, judgment_date,
                                 conclusion, respondent, language_iso, kp_date, is_placeholder, full_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$7::text || 'T00:00:00', false, $11)`, r);
    }
    tools = new ChEchrTools({ query: (sql: string, params?: any[]) => client.query(sql, params) });
  });

  afterAll(async () => {
    await client.end();
  });

  describe('ch_search_echr', () => {
    it('finds by words, defaults to Swiss respondents, ranks and snippets', async () => {
      const out = parse(await tools.executeTool('ch_search_echr', { query: 'exemption tax' }) as any);
      const ids = out.results.map((r: any) => r.item_id);
      expect(ids).toContain('001-92353');
      expect(ids).toContain('001-50000');            // ITA;CHE: CHE as a whole code
      expect(ids).not.toContain('001-60000');        // Poland
      expect(out.results[0].snippet).toMatch(/<b>/);
      expect(out.results[0].hudoc_url).toBe(`https://hudoc.echr.coe.int/eng?i=${out.results[0].item_id}`);
      expect(out.licence).toMatch(/Council of Europe/);
      expect(out.total_count).toBe(ids.length);
    });

    it("searches the whole corpus with respondent '' and narrows by kind, lang, importance, article, date", async () => {
      let out = parse(await tools.executeTool('ch_search_echr', { query: 'military service', respondent: '' }) as any);
      expect(out.results.map((r: any) => r.item_id)).toContain('001-60000');
      out = parse(await tools.executeTool('ch_search_echr', { query: 'military service', respondent: '', kind: 'decision' }) as any);
      expect(out.results.map((r: any) => r.item_id)).toEqual(['001-70000']);
      out = parse(await tools.executeTool('ch_search_echr', { query: 'service militaire', lang: 'fr' }) as any);
      expect(out.results.map((r: any) => r.item_id)).toEqual(['001-92354']);
      out = parse(await tools.executeTool('ch_search_echr', { query: 'militärdienstuntauglich', kind: 'translation' }) as any);
      expect(out.results.map((r: any) => r.item_id)).toEqual(['001-92355']);
      out = parse(await tools.executeTool('ch_search_echr', { query: 'exemption tax', importance: 3 }) as any);
      expect(out.results.map((r: any) => r.item_id)).toEqual(['001-50000']);
      out = parse(await tools.executeTool('ch_search_echr', { query: 'exemption tax', article: '8' }) as any);
      expect(out.results.map((r: any) => r.item_id).sort()).toEqual(['001-92353']);   // 14+8 yes; P1-1 no; "8" is not "18"
      out = parse(await tools.executeTool('ch_search_echr', { query: 'exemption tax', article: 'P1-1' }) as any);
      expect(out.results.map((r: any) => r.item_id)).toEqual(['001-50000']);
      out = parse(await tools.executeTool('ch_search_echr', { query: 'exemption tax', date_from: '2005-01-01', date_to: '2008-12-31' }) as any);
      expect(out.results.map((r: any) => r.item_id)).toEqual(['001-70000']);
    });

    it('finds a text-less row by its title and says so', async () => {
      const out = parse(await tools.executeTool('ch_search_echr', { query: 'NOTEXT' }) as any);
      expect(out.results.map((r: any) => r.item_id)).toEqual(['001-40000']);
      expect(out.results[0].has_text).toBe(false);
    });

    it('refuses an empty query, an unknown kind or lang', async () => {
      expect((await tools.executeTool('ch_search_echr', { query: ' ' }) as any).content[0].text).toMatch(/query/);
      expect((await tools.executeTool('ch_search_echr', { query: 'x', kind: 'opinion' }) as any).content[0].text).toMatch(/kind/);
      expect((await tools.executeTool('ch_search_echr', { query: 'x', lang: 'ru' }) as any).content[0].text).toMatch(/lang/);
    });
  });

  describe('ch_get_echr_case', () => {
    it('returns one document by item_id with a text slice and its siblings', async () => {
      const out = parse(await tools.executeTool('ch_get_echr_case', { item_id: '001-92353', text_chars: 50 }) as any);
      expect(out.doc_name).toBe('CASE OF GLOR v. SWITZERLAND');
      expect(out.text).toBe(GLOR.slice(0, 50));
      expect(out.text_total_chars).toBe(GLOR.length);
      expect(out.truncated).toBe(true);
      expect(out.related.map((r: any) => r.item_id).sort()).toEqual(['001-70000', '001-92354', '001-92355']);
      expect(out.attribution).toMatch(/hudoc/);
    });

    it('resolves an application number to the judgment, in the asked language', async () => {
      let out = parse(await tools.executeTool('ch_get_echr_case', { app_no: '13444/04' }) as any);
      expect(out.item_id).toBe('001-92353');
      out = parse(await tools.executeTool('ch_get_echr_case', { app_no: '13444/04', lang: 'fr' }) as any);
      expect(out.item_id).toBe('001-92354');
      out = parse(await tools.executeTool('ch_get_echr_case', { app_no: '13444/04', text_offset: 10, text_chars: 5 }) as any);
      expect(out.text).toBe(GLOR.slice(10, 15));
    });

    it('reports a missing text as null, not as an empty slice', async () => {
      const out = parse(await tools.executeTool('ch_get_echr_case', { item_id: '001-40000' }) as any);
      expect(out.text).toBeNull();
      expect(out.truncated).toBe(false);
    });

    it('reports not_found and refuses a call without a key', async () => {
      const out = parse(await tools.executeTool('ch_get_echr_case', { item_id: '001-1' }) as any);
      expect(out.error).toBe('not_found');
      expect((await tools.executeTool('ch_get_echr_case', {}) as any).content[0].text).toMatch(/item_id/);
    });
  });
});
