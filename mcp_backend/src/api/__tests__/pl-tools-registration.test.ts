/** Registration and pure-helper tests for the Polish tool surface. */

import { PlRegistryTools } from '../tools/pl-registry-tools.js';
import { PlLegalTools, pickSnapshot } from '../tools/pl-legal-tools.js';
import {
  htmlToText, identifierDigits, isoDate, nameVariants, normalizeArticle, pageOf, plainText, runSearchQuery, sliceText,
  toTsQuery, wordForms,
} from '../tools/pl-tool-utils.js';
import { V2_TOOL_NAMES } from '../curated-mcp-tools.js';
import { isToolInToolset } from '../mcp-toolset.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const stubDb = {} as any;
const defs = [...new PlRegistryTools(stubDb).getToolDefinitions(), ...new PlLegalTools(stubDb).getToolDefinitions()];

describe('PL tool surface', () => {
  it('exposes 15 uniquely named pl_* tools in the curated set', () => {
    expect(defs).toHaveLength(15);
    expect(new Set(defs.map((d) => d.name)).size).toBe(15);
    for (const d of defs) {
      expect(d.name.startsWith('pl_')).toBe(true);
      expect(V2_TOOL_NAMES.has(d.name)).toBe(true);
      expect(/[Ѐ-ӿ]/.test(d.description)).toBe(true);
      expect(d.inputSchema.type).toBe('object');
      expect(d.annotations?.readOnlyHint).toBe(true);
    }
  });

  describe('MCP_TOOLSET gate', () => {
    const saved = process.env.MCP_TOOLSET;
    afterEach(() => {
      if (saved === undefined) delete process.env.MCP_TOOLSET; else process.env.MCP_TOOLSET = saved;
    });

    it.each(['ua', 'ch', 'uk', 'ch,uk'])('hides pl_* on MCP_TOOLSET=%s', (value) => {
      process.env.MCP_TOOLSET = value;
      expect(isToolInToolset('pl_search_companies')).toBe(false);
    });

    it('serves pl_* on all, and only pl_* on pl', () => {
      process.env.MCP_TOOLSET = 'all';
      expect(isToolInToolset('pl_search_companies')).toBe(true);
      process.env.MCP_TOOLSET = 'pl';
      expect(isToolInToolset('pl_get_act')).toBe(true);
      expect(isToolInToolset('search_registry')).toBe(false);
      expect(isToolInToolset('ch_get_company')).toBe(false);
    });

    it('still serves the Ukrainian tools on ua', () => {
      process.env.MCP_TOOLSET = 'ua';
      expect(isToolInToolset('search_registry')).toBe(true);
    });
  });
});

describe('PL helpers', () => {
  it('normalises the ways an article number is written', () => {
    expect(normalizeArticle('415')).toBe('415');
    expect(normalizeArticle('art. 415')).toBe('415');
    expect(normalizeArticle('Art 22¹')).toBe('22^1');
    expect(normalizeArticle('22(1)')).toBe('22^1');
    expect(normalizeArticle('art. 43^5.')).toBe('43^5');
  });

  it('builds the name renderings SLPS uses', () => {
    expect(nameVariants('joanna  sawicz')).toEqual(['joanna sawicz', 'JOANNA SAWICZ', 'Joanna Sawicz']);
    expect(nameVariants('Anna Nowak-Łącka')).toContain('ANNA NOWAK-ŁĄCKA');
  });

  it('reads identifiers and dates strictly', () => {
    expect(identifierDigits('PL 527-282-56-16')).toBe('5272825616');
    expect(identifierDigits('Orlen 1')).toBeNull();
    expect(isoDate('2024-02-30')).toBeNull();
    expect(isoDate('2024-02-29')).toBe('2024-02-29');
  });

  it('clamps paging', () => {
    expect(pageOf({ limit: 500, offset: 5000 })).toEqual({ limit: 50, offset: 1000 });
    expect(pageOf({})).toEqual({ limit: 20, offset: 0 });
  });

  it('pages a long text', () => {
    expect(sliceText('abcdef', 2, 2)).toEqual({ text: 'cd', text_offset: 2, total_chars: 6, next_text_offset: 4 });
    expect(sliceText('abcdef', 4, 2).next_text_offset).toBeNull();
  });

  it('turns notice HTML into text', () => {
    expect(htmlToText('<p>a &amp; b</p><style>x{}</style><div>c</div>')).toBe('a & b\n c'.replace('\n ', '\n'));
  });

  it('strips a judgment stored as HTML and leaves plain text alone', () => {
    expect(plainText('<p>\n<strong><!-- -->Sygn. akt</strong></p>')).toBe('Sygn. akt');
    expect(plainText('kwota x < y oraz <brak>')).toBe('kwota x < y oraz <brak>');
  });
});

describe('pickSnapshot', () => {
  const snap = (eli: string, on: string, articles: number) => ({
    snapshot_eli: eli, seq: 0, snapshot_kind: 'jednolity', exact_on: on, valid_to: null,
    amendments_after: 0, http_status: articles ? 200 : 903, article_count: articles, n_chars: 0, has_text: false,
  });
  const rows = [snap('c', '2026-05-19', 0), snap('b', '2024-06-19', 10), snap('a', '2020-01-01', 10)];
  const segmented = (s: { article_count: number | null }) => (s.article_count ?? 0) > 0;

  it('reports newer editions it had to skip', () => {
    const r = pickSnapshot(rows, null, segmented);
    expect(r.chosen?.snapshot_eli).toBe('b');
    expect(r.skipped.map((s) => s.snapshot_eli)).toEqual(['c']);
  });

  it('honours the date', () => {
    const r = pickSnapshot(rows, '2021-01-01', segmented);
    expect(r.chosen?.snapshot_eli).toBe('a');
    expect(r.skipped).toEqual([]);
  });

  it('finds nothing before the first edition', () => {
    expect(pickSnapshot(rows, '2019-01-01', segmented).chosen).toBeNull();
  });
});

describe('PL word forms', () => {
  const dbWith = (rows: any[]) => {
    const client = { query: jest.fn().mockResolvedValue({ rows }) };
    return { client, db: { transaction: (fn: any) => fn(client) } };
  };

  it('joins forms with OR and words with AND', () => {
    expect(toTsQuery([
      { word: 'umowa', forms: ['umowa', 'umowy'] },
      { word: 'praca', forms: ['praca'] },
    ])).toBe("('umowa' | 'umowy') & ('praca')");
  });

  it('quotes characters that are special in a tsquery', () => {
    expect(toTsQuery([{ word: "o'a\\b", forms: ["o'a\\b"] }])).toBe("('o''a\\\\b')");
  });

  it('is empty without words', () => {
    expect(toTsQuery([])).toBe('');
  });

  it('keeps a word the dictionary does not know', async () => {
    const { db } = dbWith([{ word: 'xyz', forms: [] }, { word: 'umowy', forms: ['umowa', 'umowy'] }]);
    await expect(wordForms(db, 'xyz umowy')).resolves.toEqual([
      { word: 'xyz', forms: ['xyz'] },
      { word: 'umowy', forms: ['umowy', 'umowa'] },
    ]);
  });

  it('turns the date index off for a search', async () => {
    const { client, db } = dbWith([]);
    await runSearchQuery(db, 'SELECT 1', []);
    expect(client.query.mock.calls.map((c: any[]) => c[0])).toEqual([
      expect.stringContaining('statement_timeout'),
      'SET LOCAL enable_indexscan = off',
      'SELECT 1',
    ]);
  });
});
