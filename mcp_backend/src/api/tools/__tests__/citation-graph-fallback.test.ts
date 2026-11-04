jest.mock('../../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import { LegalAdviceTools } from '../legal-advice-tools';

// LEXAI-2204: ВП 90458880 came back from Neo4j as a lone node with no edges.
function build(neoGraph: any, pgRows: any[]) {
  const graphService: any = {
    isEnabled: () => true,
    getCitationGraph: jest.fn().mockResolvedValue(neoGraph),
  };
  const db = { query: jest.fn().mockResolvedValue({ rows: pgRows }) };
  const tools = new LegalAdviceTools(
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    undefined, undefined, db, undefined, graphService,
  );
  return { tools, db };
}
const empty = { root: { docId: '90458880' }, nodes: [{ id: 'decision:90458880', type: 'decision', label: '90458880' }], edges: [], truncated: false };
const body = (r: any) => JSON.parse(r.content[0].text);

describe('get_citation_graph fallback (LEXAI-2204)', () => {
  it('serves law_court_citations edges when Neo4j has none', async () => {
    const { tools, db } = build(empty, [
      { citation_type: 'codex_article', law_number: 'ГПК', law_article: '287' },
      { citation_type: 'law_article', law_number: 'ГПК', law_article: '300' },
    ]);
    const out = body(await tools.executeTool('get_citation_graph', { case_id: '90458880' }));
    expect(out.backend).toBe('postgres');
    expect(out.graph.edges.filter((e: any) => e.type === 'CITES_ARTICLE')).toHaveLength(2);
    expect(out.graph.edges.filter((e: any) => e.type === 'OF_LAW')).toHaveLength(2);
    expect(db.query.mock.calls[0][1]).toEqual(['90458880']);
  });

  it('says why the graph is empty when Postgres has nothing either', async () => {
    const { tools } = build(empty, []);
    const out = body(await tools.executeTool('get_citation_graph', { case_id: '90458880' }));
    expect(out.backend).toBe('neo4j');
    expect(out.note).toContain('90458880');
  });
});
