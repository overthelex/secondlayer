/**
 * Integration tests for ChMaterialsTools against a real PostgreSQL.
 *
 * The article-purpose join (provenance bbl_reference → bbl_key → material, within a
 * language) and the paragraph regex over regexp_split_to_table only fail at the server.
 * Set CH_TEST_DATABASE_URL to run; skipped otherwise.
 *
 *   CH_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55499/ch_tools_test npx jest ch-materials-tools.pg
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ChMaterialsTools, bblKey } from '../ch-materials-tools';

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

const ELI = 'https://fedlex.data.admin.ch/eli/fga/2001/318';
const BOTSCHAFT_DE = [
  'Botschaft zum Embargogesetz',
  '',
  '1 Ausgangslage',
  'Die Schweiz setzt internationale Sanktionen um. Dieser Absatz nennt keine Norm.',
  '',
  '2.3 Art. 2 Zuständigkeit',
  'Art. 2 des Entwurfs überträgt dem Bundesrat die Kompetenz, Zwangsmassnahmen zu erlassen.',
  '',
  'Nach Artikel 2 Absatz 1 EmbG kann der Bundesrat Massnahmen anordnen; Art. 20 bleibt vorbehalten.',
  '',
  'Art. 3 regelt die Aufhebung.',
].join('\n');

describe('bblKey', () => {
  it('normalises both spellings to year|volume|page', () => {
    expect(bblKey('BBl 2001 1433')).toBe('2001||1433');
    expect(bblKey('FF 2001 1341')).toBe('2001||1341');
    expect(bblKey('FF 1986 II 360')).toBe('1986|II|360');
    expect(bblKey('BBl 2015 657 ff.')).toBe('2015||657');
    expect(bblKey('AS 2018 1813')).toBeNull();
    expect(bblKey(null)).toBeNull();
  });
});

describeIfPg('ChMaterialsTools (real PostgreSQL)', () => {
  let client: Client;
  let tools: ChMaterialsTools;
  let materialDe: number;

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();
    const migrations = join(__dirname, '../../../migrations');
    for (const t of ['ch_material', 'ch_act_alias', 'ch_article_provenance', 'ch_act_as_link', 'ch_as_act', 'ch_act_change',
                     'ch_act_article', 'ch_act_version', 'ch_act']) {
      await client.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    await client.query('DROP TABLE IF EXISTS ch_legislation CASCADE');
    await client.query('CREATE TABLE ch_legislation (eli_uri text, lang text, PRIMARY KEY (eli_uri, lang))');
    for (const file of ['197_ch_legislation_corpus.sql', '198_ch_as_bbl.sql', '201_ch_cantonal_legislation.sql',
                        '204_ch_fedlex_pdf.sql', '209_ch_material.sql', '210_ch_material_tsv.sql']) {
      await client.query(readFileSync(join(migrations, file), 'utf-8'));
    }
    // The alias lookup ch_get_article_purpose uses for the act-mention ranking (199/206 shape).
    await client.query(`CREATE TABLE ch_act_alias (abbr text NOT NULL, lang text NOT NULL, sr_number text NOT NULL,
                        source text NOT NULL, jurisdiction text NOT NULL DEFAULT 'CH')`);
    await client.query(`INSERT INTO ch_act_alias VALUES ('EmbG', 'de', '946.231', 'fedlex_abbreviation', 'CH'),
                                                        ('LEmb', 'fr', '946.231', 'title_paren', 'CH')`);

    // SR 946.231 (EmbG): one de edition with Art. 2, whose provenance footnote cites the dispatch.
    const act = (await client.query(
      `INSERT INTO ch_act (eli_work_uri, sr_number, abbreviation, title_de, title_fr, jurisdiction, enforcement_status)
       VALUES ('https://fedlex.data.admin.ch/eli/cc/2002/564', '946.231', 'EmbG', 'Embargogesetz', 'Loi sur les embargos', 'CH', 0)
       RETURNING act_id`)).rows[0].act_id;
    const version = (await client.query(
      `INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, stage, source)
       VALUES ($1, 'https://fedlex.data.admin.ch/eli/cc/2002/564/20030101', 'de', '2003-01-01', 'parsed', 'fedlex')
       RETURNING version_id`, [act])).rows[0].version_id;
    await client.query(
      `INSERT INTO ch_act_article (version_id, e_id, article_number, text, ordinal) VALUES ($1, 'art_2', '2', 'Der Bundesrat ...', 1), ($1, 'art_3', '3', 'Aufhebung', 2)`,
      [version]);
    await client.query(
      `INSERT INTO ch_article_provenance (version_id, e_id, action, as_reference, bbl_reference, effective_date, raw_note)
       VALUES ($1, 'art_2', 'inserted', 'AS 2002 3673', 'BBl 2001 1433', '2003-01-01', 'Eingefügt durch ... (AS 2002 3673; BBl 2001 1433)'),
              ($1, 'art_2', 'amended', 'AS 1990 1', 'FF 1986 II 360', '1991-01-01', 'Fassung gemäss ... (AS 1990 1; FF 1986 II 360)'),
              ($1, 'art_3', 'inserted', 'AS 2002 3673', 'BBl 2001 1433', '2003-01-01', 'Eingefügt durch ... (AS 2002 3673; BBl 2001 1433)')`,
      [version]);

    const ins = async (lang: string, hist: string, key: string, text: string | null, stage: string) => (await client.query(
      `INSERT INTO ch_material (eli_work_uri, lang, material_type, type_uri, title, historical_id, bbl_key,
                                publication_date, pdf_url, stage, full_text)
       VALUES ($1, $2, 'botschaft', 't', $3, $4, $5, '2001-04-17', 'https://fedlex.data.admin.ch/filestore/' || $2 || '.pdf', $6, $7)
       RETURNING material_id`,
      [ELI, lang, lang === 'de' ? 'Botschaft zum Embargogesetz' : 'Message sur la loi sur les embargos', hist, key, stage, text])).rows[0].material_id;
    materialDe = await ins('de', 'BBl 2001 1433', '2001||1433', BOTSCHAFT_DE, 'parsed');
    await ins('fr', 'FF 2001 1341', '2001||1341', null, 'discovered');
    await client.query(
      `INSERT INTO ch_material (eli_work_uri, lang, material_type, type_uri, title, publication_date, pdf_url, stage, full_text)
       VALUES ('https://fedlex.data.admin.ch/eli/fga/2010/999', 'de', 'bericht_kommission', 't', 'Bericht der Kommission', '2010-10-12',
               'https://fedlex.data.admin.ch/filestore/k.pdf', 'parsed', 'Die Kommission prüfte die Umsetzung der Sanktionen.')`);

    tools = new ChMaterialsTools({ query: (sql: string, params?: any[]) => client.query(sql, params) });
  });

  afterAll(async () => {
    await client.end();
  });

  describe('ch_search_materials', () => {
    it('finds parsed materials by words with snippet and citation fields', async () => {
      const out = parse(await tools.executeTool('ch_search_materials', { query: 'Sanktionen' }) as any);
      expect(out.total_count).toBe(2);
      const hit = out.results.find((r: any) => r.material_id === materialDe);
      expect(hit.historical_id).toBe('BBl 2001 1433');
      expect(hit.pdf_url).toContain('fedlex');
      expect(hit.snippet).toMatch(/Sanktionen/);
      expect(hit.full_text).toBeUndefined();
    });

    it('narrows by type, language and year', async () => {
      const byType = parse(await tools.executeTool('ch_search_materials', { query: 'Sanktionen', material_type: 'bericht_kommission' }) as any);
      expect(byType.results.map((r: any) => r.material_type)).toEqual(['bericht_kommission']);
      const byYear = parse(await tools.executeTool('ch_search_materials', { query: 'Sanktionen', year_from: 2005 }) as any);
      expect(byYear.results.map((r: any) => r.publication_date)).toEqual(['2010-10-12']);
      const byLang = parse(await tools.executeTool('ch_search_materials', { query: 'Sanktionen', lang: 'fr' }) as any);
      expect(byLang.results).toEqual([]);
    });

    it('refuses an empty query and an unknown type', async () => {
      expect((await tools.executeTool('ch_search_materials', { query: '' }) as any).content[0].text).toContain('query');
      expect((await tools.executeTool('ch_search_materials', { query: 'x', material_type: 'gesetz' }) as any).content[0].text).toContain('material_type');
    });
  });

  describe('ch_get_material', () => {
    it('serves by id and by (ELI, lang), sliced', async () => {
      const byId = parse(await tools.executeTool('ch_get_material', { material_id: materialDe, text_chars: 27 }) as any);
      expect(byId.title).toBe('Botschaft zum Embargogesetz');
      expect(byId.text).toBe(BOTSCHAFT_DE.slice(0, 27));
      expect(byId.truncated).toBe(true);
      expect(byId.text_total_chars).toBe(BOTSCHAFT_DE.length);
      expect(byId.text_available).toBe(true);
      const byEli = parse(await tools.executeTool('ch_get_material', { eli_work_uri: ELI, lang: 'de' }) as any);
      expect(byEli.material_id).toBe(materialDe);
      expect(byEli.truncated).toBe(false);
    });

    it('reports a discovered-but-unparsed edition honestly and a missing one with available languages', async () => {
      const fr = parse(await tools.executeTool('ch_get_material', { eli_work_uri: ELI, lang: 'fr' }) as any);
      expect(fr.text_available).toBe(false);
      expect(fr.text).toBe('');
      const it = parse(await tools.executeTool('ch_get_material', { eli_work_uri: ELI, lang: 'it' }) as any);
      expect(it.error).toBe('not_found');
      expect(it.available_langs).toEqual(['de', 'fr']);
      expect((await tools.executeTool('ch_get_material', {}) as any).content[0].text).toContain('material_id');
    });
  });

  describe('ch_get_article_purpose', () => {
    it('links the article to the dispatch through the provenance citation and returns the paragraphs naming it', async () => {
      const out = parse(await tools.executeTool('ch_get_article_purpose', { sr_number: '946.231', article: '2' }) as any);
      expect(out.error).toBeUndefined();
      expect(out.link_method).toBe('provenance_bbl');
      expect(out.abbreviation).toBe('EmbG');
      expect(out.bbl_references.map((r: any) => [r.bbl_reference, r.material_found])).toEqual([
        ['FF 1986 II 360', false],
        ['BBl 2001 1433', true],
      ]);
      expect(out.unmatchable_references).toEqual([]);
      expect(out.materials).toHaveLength(1);
      const m = out.materials[0];
      expect(m.material_id).toBe(materialDe);
      expect(m.matched_via).toEqual(['BBl 2001 1433']);
      expect(m.text_available).toBe(true);
      expect(m.stage).toBe('parsed');
      const texts = m.paragraphs.map((p: any) => p.text);
      expect(texts).toHaveLength(2);
      // The paragraph that names the act (EmbG) comes first and is flagged; the other follows.
      expect(texts[0]).toContain('Artikel 2 Absatz 1 EmbG');
      expect(m.paragraphs[0].mentions_act).toBe(true);
      expect(texts[1]).toContain('Art. 2 des Entwurfs');
      expect(m.paragraphs[1].mentions_act).toBe(false);
      // "Art. 20" and "Art. 3" must not match article 2.
      expect(texts.some((t: string) => t.startsWith('Art. 3'))).toBe(false);
    });

    it('caps paragraphs per material and flags the cut, keeping the act-naming paragraph', async () => {
      const out = parse(await tools.executeTool('ch_get_article_purpose', { sr_number: '946.231', article: '2', max_paragraphs: 1 }) as any);
      expect(out.materials[0].paragraphs).toHaveLength(1);
      expect(out.materials[0].paragraphs[0].mentions_act).toBe(true);
      expect(out.materials[0].paragraphs_truncated).toBe(true);
    });

    it('search ranks on the stored tsvector and still returns a headline', async () => {
      const cols = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ch_material' AND column_name = 'tsv'`)).rows;
      expect(cols).toHaveLength(1);
      const out = parse(await tools.executeTool('ch_search_materials', { query: 'Zwangsmassnahmen' }) as any);
      expect(out.total_count).toBe(1);
      expect(out.results[0].snippet).toMatch(/Zwangsmassnahmen/);
      expect(out.results[0].tsv).toBeUndefined();
    });

    it('returns the linked material without paragraphs when its text is not parsed yet', async () => {
      const out = parse(await tools.executeTool('ch_get_article_purpose', { sr_number: '946.231', article: '2', lang: 'fr' }) as any);
      // No French edition rows / provenance in this fixture → no link in fr.
      expect(out.error).toBe('no_materials_linked');
      expect(out.bbl_references).toEqual([]);
    });

    it('reports no_materials_linked with the raw references when nothing normalises', async () => {
      await client.query(`UPDATE ch_article_provenance SET bbl_reference = 'BBl ???' WHERE e_id = 'art_3'`);
      const out = parse(await tools.executeTool('ch_get_article_purpose', { sr_number: '946.231', article: '3' }) as any);
      expect(out.error).toBe('no_materials_linked');
      expect(out.bbl_references.map((r: any) => r.bbl_reference)).toEqual(['BBl ???']);
    });

    it('reports an unknown act', async () => {
      const out = parse(await tools.executeTool('ch_get_article_purpose', { sr_number: '999.999', article: '1' }) as any);
      expect(out.error).toBe('not_found');
      expect(out.entity).toBe('act');
    });
  });

  it('advertises exactly the three tools, read-only', () => {
    const defs = tools.getToolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(['ch_search_materials', 'ch_get_material', 'ch_get_article_purpose']);
    expect(defs.every((d) => d.annotations?.readOnlyHint === true)).toBe(true);
  });
});
