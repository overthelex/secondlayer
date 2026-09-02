/**
 * Integration tests for ChCommentaryTools against a real PostgreSQL.
 *
 * A mocked db.query cannot validate SQL: the tsvector expression must match the
 * expression migration 208 indexes, the substr slice and COUNT(*) OVER() only fail at
 * the server. Set CH_TEST_DATABASE_URL to run; skipped otherwise.
 *
 *   CH_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55499/ch_tools_test npx jest ch-commentary-tools.pg
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ChCommentaryTools } from '../ch-commentary-tools';

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

const LONG_TEXT = 'I. Einleitung\n' + 'Die Fintech-Lizenz nach Art. 1b BankG erlaubt Publikumseinlagen bis 100 Millionen Franken. '.repeat(40);

describeIfPg('ChCommentaryTools (real PostgreSQL)', () => {
  let client: Client;
  let tools: ChCommentaryTools;

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();
    await client.query('DROP TABLE IF EXISTS ch_commentary');
    await client.query(readFileSync(join(__dirname, '../../../migrations/208_ch_commentary.sql'), 'utf-8'));

    const rows = [
      // (source_id, lang, kind, sr, abbr, article, title, text, version_date)
      ['de-1b', 'de', 'article', '952.0', 'BankG', '1b', 'Art. 1b BankG', LONG_TEXT, '2026-08-23'],
      ['fr-1b', 'fr', 'article', '952.0', 'LB', '1b', 'Art. 1b LB', 'Introduction\nLa licence fintech selon l\'art. 1b LB.', '2026-08-23'],
      ['de-9', 'de', 'article', '955.0', 'GwG', '9', 'Art. 9 GwG', 'Meldepflicht bei Geldwäschereiverdacht.', '2026-07-29'],
      ['de-vorb', 'de', 'preliminary', '642.14', 'StHG', null, 'Vorb. zu Art. 13-14a StHG', 'Vorbemerkungen zur Vermögenssteuer.', '2025-01-01'],
      ['de-orphan', 'de', 'article', null, 'XYZ', '3', 'Art. 3 XYZ', 'Ein Text ohne aufgelösten Erlass, Fintech-Lizenz erwähnt.', '2025-01-01'],
    ];
    for (const [sid, lang, kind, sr, abbr, art, title, text, date] of rows) {
      await client.query(
        `INSERT INTO ch_commentary (source, source_id, lang, kind, sr_number, act_uuid, act_title, abbr,
                                    article_number, title, authors, editors, version_date, suggested_citation,
                                    content_html, content_text, legal_text, licence, source_url, pdf_url, content_hash)
         VALUES ('onlinekommentar', $1, $2, $3, $4, 'uuid', 'Some Act', $5, $6, $7,
                 ARRAY['Tamara Teves','David Meirich'], ARRAY['Nina Reiser'], $8, 'OK-Teves/Meirich, Art. 1b BankG N. XXX',
                 '<p>' || $9 || '</p>', $9, 'Art. 1b ...', 'CC-BY-4.0', 'https://onlinekommentar.ch/de/kommentare/' || $1,
                 'https://onlinekommentar.ch/de/kommentare/' || $1 || '/print', 'h-' || $1)`,
        [sid, lang, kind, sr, abbr, art, title, date, text]
      );
    }
    tools = new ChCommentaryTools({ query: (sql: string, params?: any[]) => client.query(sql, params) });
  });

  afterAll(async () => {
    await client.end();
  });

  describe('ch_get_commentary', () => {
    it('returns the commentary of one article with attribution and a full slice', async () => {
      const out = parse(await tools.executeTool('ch_get_commentary', { sr_number: '952.0', article: '1b' }) as any);
      expect(out.error).toBeUndefined();
      expect(out.lang).toBe('de');
      expect(out.title).toBe('Art. 1b BankG');
      expect(out.authors).toEqual(['Tamara Teves', 'David Meirich']);
      expect(out.version_date).toBe('2026-08-23');
      expect(out.licence).toBe('CC-BY-4.0');
      expect(out.source_url).toContain('onlinekommentar.ch');
      expect(out.attribution).toContain('CC-BY-4.0');
      expect(out.attribution).toContain('OK-Teves/Meirich');
      expect(out.text).toBe(LONG_TEXT);
      expect(out.text_total_chars).toBe(LONG_TEXT.length);
      expect(out.truncated).toBe(false);
      expect(out.legal_text).toBe('Art. 1b ...');
      expect(out.content_html).toBeUndefined();
    });

    it('slices the text by text_offset / text_chars and reports truncation', async () => {
      const out = parse(await tools.executeTool('ch_get_commentary', {
        sr_number: '952.0', article: '1b', text_offset: 3, text_chars: 10,
      }) as any);
      expect(out.text).toBe(LONG_TEXT.slice(3, 13));
      expect(out.text_offset).toBe(3);
      expect(out.truncated).toBe(true);
      expect(out.text_total_chars).toBe(LONG_TEXT.length);
    });

    it('serves another language of the same article', async () => {
      const out = parse(await tools.executeTool('ch_get_commentary', { sr_number: '952.0', article: '1b', lang: 'fr' }) as any);
      expect(out.title).toBe('Art. 1b LB');
      expect(out.lang).toBe('fr');
    });

    it('reports not_found with the languages and articles that do exist', async () => {
      const out = parse(await tools.executeTool('ch_get_commentary', { sr_number: '952.0', article: '1b', lang: 'it' }) as any);
      expect(out.error).toBe('not_found');
      expect(out.available_langs.sort()).toEqual(['de', 'fr']);
      const other = parse(await tools.executeTool('ch_get_commentary', { sr_number: '952.0', article: '7' }) as any);
      expect(other.error).toBe('not_found');
      expect(other.available_articles).toEqual(['1b']);
    });

    it('does not serve a preliminary remark as an article commentary', async () => {
      const out = parse(await tools.executeTool('ch_get_commentary', { sr_number: '642.14', article: '13' }) as any);
      expect(out.error).toBe('not_found');
    });

    it('rejects a missing sr_number / article and an unknown lang', async () => {
      expect((await tools.executeTool('ch_get_commentary', { article: '1b' }) as any).content[0].text).toContain('sr_number');
      expect((await tools.executeTool('ch_get_commentary', { sr_number: '952.0' }) as any).content[0].text).toContain('article');
      expect((await tools.executeTool('ch_get_commentary', { sr_number: '952.0', article: '1b', lang: 'rm' }) as any).content[0].text).toContain('lang');
    });
  });

  describe('ch_search_commentary', () => {
    it('finds by words in the text across languages, with snippet and attribution fields', async () => {
      const out = parse(await tools.executeTool('ch_search_commentary', { query: 'Fintech-Lizenz' }) as any);
      expect(out.total_count).toBe(2);
      const ids = out.results.map((r: any) => r.source_id).sort();
      expect(ids).toEqual(['de-1b', 'de-orphan']);
      const hit = out.results.find((r: any) => r.source_id === 'de-1b');
      expect(hit.snippet).toMatch(/Fintech/);
      expect(hit.licence).toBe('CC-BY-4.0');
      expect(hit.source_url).toContain('onlinekommentar.ch');
      expect(hit.content_text).toBeUndefined();
      expect(hit._total_count).toBeUndefined();
    });

    it('narrows to an act and a language', async () => {
      const bySr = parse(await tools.executeTool('ch_search_commentary', { query: 'Fintech-Lizenz', sr_number: '952.0' }) as any);
      expect(bySr.results.map((r: any) => r.source_id)).toEqual(['de-1b']);
      const byLang = parse(await tools.executeTool('ch_search_commentary', { query: 'licence fintech', lang: 'fr' }) as any);
      expect(byLang.results.map((r: any) => r.source_id)).toEqual(['fr-1b']);
    });

    it('pages with limit and offset', async () => {
      const first = parse(await tools.executeTool('ch_search_commentary', { query: 'Fintech-Lizenz', limit: 1 }) as any);
      expect(first.results).toHaveLength(1);
      expect(first.has_more).toBe(true);
      const second = parse(await tools.executeTool('ch_search_commentary', { query: 'Fintech-Lizenz', limit: 1, offset: 1 }) as any);
      expect(second.results).toHaveLength(1);
      expect(second.has_more).toBe(false);
      expect(second.results[0].source_id).not.toBe(first.results[0].source_id);
    });

    it('returns an empty page for no match and refuses an empty query', async () => {
      const none = parse(await tools.executeTool('ch_search_commentary', { query: 'zzzz-nothing' }) as any);
      expect(none.results).toEqual([]);
      expect(none.total_count).toBe(0);
      expect((await tools.executeTool('ch_search_commentary', { query: ' ' }) as any).content[0].text).toContain('query');
    });
  });

  it('advertises exactly the two tools, read-only', () => {
    const defs = tools.getToolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(['ch_get_commentary', 'ch_search_commentary']);
    expect(defs.every((d) => d.annotations?.readOnlyHint === true)).toBe(true);
  });
});
