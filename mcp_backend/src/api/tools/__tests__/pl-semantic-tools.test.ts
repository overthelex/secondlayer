/**
 * Unit tests for pl_semantic_search: filter construction, the collapses (decision chunks → one
 * per decision id; legislation → one per article / per PDF-only act; procurement → one per
 * notice) and input validation. TEI and Qdrant are mocked — no network.
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

import { PlSemanticTools } from '../pl-semantic-tools.js';
import { V2_TOOL_NAMES } from '../../curated-mcp-tools.js';

const VEC = new Array(1024).fill(0.01);

const decision = (id: string, score: number, chunk = 0) => ({
  score,
  payload: {
    doc_type: 'pl_decision', decision_id: id, chunk_index: chunk, text: `text of ${id} c${chunk}`,
    court_type: 'SUPREME', case_number: 'I CSK 1/20', decision_type: 'SENTENCE', decision_date: '2020-01-01',
    ecli: null,
  },
});

const article = (snap: string, artNo: string, score: number) => ({
  score,
  payload: {
    doc_type: 'pl_article', act_eli: snap, snapshot_eli: snap, art_no: artNo, art_display: `Art. ${artNo}.`,
    title: 'Kodeks cywilny', act_type: 'Ustawa', is_current: true, text: `art ${artNo}`,
  },
});

const parse = (r: any) => {
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
};
const filterOf = (call: number) => mockSearch.mock.calls[call][1].filter.must;

describe('pl_semantic_search', () => {
  let tool: PlSemanticTools;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEmbed.mockResolvedValue(VEC);
    tool = new PlSemanticTools({} as any);
  });

  it('is a read-only curated tool with a Ukrainian description', () => {
    const [def] = tool.getToolDefinitions();
    expect(def.name).toBe('pl_semantic_search');
    expect(def.annotations?.readOnlyHint).toBe(true);
    expect(/[Ѐ-ӿ]/.test(def.description)).toBe(true);
    expect(V2_TOOL_NAMES.has('pl_semantic_search')).toBe(true);
  });

  it('returns null for other tool names', async () => {
    expect(await tool.executeTool('pl_get_act', {})).toBeNull();
  });

  it('rejects empty query, bad scope, court_type and dates without calling Qdrant', async () => {
    for (const args of [
      { query: '  ' },
      { query: 'x', scope: 'everything' },
      { query: 'x', court_type: 'tax' },
      { query: 'x', date_from: '01.02.2020' },
    ]) {
      const r = await tool.executeTool('pl_semantic_search', args);
      expect(typeof parse(r)).toBe('string');
    }
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('collapses decision chunks to one hit per decision and applies court/date filters', async () => {
    mockSearch.mockResolvedValueOnce([
      decision('saos-1', 0.7, 0), decision('saos-1', 0.9, 3), decision('saos-2', 0.8),
    ]);
    const r = parse(await tool.executeTool('pl_semantic_search', {
      query: 'zachowek', scope: 'decisions', court_type: 'supreme', date_from: '2019-01-01', date_to: '2021-12-31', limit: 5,
    }));
    expect(r.decisions.map((d: any) => d.id)).toEqual(['saos-1', 'saos-2']);
    expect(r.decisions[0].similarity).toBe(0.9);
    expect(r.decisions[0].excerpt).toBe('text of saos-1 c3');
    expect(r.decisions[0]).not.toHaveProperty('ecli');
    expect(r).not.toHaveProperty('legislation');
    const must = filterOf(0);
    expect(must).toContainEqual({ key: 'doc_type', match: { value: 'pl_decision' } });
    expect(must).toContainEqual({ key: 'court_type', match: { any: ['SUPREME'] } });
    expect(must).toContainEqual({
      key: 'decision_date', range: { gte: '2019-01-01T00:00:00Z', lte: '2021-12-31T23:59:59Z' },
    });
    expect(mockSearch.mock.calls[0][1].limit).toBe(40);
  });

  it('strips SAOS HTML from excerpts, including a tag cut at the window edges', async () => {
    const d = decision('saos-7', 0.9);
    d.payload.text = 'lass="anon-block">A. K.</span> wniosła pozew.</p> <p>Sąd <strong>zważył</strong>, co następuje <span cla';
    mockSearch.mockResolvedValueOnce([d]);
    const r = parse(await tool.executeTool('pl_semantic_search', { query: 'pozew', scope: 'decisions' }));
    expect(r.decisions[0].excerpt).toBe('A. K. wniosła pozew. Sąd zważył , co następuje');
  });

  it('leaves plain-text excerpts with a ">" untouched', async () => {
    const d = decision('saos-8', 0.9);
    d.payload.text = 'kwota > 500 zł';
    mockSearch.mockResolvedValueOnce([d]);
    const r = parse(await tool.executeTool('pl_semantic_search', { query: 'x', scope: 'decisions' }));
    expect(r.decisions[0].excerpt).toBe('kwota > 500 zł');
  });

  it('searches decisions and current legislation for scope=all, one hit per article', async () => {
    mockSearch.mockImplementation(async (_c: string, req: any) => {
      const dt = req.filter.must[0].match;
      if (dt.value === 'pl_decision') return [decision('saos-9', 0.6)];
      return [
        article('DU/1964/93', '991', 0.8), article('DU/1964/93', '991', 0.75), article('DU/1964/93', '1000', 0.7),
        { score: 0.65, payload: { doc_type: 'pl_act_text', act_eli: 'DU/2025/1', snapshot_eli: 'DU/2025/1', is_current: true, text: 'pdf' } },
      ];
    });
    const r = parse(await tool.executeTool('pl_semantic_search', { query: 'zachowek' }));
    expect(r.decisions).toHaveLength(1);
    expect(r.legislation.map((l: any) => l.art_no ?? l.act_eli)).toEqual(['991', '1000', 'DU/2025/1']);
    expect(r.legislation[2].whole_act_text).toBe(true);
    const legMust = mockSearch.mock.calls.find((c: any) => c[1].filter.must[0].match.any)[1].filter.must;
    expect(legMust).toContainEqual({ key: 'is_current', match: { value: true } });
  });

  it('searches only BZP for scope=procurement', async () => {
    mockSearch.mockResolvedValueOnce([
      { score: 0.8, payload: { doc_type: 'pl_bzp', object_id: 'abc', organization_name: 'Gmina X', text: 'Budowa drogi' } },
    ]);
    const r = parse(await tool.executeTool('pl_semantic_search', { query: 'road construction', scope: 'procurement' }));
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(filterOf(0)).toEqual([{ key: 'doc_type', match: { value: 'pl_bzp' } }]);
    expect(r.procurement[0].object_id).toBe('abc');
    expect(r).not.toHaveProperty('decisions');
  });

  it('says nothing was found on empty results and reports backend errors', async () => {
    mockSearch.mockResolvedValue([]);
    expect(parse(await tool.executeTool('pl_semantic_search', { query: 'x' }))).toMatch(/Нічого/);
    mockSearch.mockRejectedValue(new Error('qdrant down'));
    const r: any = await tool.executeTool('pl_semantic_search', { query: 'x' });
    expect(r.isError).toBe(true);
  });
});
