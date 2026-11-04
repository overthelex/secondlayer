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

// legal.org.ua runs without Neo4j: the same lone node came from citation_links.
describe('get_citation_graph fallback without Neo4j (LEXAI-2204)', () => {
  const UUID = '70409de8-741e-420a-92d2-f6ab51d23539';
  function buildLegacy(lccRows: any[], inDocuments = true) {
    const validator: any = {
      buildCitationGraph: jest.fn().mockResolvedValue({ nodes: [{ id: UUID }], edges: [] }),
    };
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM documents')) return { rows: inDocuments ? [{ id: UUID }] : [] };
        if (sql.includes('law_court_citations')) return { rows: lccRows };
        return { rows: [] };
      }),
    };
    const tools = new LegalAdviceTools(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, validator,
      undefined, undefined, db, undefined, undefined,
    );
    return { tools, validator };
  }
  const rows = [{ citation_type: 'codex_article', law_number: 'ГПК', law_article: '287' }];

  it('serves law_court_citations edges when citation_links has none', async () => {
    const { tools, validator } = buildLegacy(rows);
    const out = body(await tools.executeTool('get_citation_graph', { case_id: '90458880' }));
    expect(validator.buildCitationGraph).toHaveBeenCalledWith(UUID, 2);
    expect(out.backend).toBe('postgres');
    expect(out.graph.edges.some((e: any) => e.type === 'CITES_ARTICLE')).toBe(true);
  });

  it('serves law_court_citations edges when the decision is not in documents', async () => {
    const { tools } = buildLegacy(rows, false);
    const out = body(await tools.executeTool('get_citation_graph', { case_id: '90458880' }));
    expect(out.backend).toBe('postgres');
  });

  it('says why the graph is empty when both sources are empty', async () => {
    const { tools } = buildLegacy([]);
    const out = body(await tools.executeTool('get_citation_graph', { case_id: '90458880' }));
    expect(out.graph.edges).toEqual([]);
    expect(out.note).toContain('90458880');
  });
});
