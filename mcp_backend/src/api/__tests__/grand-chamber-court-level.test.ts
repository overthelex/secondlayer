jest.mock('../../utils/html-parser', () => ({
  ...jest.requireActual('../../utils/html-parser'),
  extractSearchTermsWithAI: jest.fn().mockResolvedValue({ searchQuery: 'оренда землі', keywords: [], lawArticles: [] }),
}));

import { ProceduralTools } from '../tools/procedural-tools';
import { LegalAdviceTools } from '../tools/legal-advice-tools';
import { EdsrUnifiedSearchTool } from '../tools/edrsr-unified-search-tool';
import {
  GRAND_CHAMBER_COURT_CODE,
  courtLevelCourtCode,
  buildSupremeCourtWhereFilter,
} from '../tool-utils';

/**
 * LEXAI-2172: court_level=GrandChamber filtered court_code 9901 in find_similar_fact_pattern_cases
 * and compare_practice_pro_contra. In edrsr_courts (prod, 31.10.2026):
 *   9901 = «Верховний Суд» (16,564 decisions, 2017-01..2018-01 only)
 *   9951 = «Велика Палата Верховного Суду» (27,639 decisions)
 * The ВП decision 90458880 (922/989/18) is 9951; the doc that came back instead, 71511686
 * (922/2310/16, 2018-01-09), is 9901. GrandChamber must pin 9951 in the Qdrant and FTS queries.
 */
const GC_DOC = 90458880;   // court_code 9951, 922/989/18
const OLD_SC_DOC = 71511686; // court_code 9901, 922/2310/16
const KGS_DOC = 111;       // court_code 9911

function hit(doc_id: number, court_code: number, text: string) {
  return { doc_id, score: 0.8, text, chunk_index: 0, metadata: { court_code, adjudication_date: '2020-06-22', cause_num: `c/${doc_id}` } };
}

describe('Grand Chamber court_code helpers', () => {
  it('Grand Chamber is 9951, not 9901', () => {
    expect(GRAND_CHAMBER_COURT_CODE).toBe(9951);
    expect(courtLevelCourtCode('GrandChamber')).toBe(9951);
    expect(courtLevelCourtCode('SC')).toBeUndefined();
    expect(courtLevelCourtCode(undefined)).toBeUndefined();
  });

  it('buildSupremeCourtWhereFilter pins GrandChamber to court_code 9951 and SC to instance 1', () => {
    expect(buildSupremeCourtWhereFilter('GrandChamber')).toEqual([{ field: 'court_code', operator: '=', value: 9951 }]);
    expect(buildSupremeCourtWhereFilter('SC')).toEqual([{ field: 'instance_code', operator: '=', value: 1 }]);
  });
});

describe('find_similar_fact_pattern_cases court_level=GrandChamber', () => {
  function makeTools(hits: any[] | null, ftsResults: any[] = []) {
    const llm: any = { chatCompletion: jest.fn().mockResolvedValue({ content: JSON.stringify({ keywords: ['оренда землі'] }) }) };
    const edsrVectorizer: any = hits === null ? undefined : { semanticSearch: jest.fn().mockResolvedValue(hits) };
    const ftsService: any = { searchFulltext: jest.fn().mockResolvedValue({ results: ftsResults }) };
    const tools = new ProceduralTools({} as any, {} as any, {} as any, {} as any, {} as any, llm, ftsService, {}, edsrVectorizer);
    return { tools, edsrVectorizer, ftsService };
  }
  const run = async (tools: ProceduralTools) => {
    const res = await tools.executeTool('find_similar_fact_pattern_cases', {
      procedure_code: 'gpc', facts_text: 'спір щодо договору оренди землі', court_level: 'GrandChamber', limit: 5,
    });
    return JSON.parse(res!.content[0].text);
  };

  it('pushes court_code 9951 into the Qdrant filter and keeps only ВП decisions', async () => {
    const { tools, edsrVectorizer } = makeTools([
      hit(OLD_SC_DOC, 9901, 'оренда землі'), hit(KGS_DOC, 9911, 'оренда землі'), hit(GC_DOC, 9951, 'оренда землі'),
    ]);
    const out = await run(tools);
    expect(edsrVectorizer.semanticSearch.mock.calls[0][1].court_code).toBe(9951);
    expect(out.results.map((r: any) => r.doc_id)).toEqual([GC_DOC]);
    expect(out.court_level_filter).toBe('GrandChamber');
  });

  it('FTS fallback filters court_code 9951 and labels the result Велика Палата ВС', async () => {
    const { tools, ftsService } = makeTools(null, [
      { doc_id: GC_DOC, court_code: 9951, adjudication_date: '2020-06-22', cause_num: '922/989/18', headline: 'оренда' },
    ]);
    const out = await run(tools);
    const filters = ftsService.searchFulltext.mock.calls[0][2];
    expect(filters.court_code).toBe(9951);
    expect(filters.instance_code).toBe(1);
    expect(out.results.map((r: any) => r.doc_id)).toEqual([GC_DOC]);
    expect(out.court_level).toBe('Велика Палата ВС');
  });

  it('description no longer advertises 9901 for the Grand Chamber', () => {
    const { tools } = makeTools([]);
    const defs = tools.getToolDefinitions();
    for (const name of ['find_similar_fact_pattern_cases', 'compare_practice_pro_contra']) {
      const d = defs.find((t: any) => t.name === name)!;
      const desc = (d.inputSchema.properties as any).court_level.description as string;
      expect(desc).toContain('9951');
      expect(desc).not.toContain('9901');
    }
  });
});

describe('compare_practice_pro_contra court_level=GrandChamber', () => {
  it('pushes court_code 9951 into the semantic leg; 9901/9911 never reach classification', async () => {
    const edsrVectorizer: any = {
      semanticSearch: jest.fn().mockResolvedValue([
        hit(OLD_SC_DOC, 9901, 'фрагмент А'), hit(KGS_DOC, 9911, 'фрагмент Б'), hit(GC_DOC, 9951, 'фрагмент В'),
      ]),
    };
    const llm: any = {
      chatCompletion: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          classifications: [
            { doc_id: OLD_SC_DOC, stance: 'supports', quote: 'старий ВС', confidence: 0.9 },
            { doc_id: KGS_DOC, stance: 'opposes', quote: 'КГС', confidence: 0.9 },
            { doc_id: GC_DOC, stance: 'supports', quote: 'ВП за', confidence: 0.9 },
          ],
        }),
      }),
    };
    const tools = new ProceduralTools({} as any, {} as any, {} as any, {} as any, {} as any, llm, undefined, undefined, edsrVectorizer);
    const res = await (tools as any).comparePracticeProContra({ procedure_code: 'gpc', query: 'теза', court_level: 'GrandChamber' });
    const out = JSON.parse(res.content[0].text);

    expect(edsrVectorizer.semanticSearch.mock.calls[0][1].court_code).toBe(9951);
    const all = [...out.pro, ...out.contra].map((c: any) => c.doc_id);
    expect(all).toEqual([GC_DOC]);
    expect(out.court_level_filter).toBe('GrandChamber');
  });
});

// cubic P2 #1: the keyword-FTS fallback (no LLM / empty gather) ignored court_level.
describe('compare_practice_pro_contra keyword-FTS fallback honours court_level', () => {
  it('GrandChamber → only instance 1 with court_code 9951 on every FTS call', async () => {
    const ftsService: any = {
      searchFulltext: jest.fn().mockResolvedValue({
        results: [{ doc_id: GC_DOC, court_code: 9951, adjudication_date: '2020-06-22', cause_num: '922/989/18', headline: 'оренда' }],
      }),
    };
    // No LLM → straight to the keyword-FTS fallback.
    const tools = new ProceduralTools({} as any, {} as any, {} as any, {} as any, {} as any, undefined as any, ftsService, {} as any, undefined as any);
    const res = await (tools as any).comparePracticeProContra({ procedure_code: 'gpc', query: 'теза', court_level: 'GrandChamber' });
    const out = JSON.parse(res.content[0].text);

    expect(ftsService.searchFulltext).toHaveBeenCalled();
    for (const call of ftsService.searchFulltext.mock.calls) {
      expect(call[2].court_code).toBe(9951);
      expect(call[2].instance_code).toBe(1);
    }
    expect(JSON.stringify(out)).toContain('Велика Палата ВС');
  });

  it('SC → only instance 1, no court_code pin; no court_level → walks 1/2/3', async () => {
    const empty: any = { searchFulltext: jest.fn().mockResolvedValue({ results: [] }) };
    const tools = new ProceduralTools({} as any, {} as any, {} as any, {} as any, {} as any, undefined as any, empty, {} as any, undefined as any);
    await (tools as any).comparePracticeProContra({ procedure_code: 'gpc', query: 'теза', court_level: 'SC' });
    const scInstances = empty.searchFulltext.mock.calls.map((c: any[]) => c[2].instance_code);
    expect(new Set(scInstances)).toEqual(new Set([1]));
    expect(empty.searchFulltext.mock.calls.every((c: any[]) => c[2].court_code === undefined)).toBe(true);

    empty.searchFulltext.mockClear();
    await (tools as any).comparePracticeProContra({ procedure_code: 'gpc', query: 'теза' });
    const allInstances = empty.searchFulltext.mock.calls.map((c: any[]) => c[2].instance_code);
    expect(new Set(allInstances)).toEqual(new Set([1, 2, 3]));
  });
});

// cubic P2 #2: search_legal_precedents count_all and case-number shortcut ignored court_level.
describe('search_legal_precedents court_level=GrandChamber on every path', () => {
  function makeLegal(dbRows: any[] = []) {
    const ftsService: any = { searchFulltext: jest.fn().mockResolvedValue({ results: [], total: 0 }) };
    const db: any = { query: jest.fn().mockResolvedValue({ rows: dbRows }) };
    const queryPlanner: any = {
      classifyIntent: jest.fn().mockResolvedValue({ intent: 'x' }),
      generateOptimizedSearchQuery: jest.fn().mockImplementation((q: string) => Promise.resolve(q)),
    };
    const llm: any = { chatCompletion: jest.fn() };
    const tools = new LegalAdviceTools(
      queryPlanner, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      undefined, llm, db, ftsService,
    );
    return { tools, ftsService };
  }

  it('count_all passes court_code 9951 + instance 1 + justice_kind to the FTS count', async () => {
    const { tools, ftsService } = makeLegal();
    await (tools as any).searchLegalPrecedents({ query: 'оренда землі', count_all: true, court_level: 'GrandChamber', procedure_code: 'gpc' });
    const filters = ftsService.searchFulltext.mock.calls[0][2];
    expect(filters).toEqual({ instance_code: 1, court_code: 9951, justice_kind: 3 });
  });

  it('case-number shortcut searches similar cases with court_code 9951', async () => {
    const { tools, ftsService } = makeLegal([{
      doc_id: 1, cause_num: '922/2310/16', judge: 'X', court_code: 9901, justice_kind: 3,
      category_code: 1, adjudication_date: '2018-01-09', full_text: 'оренда землі '.repeat(20),
    }]);
    await (tools as any).searchLegalPrecedents({ query: 'справа 922/2310/16', court_level: 'GrandChamber' });
    const filters = ftsService.searchFulltext.mock.calls[0][2];
    expect(filters.court_code).toBe(9951);
    expect(filters.instance_code).toBe(1);
  });
});

// cubic P2 #3: GrandChamber + explicit instance_code≠1 used to pin 9951 on top → always 0 hits.
describe('search_court_decisions: explicit filters win over court_level', () => {
  const mockFts = () => ({
    searchFulltext: jest.fn().mockResolvedValue({ results: [], total: 0 }),
    filterDocIdsByConstraints: jest.fn(),
    resolveJudgeNames: jest.fn(),
  });
  const db: any = { query: jest.fn().mockResolvedValue({ rows: [] }) };

  it('GrandChamber + instance_code=2 → instance_code=2 wins, no 9951 pin', async () => {
    const fts: any = mockFts();
    const tool = new EdsrUnifiedSearchTool(db, fts);
    await tool.executeTool('search_court_decisions', { mode: 'exact', query: 'тест', court_level: 'GrandChamber', instance_code: 2 });
    const filters = fts.searchFulltext.mock.calls[0][2];
    expect(filters.instance_code).toBe(2);
    expect(filters.court_code).toBeUndefined();
  });

  it('GrandChamber + instance_code=1 → still pinned to 9951', async () => {
    const fts: any = mockFts();
    const tool = new EdsrUnifiedSearchTool(db, fts);
    await tool.executeTool('search_court_decisions', { mode: 'exact', query: 'тест', court_level: 'GrandChamber', instance_code: 1 });
    const filters = fts.searchFulltext.mock.calls[0][2];
    expect(filters.court_code).toBe(9951);
    expect(filters.instance_code).toBe(1);
  });

  it('documents the precedence rule in the court_level description', () => {
    const tool = new EdsrUnifiedSearchTool(db);
    const desc = (tool.getToolDefinitions()[0].inputSchema.properties as any).court_level.description as string;
    expect(desc).toContain('instance_code≠1 court_level ігнорується');
  });
});
