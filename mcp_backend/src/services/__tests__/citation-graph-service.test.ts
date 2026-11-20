/**
 * Unit tests for CitationGraphService on Postgres (LEXAI-2323). The database is a fake
 * that answers by matching the SQL, so these pin the result shapes the callers rely on
 * (the same shapes the Neo4j version returned) and the parameters sent.
 */
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { CitationGraphService, MIN_ARTICLE_DECISIONS } from '../citation-graph-service.js';

type Handler = (sql: string, params: any[]) => any[] | undefined;

function fakeDb(handler: Handler, tablesPresent = true) {
  return {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('to_regclass')) return { rows: [{ n: tablesPresent ? params[0].length : 0 }] };
      return { rows: handler(sql, params) ?? [] };
    }),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('CitationGraphService (Postgres)', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CITATION_BACKEND;
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('isEnabled', () => {
    it('is false without a database', () => {
      expect(new CitationGraphService().isEnabled()).toBe(false);
    });

    it('stays on when the tables exist, whatever CITATION_BACKEND says (except off)', async () => {
      process.env.CITATION_BACKEND = 'postgres';
      const svc = new CitationGraphService(fakeDb(() => []));
      expect(svc.isEnabled()).toBe(true);
      await flush();
      expect(svc.isEnabled()).toBe(true);
    });

    it('turns off once the table check finds them missing', async () => {
      const svc = new CitationGraphService(fakeDb(() => [], false));
      svc.isEnabled();
      await flush();
      expect(svc.isEnabled()).toBe(false);
    });

    it('is false for CITATION_BACKEND=off', () => {
      process.env.CITATION_BACKEND = 'off';
      expect(new CitationGraphService(fakeDb(() => [])).isEnabled()).toBe(false);
    });

    it('setDatabase re-checks against the new pool', async () => {
      const svc = new CitationGraphService(fakeDb(() => [], false));
      svc.isEnabled();
      await flush();
      expect(svc.isEnabled()).toBe(false);
      svc.setDatabase(fakeDb(() => []));
      expect(svc.isEnabled()).toBe(true);
      await flush();
      expect(svc.isEnabled()).toBe(true);
    });
  });

  it('getDecisionCitationSummary: count + popular articles, noise filter applied', async () => {
    const db = fakeDb((sql) =>
      sql.includes('decision_statute_citations')
        ? [
            { law: 'ЦК', article: '16', ct: 'codex_article', pop: '900000', total: '7' },
            { law: 'ЦПК', article: '81', ct: 'codex_article', pop: 800000, total: '7' },
          ]
        : undefined,
    );
    const out = await new CitationGraphService(db).getDecisionCitationSummary(123, 2);
    expect(out).toEqual({
      citedCount: 7,
      topCitedArticles: [
        { law: 'ЦК', article: '16', citationType: 'codex_article', popularity: 900000 },
        { law: 'ЦПК', article: '81', citationType: 'codex_article', popularity: 800000 },
      ],
    });
    expect(db.query.mock.calls[0][1]).toEqual(['123', 2, MIN_ARTICLE_DECISIONS]);
  });

  it('getDecisionCitationSummary: zero when nothing is cited', async () => {
    const out = await new CitationGraphService(fakeDb(() => [])).getDecisionCitationSummary('1');
    expect(out).toEqual({ citedCount: 0, topCitedArticles: [] });
  });

  it('getArticleStats / getArticleCitedBy', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('FROM statute_article_stats'))
        return [{ law_number: 'ЦК', law_article: '625', total_citations: '1200', unique_decisions: '1100' }];
      if (sql.includes('FROM decision_statute_citations')) return [{ doc_id: '5' }, { doc_id: '6' }];
      return undefined;
    });
    const svc = new CitationGraphService(db);
    expect(await svc.getArticleStats('ЦК', '625')).toEqual({ law: 'ЦК', article: '625', totalCitations: 1200, uniqueDecisions: 1100 });
    expect(await svc.getArticleCitedBy('ЦК', '625', 2)).toEqual({ count: 1200, decisions: ['5', '6'] });
  });

  it('getArticleStats: null for an unknown article', async () => {
    expect(await new CitationGraphService(fakeDb(() => [])).getArticleStats('X', '1')).toBeNull();
  });

  it('getCaseStats: most-cited variant, departure from the Grand Chamber', async () => {
    const db = fakeDb((sql) =>
      sql.includes('edrsr_case_index')
        ? [{ cause_num: '761/9584/15-ц', citing: 32806, member_count: 12, latest_doc_id: '99', dep_by: '88', dep_on: new Date('2019-01-01T00:00:00Z') }]
        : undefined,
    );
    const out = await new CitationGraphService(db).getCaseStats(['761/9584/15-ц', '761/9584/15']);
    expect(out).toEqual({
      causeNum: '761/9584/15-ц',
      citingDecisions: 32806,
      memberCount: 12,
      latestDocId: '99',
      departedByDecision: '88',
      departedOn: '2019-01-01T00:00:00.000Z',
    });
    expect(db.query.mock.calls[0][1]).toEqual([['761/9584/15-ц', '761/9584/15']]);
  });

  it('getCaseStats: null for no input or an unknown case', async () => {
    const svc = new CitationGraphService(fakeDb(() => []));
    expect(await svc.getCaseStats([])).toBeNull();
    expect(await svc.getCaseStats(['1/1/1'])).toBeNull();
  });

  it('getDecisionSupersession: overruled with the reversing decision', async () => {
    const db = fakeDb(() => [{ status: 'overruled', by_doc: '103232269', disposition: 'reversed', reversed_date: '2022-02-06T22:00:00Z' }]);
    expect(await new CitationGraphService(db).getDecisionSupersession('100000508')).toEqual({
      status: 'overruled',
      supersededBy: { docId: '103232269', disposition: 'reversed', on: '2022-02-06T22:00:00.000Z' },
    });
  });

  it('getDecisionSupersession: no mark', async () => {
    const db = fakeDb(() => [{ status: null, by_doc: null, disposition: null, reversed_date: null }]);
    expect(await new CitationGraphService(db).getDecisionSupersession(1)).toEqual({ status: null, supersededBy: null });
  });

  it('getDecisionSupersession: dissent without a reversal', async () => {
    const db = fakeDb(() => [{ status: 'dissent', by_doc: null }]);
    expect(await new CitationGraphService(db).getDecisionSupersession(1)).toEqual({ status: 'dissent', supersededBy: null });
  });

  it('resolveCaseDocId / getCaseCitedBy / getDecisionCitedCases', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('FROM edrsr_documents')) return [{ doc_id: '42' }];
      if (sql.includes('DISTINCT ON')) return [{ cause_num: '910/1/20', member_count: 3, latest: '7' }];
      if (sql.includes('FROM case_citation_links')) return [{ doc_id: '9' }, { doc_id: '8' }];
      return undefined;
    });
    const svc = new CitationGraphService(db);
    expect(await svc.resolveCaseDocId('910/1/20')).toBe('42');
    expect(await svc.getCaseCitedBy('910/1/20', 2)).toEqual(['9', '8']);
    expect(await svc.getDecisionCitedCases(1)).toEqual([{ causeNum: '910/1/20', memberCount: 3, latestDocId: '7' }]);
  });

  it('resolveCaseDocId: null for an unknown case', async () => {
    expect(await new CitationGraphService(fakeDb(() => [])).resolveCaseDocId('1/1/1')).toBeNull();
  });

  it('getCitationGraph: decision → article → law, no COCITED', async () => {
    const db = fakeDb((sql) =>
      sql.includes('decision_statute_citations')
        ? [
            { law: 'ЦК', article: '16', ct: 'codex_article' },
            { law: 'ЦК', article: '17', ct: 'codex_article' },
          ]
        : undefined,
    );
    const g = await new CitationGraphService(db).getCitationGraph('90458880', 2, 2);
    expect(g.root).toEqual({ docId: '90458880' });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['article:ЦК|16', 'article:ЦК|17', 'decision:90458880', 'law:ЦК']);
    expect(g.edges.filter((e) => e.type === 'CITES_ARTICLE')).toHaveLength(2);
    expect(g.edges.filter((e) => e.type === 'OF_LAW')).toHaveLength(2);
    expect(g.edges.some((e: any) => e.type === 'COCITED')).toBe(false);
    expect(g.truncated).toBe(true);
  });

  it('getCitationGraph: a lone node when nothing is cited', async () => {
    const g = await new CitationGraphService(fakeDb(() => [])).getCitationGraph(1);
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
    expect(g.truncated).toBe(false);
  });

  it('healthCheck reports table estimates', async () => {
    const db = fakeDb((sql) => (sql.includes('pg_class') ? [{ relname: 'decision_supersession', n: '704671' }] : undefined));
    const h = await new CitationGraphService(db).healthCheck();
    expect(h).toMatchObject({ ok: true, enabled: true, backend: 'postgres', counts: { decision_supersession: 704671 } });
  });
});
