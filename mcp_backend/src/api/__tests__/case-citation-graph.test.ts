jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import { citationKeys, citedBy, cites, withCitationSession } from '../case-citation-graph';
import { LegalAdviceTools } from '../tools/legal-advice-tools';
import { MCPQueryAPI } from '../mcp-query-api';

// LEXAI-2314: decision↔case citations from case_citation_links.

type Handler = (sql: string, params: any[]) => any[] | undefined;

/** A query() that answers by SQL shape, recording every call. */
function router(h: Record<string, Handler | any[]>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    for (const [needle, v] of Object.entries(h)) {
      if (sql.includes(needle)) return { rows: (typeof v === 'function' ? v(sql, params) : v) ?? [] };
    }
    return { rows: [] };
  });
  return { query, calls };
}

const SIBLINGS = 'x(base, hi)';
const CITED_BY = 'WITH l AS MATERIALIZED';
const SELF = 'l.from_doc_id IN (SELECT doc_id FROM edrsr_documents';
const SNIPPETS = 'JOIN edrsr_fulltext f';
const EDGES = 'GROUP BY l.to_case_number';
const TOP = 'x(cause_num, first_date, last_date)';
const RESOLVE = 'WHERE cause_num = ANY($1::text[])';

const citing = (over: any) => ({
  doc_id: '1', court_code: 9931, judgment_code: 2, cause_num: '100/1/20', adjudication_date: new Date('2024-03-01T10:00:00Z'),
  adj_year: 2024, to_case_number: '761/9584/15', instance_code: 1, court_name: 'Касаційний цивільний суд Верховного Суду',
  total: 4076, scanned: 4000, n_cass: 120, n_sc: 110, n_gc: 3, n_app: 900, n_first: 2980, ...over,
});

describe('citationKeys', () => {
  it('drops the procedural suffix: the extractor stores bare numbers only', () => {
    expect(citationKeys('761/9584/15-ц').sort()).toEqual(['761/9584/15', '761/9584/2015']);
    expect(citationKeys('810/1549/17')).toContain('810/1549/17');
  });
  it('is empty for shapes the extractor never captures', () => {
    expect(citationKeys('5-15кс12')).toEqual([]);
    expect(citationKeys('')).toEqual([]);
  });
});

describe('withCitationSession', () => {
  it('runs on a checked-out client in a read-only transaction with JIT off', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ x: 1 }] }), release: jest.fn() };
    const db = { getPool: () => ({ connect: jest.fn().mockResolvedValue(client) }), query: jest.fn() };
    const out = await withCitationSession(db, (q) => q('SELECT 1'));
    expect(out.rows).toEqual([{ x: 1 }]);
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls).toEqual(['BEGIN READ ONLY', 'SET LOCAL jit = off', `SET LOCAL statement_timeout = '20s'`, 'SELECT 1', 'COMMIT']);
    expect(db.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });
  it('rolls back and releases on error', async () => {
    const client = {
      query: jest.fn(async (sql: string) => { if (sql === 'BOOM') throw new Error('x'); return { rows: [] }; }),
      release: jest.fn(),
    };
    const db = { getPool: () => ({ connect: async () => client }) };
    await expect(withCitationSession(db, (q) => q('BOOM'))).rejects.toThrow('x');
    expect(client.query.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
  it('falls back to plain query() for objects without a pool', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await withCitationSession(db, (q) => q('SELECT 2', [1]));
    expect(db.query).toHaveBeenCalledWith('SELECT 2', [1]);
  });
});

describe('citedBy', () => {
  it('looks up by bare number, excludes the case itself and subtracts its unflagged self-citations', async () => {
    const { query, calls } = router({
      [SIBLINGS]: [{ base: '761/9584/15', cause_num: '761/9584/15-ц', member_count: 38 }],
      [CITED_BY]: [citing({ doc_id: '11', court_code: 9951, court_name: 'Велика Палата Верховного Суду' }), citing({ doc_id: '12' })],
      [SELF]: [{ n: 6 }],
      [SNIPPETS]: [{ doc_id: '11', key: '761/9584/15', snippet: 'висновки   у справі\n№ 761/9584/15' }],
    });
    const res = (await citedBy(query as any, '761/9584/15-ц', { limit: 5 }))!;
    const main = calls.find((c) => c.sql.includes(CITED_BY))!;
    expect(main.params[0].sort()).toEqual(['761/9584/15', '761/9584/2015']);
    expect(main.params[2]).toEqual(expect.arrayContaining(['761/9584/15-ц', '761/9584/15']));
    expect(main.params[1]).toBe(10000);
    expect(res.total_citing_decisions).toBe(4070);
    expect(res.scanned).toMatchObject({ window: 10000, citing_decisions: 4000, truncated: false });
    expect(res.scanned.by_instance).toEqual({ cassation: 120, supreme_court: 110, grand_chamber: 3, appeal: 900, first: 2980 });
    expect(res.citing_decisions[0]).toMatchObject({
      doc_id: '11', grand_chamber: true, supreme_court: true, instance: 'касаційна', judgment_form: 'Постанова',
      date: '2024-03-01', context: 'висновки у справі № 761/9584/15', url: 'https://reyestr.court.gov.ua/Review/11',
    });
    expect(res.citing_decisions[1].context).toBeUndefined();
    expect(res.same_number_cases).toBeUndefined();
  });

  it('reports the total even when no decision is ranked', async () => {
    const { query } = router({
      [SIBLINGS]: [],
      [CITED_BY]: [],
      [SELF]: [{ n: 0 }],
      'SELECT count(*)::int AS n FROM case_citation_links': [{ n: 7 }],
    });
    const res = (await citedBy(query as any, '810/1549/17', { limit: 5, onlySupremeCourt: true }))!;
    expect(res.total_citing_decisions).toBe(7);
    expect(res.citing_decisions).toEqual([]);
  });

  it('flags several real cases behind one bare number', async () => {
    const { query } = router({
      [SIBLINGS]: [
        { base: '352/923/16', cause_num: '352/923/16-ц', member_count: 9 },
        { base: '352/923/16', cause_num: '352/923/16-к', member_count: 2 },
      ],
      [CITED_BY]: [citing({ to_case_number: '352/923/16' })],
      [SELF]: [{ n: 0 }],
    });
    const res = (await citedBy(query as any, '352/923/16-ц', { limit: 5, withContext: false }))!;
    expect(res.same_number_cases).toEqual(['352/923/16-ц', '352/923/16-к']);
  });
});

describe('cites', () => {
  it('ranks cited cases by the instance of their top decision; unresolved last', async () => {
    const { query, calls } = router({
      [EDGES]: [
        { to_case_number: '808/2122/18', n_docs: 2, sample_doc_id: '5', sample_year: 2025, total: 3 },
        { to_case_number: '761/9584/15', n_docs: 1, sample_doc_id: '5', sample_year: 2025, total: 3 },
        { to_case_number: '2/537/444', n_docs: 9, sample_doc_id: '5', sample_year: 2025, total: 3 },
      ],
      [SIBLINGS]: [
        { base: '808/2122/18', cause_num: '808/2122/18', member_count: 19, first_date: 'a', last_date: 'b' },
        { base: '761/9584/15', cause_num: '761/9584/15-ц', member_count: 38, first_date: 'c', last_date: 'd' },
      ],
      [TOP]: [
        { cause_num: '808/2122/18', doc_id: '88507234', court_code: 9921, judgment_code: 2, adjudication_date: '2020-03-30', instance_code: 1 },
        { cause_num: '761/9584/15-ц', doc_id: '87902782', court_code: 9951, judgment_code: 2, adjudication_date: '2019-02-27', instance_code: 1 },
      ],
      [SNIPPETS]: [],
    });
    const res = await cites(query as any, ['5'], '537/4740/20', { limit: 10 });
    expect(res.total_cited_cases).toBe(3);
    expect(res.cited_cases.map((c: any) => c.cited_case_number)).toEqual(['761/9584/15', '808/2122/18', '2/537/444']);
    expect(res.cited_cases[0]).toMatchObject({ case_number: '761/9584/15-ц', in_corpus: true, top_decision: { doc_id: '87902782', grand_chamber: true } });
    expect(res.cited_cases[2]).toMatchObject({ in_corpus: false, cited_in_documents: 9 });
    expect(res.cited_cases[2].top_decision).toBeUndefined();
    // own case numbers are excluded from the edges
    expect(calls.find((c) => c.sql.includes(EDGES))!.params[1]).toEqual(expect.arrayContaining(['537/4740/20']));
  });
});

describe('get_citation_graph direction', () => {
  function tools(h: Record<string, any>) {
    const r = router(h);
    const t = new LegalAdviceTools(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      undefined, undefined, { query: r.query }, undefined, undefined,
    );
    return { t, ...r };
  }
  const body = (r: any) => JSON.parse(r.content[0].text);

  it('cited_by resolves the case number and returns ranked citing decisions', async () => {
    const { t } = tools({
      [RESOLVE]: [{ cause_num: '761/9584/15-ц', member_count: 38 }],
      [SIBLINGS]: [{ base: '761/9584/15', cause_num: '761/9584/15-ц', member_count: 38 }],
      [CITED_BY]: [citing({ doc_id: '11' })],
      [SELF]: [{ n: 0 }],
    });
    const out = body(await t.executeTool('get_citation_graph', { case_id: '761/9584/15', direction: 'cited_by', limit: 500 }));
    expect(out.direction).toBe('cited_by');
    expect(out.case_number).toBe('761/9584/15-ц');
    expect(out.requested_case_number).toBe('761/9584/15');
    expect(out.citing_decisions).toHaveLength(1);
    expect(out.coverage_note).toContain('травня 2026');
  });

  it('cites takes every document of the case', async () => {
    const { t, calls } = tools({
      [RESOLVE]: [{ cause_num: '537/4740/20', member_count: 47 }],
      'ORDER BY doc_id LIMIT $2': [{ doc_id: '7' }, { doc_id: '8' }],
      [EDGES]: [],
    });
    const out = body(await t.executeTool('get_citation_graph', { case_id: '537/4740/20', direction: 'cites' }));
    expect(out.total_cited_cases).toBe(0);
    expect(out.note).toBeDefined();
    expect(calls.find((c) => c.sql.includes(EDGES))!.params[0]).toEqual(['7', '8']);
    expect(calls.find((c) => c.sql.includes(EDGES))!.params[2]).toBe(100);
  });

  it('rejects an unknown direction and a UUID for the case modes', async () => {
    const { t } = tools({});
    expect(body(await t.executeTool('get_citation_graph', { case_id: '1', direction: 'sideways' })).error).toContain('sideways');
    const uuid = '70409de8-741e-420a-92d2-f6ab51d23539';
    expect(body(await t.executeTool('get_citation_graph', { case_id: uuid, direction: 'cites' })).error).toContain('UUID');
  });
});

describe('check_precedent_status incoming_citations', () => {
  it('adds Supreme Court citations without changing the status', async () => {
    const r = router({
      [RESOLVE]: [{ cause_num: '810/1549/17', member_count: 31 }],
      [SIBLINGS]: [{ base: '810/1549/17', cause_num: '810/1549/17', member_count: 31 }],
      [CITED_BY]: [citing({ doc_id: '11', to_case_number: '810/1549/17', total: 298, scanned: 298, n_sc: 7, n_gc: 1 })],
      [SELF]: [{ n: 0 }],
    });
    const validator = { validatePrecedentStatus: jest.fn().mockResolvedValue({ status: 'valid', confidence: 0.9 }) };
    const stub = {} as any;
    const api = new MCPQueryAPI(stub, stub, stub, stub, stub, validator as any, stub, stub, undefined, { query: r.query });
    const res: any = await api.handleToolCall('check_precedent_status', { case_number: '810/1549/17' });
    const out = JSON.parse(res.content[0].text);
    expect(out.status.status).toBe('valid');
    expect(out.incoming_citations).toMatchObject({
      case_number: '810/1549/17', cited_by_decisions: 298, supreme_court_citations: 7, grand_chamber_citations: 1,
    });
    expect(out.incoming_citations.latest_supreme_court_citations[0].doc_id).toBe('11');
    const main = r.calls.find((c) => c.sql.includes(CITED_BY))!;
    expect(main.params[5]).toBe(true); // only supreme-court rows
  });
});
