import { ProceduralTools, rerankByTermCoverage } from '../tools/procedural-tools';

/**
 * LEXAI-2101: find_similar_fact_pattern_cases always reported extracted_search_terms: [] and,
 * on the FTS fallback, searched the first six literal words of the facts. Terms are now
 * extracted on every call (LLM, deterministic fallback), rerank the semantic pool and drive
 * the FTS fallback.
 */
const FACTS =
  'Працівника звільнили за прогул, хоча він у цей день перебував на лікарняному; ' +
  'лікарняний підтверджено листком непрацездатності';
const LLM_TERMS = ['звільнення за прогул', 'листок непрацездатності'];

function hit(doc_id: number, score: number, text: string) {
  return { doc_id, score, text, metadata: { court_code: 1370, adjudication_date: '2021-03-25', cause_num: `c/${doc_id}` } };
}

function makeTools(opts: { hits?: any[] | null; llmContent?: string; ftsResults?: any[] }) {
  const llm: any = { chatCompletion: jest.fn().mockResolvedValue({ content: opts.llmContent ?? JSON.stringify({ keywords: LLM_TERMS }) }) };
  const edsrVectorizer: any = opts.hits === null ? undefined : { semanticSearch: jest.fn().mockResolvedValue(opts.hits ?? []) };
  const ftsService: any = { searchFulltext: jest.fn().mockResolvedValue({ results: opts.ftsResults ?? [] }) };
  const tools = new ProceduralTools({} as any, {} as any, {} as any, {} as any, {} as any, llm, ftsService, {}, edsrVectorizer);
  return { tools, llm, ftsService };
}

async function run(tools: ProceduralTools) {
  const res = await tools.executeTool('find_similar_fact_pattern_cases', { procedure_code: 'cpc', facts_text: FACTS, limit: 2 });
  return JSON.parse(res!.content[0].text);
}

describe('find_similar_fact_pattern_cases — extracted terms (LEXAI-2101)', () => {
  it('reports LLM terms on the semantic path and promotes near-ties that cover them', async () => {
    const { tools } = makeTools({
      hits: [
        hit(1, 0.5540, 'переведення на іншу роботу без згоди працівника'),
        hit(2, 0.5530, 'звільнено за прогул, проте працівник надав листок непрацездатності'),
        hit(3, 0.5100, 'звільнено за прогул; листок непрацездатності'),
      ],
    });
    const out = await run(tools);
    expect(out.search_method).toBe('semantic_hnsw');
    expect(out.extracted_search_terms).toEqual(LLM_TERMS);
    expect(out.extracted_terms_source).toBe('llm');
    expect(out.results.map((r: any) => r.doc_id)).toEqual([2, 1]);
    expect(out.results[0].term_hits).toBe(2);
  });

  it('falls back to deterministic keywords when the LLM returns nothing', async () => {
    const { tools } = makeTools({ hits: [hit(1, 0.5, 'прогул')], llmContent: '' });
    const out = await run(tools);
    expect(out.extracted_terms_source).toBe('keyword_fallback');
    expect(out.extracted_search_terms.length).toBeGreaterThan(0);
  });

  it('FTS fallback searches the extracted terms, not the first words of the facts', async () => {
    const { tools, ftsService } = makeTools({
      hits: null,
      ftsResults: [{ doc_id: 9, court_code: 9921, adjudication_date: '2020-01-01', cause_num: '1/1/20', headline: 'прогул' }],
    });
    const out = await run(tools);
    expect(out.search_method).toBe('fts');
    expect(ftsService.searchFulltext.mock.calls[0][0]).toBe('звільнення прогул листок непрацездатності');
    expect(out.search_query).toBe('звільнення прогул листок непрацездатності');
  });

  it('relaxes to the two leading words when the full term query matches nothing', async () => {
    const { tools, ftsService } = makeTools({ hits: null });
    await run(tools);
    const queries = ftsService.searchFulltext.mock.calls.map((c: any[]) => c[0]);
    expect(queries).toEqual([
      ...Array(3).fill('звільнення прогул листок непрацездатності'),
      ...Array(3).fill('звільнення прогул'),
    ]);
  });
});

describe('rerankByTermCoverage', () => {
  it('keeps cosine order when there are no terms', () => {
    const pool = [{ text: 'a', score: 0.5 }, { text: 'b', score: 0.6 }];
    expect(rerankByTermCoverage(pool, []).map(x => x.c.text)).toEqual(['b', 'a']);
  });

  it('does not let coverage beat a clearly better semantic match', () => {
    const pool = [{ text: 'нічого спільного', score: 0.62 }, { text: 'звільнення за прогул', score: 0.50 }];
    expect(rerankByTermCoverage(pool, ['звільнення за прогул'])[0].c.score).toBe(0.62);
  });
});
