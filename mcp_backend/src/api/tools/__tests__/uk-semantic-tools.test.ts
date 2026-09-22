/**
 * Unit tests for uk_semantic_search: the collapse of many chunks onto one wording,
 * shared wording reported as also_in, hits that resolve to nothing dropped and counted,
 * and input validation. TEI, Qdrant and the database are mocked — no network.
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

import { UkSemanticTools } from '../uk-semantic-tools.js';

const VEC = new Array(1024).fill(0.01);

function hit(hash: string, score: number, chunk = 0) {
  return { score, payload: { text_hash: hash, chunk_ord: chunk } };
}

function row(hash: string, legId: string, extra: any = {}) {
  return {
    text_hash: hash,
    leg_id: legId,
    ord: 12,
    valid_from: '2021-06-24',
    provision_label: 'regulation 12',
    provision_type: 'regulation',
    provision_title: 'Consultation',
    act_title: 'The Control of Advertisements Regulations',
    leg_type: legId.split('/')[0],
    year: 2007,
    n_chars: 420,
    snippet: 'Before granting an express consent, the local planning authority shall consult—',
    also_in: 0,
    ...extra,
  };
}

function toolsWith(rows: any[]) {
  const db = { query: jest.fn().mockResolvedValue({ rows }) };
  return { tools: new UkSemanticTools(db), db };
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbed.mockResolvedValue(VEC);
});

describe('uk_semantic_search', () => {
  it('asks for a query instead of searching for nothing', async () => {
    const { tools } = toolsWith([]);
    const out: any = await tools.executeTool('uk_semantic_search', { query: '   ' });
    expect(out.content[0].text).toContain('Provide query');
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('rejects a leg_type that cannot be one', async () => {
    const { tools } = toolsWith([]);
    const out: any = await tools.executeTool('uk_semantic_search', {
      query: 'duty to consult', leg_type: 'Companies Act 2006',
    });
    expect(out.content[0].text).toContain('leg_type');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('collapses several chunks of one wording into a single result', async () => {
    mockSearch.mockResolvedValue([
      hit('aa', 0.71, 0), hit('aa', 0.75, 1), hit('aa', 0.68, 2),
    ]);
    const { tools } = toolsWith([row('aa', 'uksi/2007/783')]);
    const out = parse(await tools.executeTool('uk_semantic_search', { query: 'consultation' }));
    expect(out.results).toHaveLength(1);
    // the best chunk wins, not the first one seen
    expect(out.results[0].score).toBeCloseTo(0.75, 4);
  });

  it('reports shared wording as also_in rather than as separate results', async () => {
    mockSearch.mockResolvedValue([hit('bb', 0.9)]);
    const { tools } = toolsWith([
      row('bb', 'ukpga/2003/1', { also_in: 1 }),
      row('bb', 'ukpga/2008/9', { also_in: 1 }),
    ]);
    const out = parse(await tools.executeTool('uk_semantic_search', { query: 'steel' }));
    expect(out.results).toHaveLength(1);
    expect(out.results[0].also_in).toBe(1);
  });

  it('drops a hit that resolves to no provision and says how many', async () => {
    mockSearch.mockResolvedValue([hit('live', 0.8), hit('stale', 0.79)]);
    const { tools } = toolsWith([row('live', 'uksi/1992/666')]);
    const out = parse(await tools.executeTool('uk_semantic_search', { query: 'consent' }));
    expect(out.results).toHaveLength(1);
    expect(out.results[0].leg_id).toBe('uksi/1992/666');
    expect(out.stale_hits_dropped).toBe(1);
  });

  it('orders by score and honours the limit', async () => {
    mockSearch.mockResolvedValue([hit('low', 0.40), hit('high', 0.95), hit('mid', 0.70)]);
    const { tools } = toolsWith([
      row('low', 'uksi/1/1'), row('high', 'uksi/2/2'), row('mid', 'uksi/3/3'),
    ]);
    const out = parse(await tools.executeTool('uk_semantic_search', { query: 'x', limit: 2 }));
    expect(out.results.map((r: any) => r.leg_id)).toEqual(['uksi/2/2', 'uksi/3/3']);
  });

  it('passes leg_type to the query and explains an empty narrowed result', async () => {
    mockSearch.mockResolvedValue([hit('aa', 0.8)]);
    const { tools, db } = toolsWith([]);
    const out = parse(await tools.executeTool('uk_semantic_search', {
      query: 'consultation', leg_type: 'ukpga',
    }));
    expect(db.query.mock.calls[0][1]).toContain('ukpga');
    expect(out.note).toContain('ukpga');
    expect(out.results).toEqual([]);
  });

  it('marks a snippet as truncated when the provision is longer', async () => {
    mockSearch.mockResolvedValue([hit('aa', 0.8)]);
    const { tools } = toolsWith([row('aa', 'uksi/2007/783', { n_chars: 5000 })]);
    const out = parse(await tools.executeTool('uk_semantic_search', { query: 'consultation' }));
    expect(out.results[0].truncated).toBe(true);
  });

  it('reports a failed backend as an error rather than an empty result', async () => {
    mockSearch.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { tools } = toolsWith([]);
    const out: any = await tools.executeTool('uk_semantic_search', { query: 'consultation' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/Semantic search failed/);
  });

  it('clamps limit instead of passing a negative through to Qdrant', async () => {
    mockSearch.mockResolvedValue([hit('aa', 0.8)]);
    const { tools } = toolsWith([row('aa', 'uksi/2007/783')]);
    // -3 is truthy, so `Number(limit) || 10` keeps it: Qdrant would be called with a
    // negative limit and slice(0, -3) would drop the best results.
    await tools.executeTool('uk_semantic_search', { query: 'x', limit: -3 });
    expect(mockSearch.mock.calls[0][1].limit).toBeGreaterThan(0);

    mockSearch.mockClear();
    await tools.executeTool('uk_semantic_search', { query: 'x', limit: 999 });
    expect(mockSearch.mock.calls[0][1].limit).toBeLessThanOrEqual(25 * 6);
  });

  it('casts a wider net when leg_type narrows in SQL after retrieval', async () => {
    mockSearch.mockResolvedValue([hit('aa', 0.8)]);
    const { tools } = toolsWith([row('aa', 'ukpga/2006/46')]);
    await tools.executeTool('uk_semantic_search', { query: 'x', limit: 10 });
    const plain = mockSearch.mock.calls[0][1].limit;

    mockSearch.mockClear();
    await tools.executeTool('uk_semantic_search', { query: 'x', limit: 10, leg_type: 'ukpga' });
    expect(mockSearch.mock.calls[0][1].limit).toBeGreaterThan(plain);
  });

  it('ignores tools that are not its own', async () => {
    const { tools } = toolsWith([]);
    expect(await tools.executeTool('uk_get_provision', { leg_id: 'x' })).toBeNull();
  });
});
