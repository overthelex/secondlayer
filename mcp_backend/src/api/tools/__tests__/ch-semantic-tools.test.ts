/**
 * Unit tests for ch_semantic_search: filter construction, the two collapses
 * (decision chunks → one hit per ECLI; article hits → one per act/eId), and
 * input validation. TEI and Qdrant are mocked — no network.
 */

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const mockEmbed = jest.fn();
jest.mock('../../../utils/bge-m3-client.js', () => ({
  BgeM3Client: jest.fn().mockImplementation(() => ({ generateEmbedding: mockEmbed })),
}));

const mockSearch = jest.fn();
jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({ search: mockSearch })),
}));

import { ChSemanticTools } from '../ch-semantic-tools.js';

const VEC = new Array(1024).fill(0.01);

function decisionHit(ecli: string, score: number, chunk = 0, extra: any = {}) {
  return {
    score,
    payload: {
      doc_type: 'ch_decision', ecli, chunk_index: chunk, text: `text of ${ecli} c${chunk}`,
      court_code: 'CH_BGer_001', canton: 'CH', language: 'de', decision_date: '2020-01-01',
      ...extra,
    },
  };
}

function articleHit(actId: number, eId: string, score: number, extra: any = {}) {
  return {
    score,
    payload: {
      doc_type: 'ch_article', act_id: actId, e_id: eId, article_number: '457', lang: 'fr',
      sr_number: '220', jurisdiction: 'CH', is_current: true, text: `art ${eId} of ${actId}`,
      ...extra,
    },
  };
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('ch_semantic_search', () => {
  let tool: ChSemanticTools;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEmbed.mockResolvedValue(VEC);
    tool = new ChSemanticTools({} as any);
  });

  it('returns null for other tool names', async () => {
    expect(await tool.executeTool('ch_search_legislation', {})).toBeNull();
  });

  it('rejects an empty query without touching the network', async () => {
    const res: any = await tool.executeTool('ch_semantic_search', { query: '  ' });
    expect(res.content[0].text).toMatch(/Provide query/);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('rejects a bad canton code', async () => {
    const res: any = await tool.executeTool('ch_semantic_search', { query: 'q', canton: 'Zurich' });
    expect(res.content[0].text).toMatch(/two-letter/);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('embeds once and runs both searches for scope=all, with the right filters', async () => {
    mockSearch.mockResolvedValue([]);
    await tool.executeTool('ch_semantic_search', { query: 'haftung', lang: 'fr', canton: 'zh' });

    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledTimes(2);
    const filters = mockSearch.mock.calls.map(c => c[1].filter.must);
    const decMust = filters.find(m => m.some((x: any) => x.match?.value === 'ch_decision'))!;
    const artMust = filters.find(m => m.some((x: any) => x.match?.value === 'ch_article'))!;
    // decisions: language + canton keys; canton uppercased
    expect(decMust).toContainEqual({ key: 'language', match: { value: 'fr' } });
    expect(decMust).toContainEqual({ key: 'canton', match: { value: 'ZH' } });
    // articles: lang + jurisdiction keys, and current editions only
    expect(artMust).toContainEqual({ key: 'lang', match: { value: 'fr' } });
    expect(artMust).toContainEqual({ key: 'jurisdiction', match: { value: 'ZH' } });
    expect(artMust).toContainEqual({ key: 'is_current', match: { value: true } });
  });

  it('scope=decisions runs a single search', async () => {
    mockSearch.mockResolvedValue([]);
    await tool.executeTool('ch_semantic_search', { query: 'q', scope: 'decisions' });
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch.mock.calls[0][1].filter.must).toContainEqual({
      key: 'doc_type', match: { value: 'ch_decision' },
    });
  });

  it('collapses decision chunks to one hit per ECLI keeping the best fragment', async () => {
    mockSearch.mockImplementation(async (_c: string, req: any) => {
      const isDecisions = req.filter.must.some((x: any) => x.match?.value === 'ch_decision');
      if (!isDecisions) return [];
      return [
        decisionHit('ECLI:CH:A', 0.9, 3),
        decisionHit('ECLI:CH:B', 0.8),
        decisionHit('ECLI:CH:A', 0.7, 9),
      ];
    });
    const out = parse(await tool.executeTool('ch_semantic_search', { query: 'q' }));
    expect(out.decisions.map((d: any) => d.ecli)).toEqual(['ECLI:CH:A', 'ECLI:CH:B']);
    expect(out.decisions[0].similarity).toBe(0.9);
    expect(out.decisions[0].excerpt).toContain('c3');
  });

  it('collapses articles across languages of the same act/eId', async () => {
    mockSearch.mockImplementation(async (_c: string, req: any) => {
      const isArticles = req.filter.must.some((x: any) => x.match?.value === 'ch_article');
      if (!isArticles) return [];
      return [
        articleHit(11, 'art_457', 0.95, { lang: 'fr' }),
        articleHit(11, 'art_457', 0.94, { lang: 'de' }),
        articleHit(12, 'art_1', 0.9),
      ];
    });
    const out = parse(await tool.executeTool('ch_semantic_search', { query: 'q' }));
    expect(out.legislation).toHaveLength(2);
    expect(out.legislation[0].lang).toBe('fr');
    expect(out.legislation[0].similarity).toBe(0.95);
  });

  it('reports emptiness when both legs return nothing', async () => {
    mockSearch.mockResolvedValue([]);
    const res: any = await tool.executeTool('ch_semantic_search', { query: 'q' });
    expect(res.content[0].text).toMatch(/Nothing relevant/);
  });

  it('wraps transport errors', async () => {
    mockSearch.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res: any = await tool.executeTool('ch_semantic_search', { query: 'q' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Semantic search failed/);
  });
});
