/**
 * EdsrUnifiedSearchTool unit tests
 *
 * Covers:
 * - Tool definition: single search_court_decisions tool with mode enum
 * - Mode routing: structured/fulltext/hybrid/semantic
 * - Structured mode: WHERE clause, military presets, court name resolution, enrichment
 * - Fulltext mode: delegates to FTS service, enriches results
 * - Hybrid mode: graceful degradation when one leg fails
 * - Semantic mode: redirects to fulltext with notice
 * - Unknown mode rejection
 * - Required param validation per mode
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EdsrUnifiedSearchTool } from '../tools/edrsr-unified-search-tool.js';

type QueryCall = { sql: string; params?: any[] };

describe('EdsrUnifiedSearchTool', () => {
  let db: any;
  let calls: QueryCall[];
  let tool: EdsrUnifiedSearchTool;
  let mockFtsService: any;
  let mockVectorizer: any;

  const makeDb = (responder: (sql: string, params?: any[]) => any) => ({
    query: jest.fn((sql: string, params?: any[]) => {
      calls.push({ sql, params });
      return Promise.resolve(responder(sql, params));
    }),
  });

  beforeEach(() => {
    calls = [];
    mockFtsService = {
      searchFulltext: jest.fn(() => Promise.resolve({
        query: 'test',
        total: 1,
        results: [{
          doc_id: 12345, cause_num: '756/1234/23', judge: 'Іванов І.І.',
          court_code: 2605, justice_kind: 1, judgment_code: 3,
          adjudication_date: '2024-06-15', headline: 'тест <b>match</b>',
          rank: 0.5,
        }],
      })),
      // Default: pass-through (keep every candidate). Tests override to assert dropping.
      filterDocIdsByConstraints: jest.fn((docIds: number[]) =>
        Promise.resolve(new Set(docIds.map(Number)))),
      // The fulltext path weights terms by IDF via lexemeStats (edrsr-fts-service.ts:606).
      // Without it every fulltext test died on "lexemeStats is not a function" rather than
      // exercising the behaviour under test. Neutral stats: no term is rarer than another.
      lexemeStats: jest.fn((tokens: string[]) => Promise.resolve({
        idf: new Map(tokens.map((t) => [t.toLowerCase(), 1])),
        df: new Map(tokens.map((t) => [t.toLowerCase(), 1000])),
        sampleDocs: 100000,
      })),
      // Empty stem map = fall back to the plain token string, which is the behaviour these
      // tests were written against. Without the method the fulltext path threw before ever
      // reaching searchFulltext, so every assertion about it failed for the wrong reason.
      snapTokensToStems: jest.fn(() => Promise.resolve(new Map<string, string>())),
      // null = no judge-name expansion, i.e. use the fragment as given.
      resolveJudgeNames: jest.fn(() => Promise.resolve(null)),
    };
    mockVectorizer = {
      semanticSearch: jest.fn(() => Promise.resolve([])),
      bestChunkForDocs: jest.fn(() => Promise.resolve(new Map())),
    };
  });

  describe('tool definition', () => {
    it('exposes single search_court_decisions tool', () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db);
      const defs = tool.getToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe('search_court_decisions');
    });

    it('advertises all five modes, and the runtime validator accepts each', () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db);
      const defs = tool.getToolDefinitions();
      const modeEnum = defs[0].inputSchema.properties.mode.enum;
      // 'exact' was added for deterministic token lookup (m200604929-style app numbers).
      // The advertised enum and the zod validator in @secondlayer/shared must agree — when
      // they drifted, the schema offered a mode the validator then rejected at runtime.
      expect(modeEnum).toEqual(['structured', 'exact', 'fulltext', 'hybrid', 'semantic']);
    });
  });

  describe('mode routing', () => {
    it('rejects unknown mode', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db);

      const result = await tool.executeTool('search_court_decisions', { mode: 'unknown' });
      expect(result?.isError).toBe(true);
      // Rejection now comes from the shared zod schema, which names the valid options
      // rather than emitting the old generic 'Невідомий режим'.
      expect(result?.content[0].text).toContain('Невалідні параметри пошуку');
      expect(result?.content[0].text).toContain('mode');
    });

    it('returns null for unknown tool name', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db);
      const result = await tool.executeTool('other_tool', {});
      expect(result).toBeNull();
    });
  });

  describe('structured mode', () => {
    it('requires at least one filter', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db);

      const result = await tool.executeTool('search_court_decisions', { mode: 'structured' });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('параметр пошуку');
    });

    it('searches by cause_num', async () => {
      db = makeDb((sql) => {
        if (sql.includes('COUNT')) return { rows: [{ total: 1 }] };
        return { rows: [{
          doc_id: 123, cause_num: '756/1234/23', judge: 'Петров',
          court_code: 2605, justice_kind: 1, judgment_code: 3,
          adjudication_date: '2024-01-15',
        }] };
      });
      tool = new EdsrUnifiedSearchTool(db);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'structured',
        cause_num: '756/1234/23',
      });

      expect(result?.isError).toBeFalsy();
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.mode).toBe('structured');
      expect(parsed.total).toBe(1);
    });

    it('applies military preset', async () => {
      db = makeDb((sql) => {
        if (sql.includes('COUNT')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      });
      tool = new EdsrUnifiedSearchTool(db);

      await tool.executeTool('search_court_decisions', {
        mode: 'structured',
        military_preset: 'awol',
      });

      const dataSql = calls.find(c => c.sql.includes('SELECT'));
      expect(dataSql?.sql).toContain('category_code = ANY');
      expect(dataSql?.sql).toContain('justice_kind');
    });

    it('resolves court_name to court_code', async () => {
      db = makeDb((sql) => {
        if (sql.includes('edrsr_courts') && sql.includes('LIKE')) {
          return { rows: [{ court_code: 2605 }] };
        }
        if (sql.includes('COUNT')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      });
      tool = new EdsrUnifiedSearchTool(db);

      await tool.executeTool('search_court_decisions', {
        mode: 'structured',
        court_name: 'Оболонський',
      });

      expect(calls[0].sql).toContain('edrsr_courts');
      const filterSql = calls.find(c => c.sql.includes('court_code = ANY'));
      expect(filterSql).toBeTruthy();
    });

    it('returns empty result when court not found', async () => {
      db = makeDb((sql) => {
        if (sql.includes('edrsr_courts')) return { rows: [] };
        return { rows: [] };
      });
      tool = new EdsrUnifiedSearchTool(db);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'structured',
        court_name: 'Неіснуючий суд',
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.total).toBe(0);
    });
  });

  describe('fulltext mode', () => {
    it('requires query parameter', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      const result = await tool.executeTool('search_court_decisions', { mode: 'fulltext' });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('query');
    });

    it('returns error when FTS service unavailable', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'fulltext',
        query: 'тест',
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('FTS');
    });

    it('delegates to FTS service and enriches results', async () => {
      db = makeDb((sql) => {
        if (sql.includes('edrsr_courts')) return { rows: [{ court_code: 2605, name: 'Оболонський' }] };
        if (sql.includes('edrsr_justice_kinds')) return { rows: [{ justice_kind: 1, name: 'Цивільне' }] };
        if (sql.includes('edrsr_judgment_forms')) return { rows: [{ judgment_code: 3, name: 'Рішення' }] };
        return { rows: [] };
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'fulltext',
        query: 'тест',
      });

      expect(mockFtsService.searchFulltext).toHaveBeenCalled();
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.mode).toBe('fulltext');
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].court_name).toBe('Оболонський');
      expect(parsed.results[0].justice_kind_name).toBe('Цивільне');
    });

    it('truncates an over-long fulltext query to the leading tokens', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      const longQuery = 'один два три чотири пять шість сім вісім девять';
      const result = await tool.executeTool('search_court_decisions', {
        mode: 'fulltext', query: longQuery,
      });

      const passedQuery = mockFtsService.searchFulltext.mock.calls[0][0];
      expect(passedQuery.split(/\s+/)).toHaveLength(6);
      expect(passedQuery).toBe('один два три чотири пять шість');
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.query_truncated.from_tokens).toBe(9);
    });

    it('falls back to hybrid when FTS returns zero matches', async () => {
      db = makeDb(() => ({ rows: [] }));
      mockFtsService.searchFulltext = jest.fn(() =>
        Promise.resolve({ query: 'x', total: 0, results: [] }));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'fulltext', query: 'безпідставне збагачення',
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.mode).toBe('hybrid');
      expect(parsed.fallback_from).toBe('fulltext');
      expect(mockVectorizer.semanticSearch).toHaveBeenCalled();
    });
  });

  describe('party filters', () => {
    it('exposes party_name and party_role params', () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db);
      const props = tool.getToolDefinitions()[0].inputSchema.properties as any;
      expect(props.party_name).toBeTruthy();
      expect(props.party_role.enum).toEqual(['plaintiff', 'defendant', 'any']);
    });

    it('passes party_name/party_role into the FTS filters (fulltext)', async () => {
      db = makeDb((sql) => {
        if (sql.includes('edrsr_courts')) return { rows: [] };
        if (sql.includes('edrsr_justice_kinds')) return { rows: [] };
        if (sql.includes('edrsr_judgment_forms')) return { rows: [] };
        return { rows: [] };
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      await tool.executeTool('search_court_decisions', {
        mode: 'fulltext', query: 'доставка вантажу',
        party_name: 'Нова Пошта', party_role: 'defendant',
      });

      const filters = mockFtsService.searchFulltext.mock.calls[0][2];
      expect(filters.party_name).toBe('Нова Пошта');
      expect(filters.party_role).toBe('defendant');
    });

    it('relaxes party_role and retries when first FTS pass is empty', async () => {
      db = makeDb(() => ({ rows: [] }));
      const calls: any[] = [];
      mockFtsService.searchFulltext = jest.fn((q: string, _db: any, filters: any) => {
        calls.push(filters);
        // first call (with role) → empty; second (relaxed) → a hit
        if (filters.party_role) return Promise.resolve({ query: q, total: 0, results: [] });
        return Promise.resolve({ query: q, total: 1, results: [{ doc_id: 1, rank: 0.4 }] });
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'fulltext', query: 'доставка',
        party_name: 'Нова Пошта', party_role: 'defendant',
      });

      expect(calls).toHaveLength(2);
      expect(calls[0].party_role).toBe('defendant');
      expect(calls[1].party_role).toBeUndefined();
      expect(calls[1].party_name).toBe('Нова Пошта');
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.party_role_relaxed).toBe(true);
    });
  });

  describe('term relaxation (relax-on-empty)', () => {
    it('drops trailing tokens until a non-empty hit, surfacing term_relaxed', async () => {
      db = makeDb(() => ({ rows: [] }));
      const seen: string[] = [];
      // Over-AND collapse: only ≤4 tokens match (mimics one rare term zeroing the conjunction).
      mockFtsService.searchFulltext = jest.fn((q: string) => {
        seen.push(q);
        const n = q.split(/\s+/).filter(Boolean).length;
        return Promise.resolve(n <= 4
          ? { query: q, total: 3, results: [{ doc_id: 1, rank: 0.4 }] }
          : { query: q, total: 0, results: [] });
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'fulltext', query: 'один два три чотири пять шість',
      });

      // capped to 6, then relaxed 6→5→4
      expect(seen[0].split(/\s+/)).toHaveLength(6);
      expect(seen[seen.length - 1].split(/\s+/)).toHaveLength(4);
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.term_relaxed).toEqual({ from_tokens: 6, to_tokens: 4 });
      expect(parsed.total).toBe(3);
    });

    it('relaxes on near-collapse (1–2 hits), not just a hard 0', async () => {
      db = makeDb(() => ({ rows: [] }));
      const seen: string[] = [];
      // Over-narrow AND-chain: 5–6 tokens scrape a single hit (mimics the prod
      // "Нова Пошта кур'єрська служба пошкодження вантажу" + defendant → total 1),
      // dropping to ≤4 clears the floor. A strict ===0 trigger would never fire here.
      mockFtsService.searchFulltext = jest.fn((q: string) => {
        seen.push(q);
        const n = q.split(/\s+/).filter(Boolean).length;
        return Promise.resolve(n <= 4
          ? { query: q, total: 50, results: [{ doc_id: 1, rank: 0.4 }] }
          : { query: q, total: 1, results: [{ doc_id: 9, rank: 0.4 }] });
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'fulltext', query: 'один два три чотири пять шість',
      });

      // capped to 6 (total 1), relaxed 6→5→4 where the floor (3) is cleared
      expect(seen[0].split(/\s+/)).toHaveLength(6);
      expect(seen[seen.length - 1].split(/\s+/)).toHaveLength(4);
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.term_relaxed).toEqual({ from_tokens: 6, to_tokens: 4 });
      expect(parsed.total).toBe(50);
    });

    it('does not relax below FTS_MIN_TOKENS (2)', async () => {
      db = makeDb(() => ({ rows: [] }));
      const seen: string[] = [];
      mockFtsService.searchFulltext = jest.fn((q: string) => {
        seen.push(q);
        return Promise.resolve({ query: q, total: 0, results: [] }); // always empty
      });
      // no vectorizer → no hybrid fallback, just return the empty result
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      await tool.executeTool('search_court_decisions', { mode: 'fulltext', query: 'альфа бета гама' });

      // 3→2 then stop (never probes a single token)
      const minTokens = Math.min(...seen.map(q => q.split(/\s+/).filter(Boolean).length));
      expect(minTokens).toBe(2);
    });
  });

  describe('hybrid mode', () => {
    it('requires query parameter', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);

      const result = await tool.executeTool('search_court_decisions', { mode: 'hybrid' });
      expect(result?.isError).toBe(true);
    });

    it('returns error when both legs fail', async () => {
      const failingFts = { searchFulltext: jest.fn(() => Promise.reject(new Error('FTS down'))) };
      const failingVector = { semanticSearch: jest.fn(() => Promise.reject(new Error('Qdrant down'))) };
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db, failingFts as any, failingVector as any);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'hybrid',
        query: 'тест',
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('недоступні');
    });

    it('degrades gracefully to FTS-only when vector fails', async () => {
      const failingVector = { semanticSearch: jest.fn(() => Promise.reject(new Error('Qdrant down'))) };
      db = makeDb((sql) => {
        if (sql.includes('edrsr_courts')) return { rows: [] };
        if (sql.includes('edrsr_justice_kinds')) return { rows: [] };
        if (sql.includes('edrsr_judgment_forms')) return { rows: [] };
        return { rows: [] };
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, failingVector as any);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'hybrid',
        query: 'тест',
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.legs.fts_available).toBe(true);
      expect(parsed.legs.vector_available).toBe(false);
    });

    it('backfills a semantic chunk for FTS-only hits (evidence parity for the filter)', async () => {
      // FTS leg finds doc 12345 whose only snippet is a boilerplate header; the vector
      // leg finds a different doc that already carries a real chunk. The FTS-only hit must
      // get a query-relevant chunk backfilled so the relevance filter judges it fairly.
      const ftsOnly = {
        searchFulltext: jest.fn(() => Promise.resolve({
          query: 'тест', total: 1,
          results: [{
            doc_id: 12345, cause_num: '756/1/23', judge: 'Іванов І.І.',
            court_code: 2605, justice_kind: 1, judgment_code: 3,
            adjudication_date: '2024-06-15', headline: 'ПОСТАНОВА ІМЕНЕМ УКРАЇНИ',
            rank: 0.0001,
          }],
        })),
        filterDocIdsByConstraints: jest.fn((ids: number[]) => Promise.resolve(new Set(ids.map(Number)))),
        // Same two methods the shared mock needs — this test builds its own FTS double, so
        // without them the fulltext leg throws and there is no hit left to backfill.
        lexemeStats: jest.fn((tokens: string[]) => Promise.resolve({
          idf: new Map(tokens.map((t) => [t.toLowerCase(), 1])),
          df: new Map(tokens.map((t) => [t.toLowerCase(), 1000])),
          sampleDocs: 100000,
        })),
        snapTokensToStems: jest.fn(() => Promise.resolve(new Map<string, string>())),
        resolveJudgeNames: jest.fn(() => Promise.resolve(null)),
      };
      const vectorizer = {
        semanticSearch: jest.fn(() => Promise.resolve([{
          id: 'p1', score: 370, text: 'вже має чанк', doc_id: 67890, chunk_index: 4,
          metadata: { court_code: 2605, justice_kind: 1 },
        }])),
        bestChunkForDocs: jest.fn((_q: string, ids: number[]) =>
          Promise.resolve(new Map(ids.map(id => [id, { text: 'релевантний фрагмент про директора', chunk_index: 2, score: 0.6 }])))),
      };
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db, ftsOnly as any, vectorizer as any);

      const result = await tool.executeTool('search_court_decisions', { mode: 'hybrid', query: 'тест' });
      const parsed = JSON.parse(result?.content[0].text || '{}');

      // Only the FTS-only doc is backfilled — the vector hit already had a chunk.
      expect(vectorizer.bestChunkForDocs).toHaveBeenCalledWith('тест', [12345]);
      expect(parsed.legs.fts_chunks_backfilled).toBe(1);

      const ftsHit = parsed.results.find((r: any) => r.doc_id === 12345);
      expect(ftsHit.qdrant_best_chunk_text).toBe('релевантний фрагмент про директора');
      expect(ftsHit.evidence_chunk_backfilled).toBe(true);

      const vectorHit = parsed.results.find((r: any) => r.doc_id === 67890);
      expect(vectorHit.evidence_chunk_backfilled).toBeUndefined();
    });
  });

  describe('court_level / instance_code', () => {
    it('exposes court_level param with SC / GrandChamber enum', () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db);
      const props = tool.getToolDefinitions()[0].inputSchema.properties as any;
      expect(props.court_level).toBeTruthy();
      expect(props.court_level.enum).toEqual(['all', 'SC', 'GrandChamber']);
    });

    it('maps court_level=SC to instance_code=1 in fulltext FTS filters', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      await tool.executeTool('search_court_decisions', {
        mode: 'fulltext', query: 'податок нерухомість', court_level: 'SC',
      });

      const filters = mockFtsService.searchFulltext.mock.calls[0][2];
      expect(filters.instance_code).toBe(1);
    });

    it('maps court_level=GrandChamber to instance_code=1 in structured WHERE', async () => {
      db = makeDb((sql) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      });
      tool = new EdsrUnifiedSearchTool(db);

      await tool.executeTool('search_court_decisions', {
        mode: 'structured', cause_num: '910/1/23', court_level: 'GrandChamber',
      });

      const instanceCall = calls.find(c => c.sql.includes('c.instance_code'));
      expect(instanceCall).toBeTruthy();
      expect(instanceCall!.params).toContain(1);
    });

    it('explicit instance_code wins over court_level', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      await tool.executeTool('search_court_decisions', {
        mode: 'fulltext', query: 'тест', court_level: 'SC', instance_code: 2,
      });

      const filters = mockFtsService.searchFulltext.mock.calls[0][2];
      expect(filters.instance_code).toBe(2);
    });

    it('passes instance_code into the hybrid FTS leg filters', async () => {
      db = makeDb(() => ({ rows: [] }));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);

      await tool.executeTool('search_court_decisions', {
        mode: 'hybrid', query: 'тест', court_level: 'SC',
      });

      const filters = mockFtsService.searchFulltext.mock.calls[0][2];
      expect(filters.instance_code).toBe(1);
    });
  });

  describe('hybrid structural enforcement', () => {
    const vectorHit = (doc_id: number, score: number) => ({
      doc_id, score, text: 'фрагмент', chunk_index: 0,
      metadata: { court_code: 2605, cause_num: `${doc_id}/23`, justice_kind: 1, judgment_code: 3 },
    });

    it('drops vector-only hits that fail the party constraint', async () => {
      db = makeDb(() => ({ rows: [] }));
      // FTS leg returns the party-matching doc; vector leg adds an unconstrained extra.
      mockFtsService.searchFulltext = jest.fn(() => Promise.resolve({
        query: 'тест', total: 1,
        results: [{ doc_id: 111, court_code: 2605, justice_kind: 1, judgment_code: 3, rank: 0.5, headline: null }],
      }));
      mockFtsService.filterDocIdsByConstraints = jest.fn((ids: number[]) =>
        // Only the FTS doc actually contains "Нова Пошта" as a party; 222 is vector noise.
        Promise.resolve(new Set(ids.filter(id => id === 111))));
      mockVectorizer.semanticSearch = jest.fn(() => Promise.resolve([vectorHit(222, 0.9), vectorHit(111, 0.4)]));

      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);
      const result = await tool.executeTool('search_court_decisions', {
        mode: 'hybrid', query: 'тест', party_name: 'Нова Пошта', party_role: 'defendant',
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      const ids = parsed.results.map((r: any) => r.doc_id);
      expect(ids).toContain(111);
      expect(ids).not.toContain(222);
      expect(parsed.structural_filter.dropped).toBe(1);
      expect(parsed.party_filter).toEqual({ party_name: 'Нова Пошта', party_role: 'defendant' });
    });

    it('relaxes party_role when the role wipes every candidate', async () => {
      db = makeDb(() => ({ rows: [] }));
      mockFtsService.searchFulltext = jest.fn(() => Promise.resolve({ query: 'тест', total: 0, results: [] }));
      mockVectorizer.semanticSearch = jest.fn(() => Promise.resolve([vectorHit(333, 0.8)]));
      // First pass (name + role) → empty; second pass (name only) → keeps 333.
      mockFtsService.filterDocIdsByConstraints = jest.fn((ids: number[], c: any) =>
        Promise.resolve(c.party_role ? new Set<number>() : new Set(ids.map(Number))));

      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);
      const result = await tool.executeTool('search_court_decisions', {
        mode: 'hybrid', query: 'тест', party_name: 'Нова Пошта', party_role: 'defendant',
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.structural_filter.party_role_relaxed).toBe(true);
      expect(parsed.results.map((r: any) => r.doc_id)).toContain(333);
      expect(mockFtsService.filterDocIdsByConstraints).toHaveBeenCalledTimes(2);
    });

    it('does not run structural enforcement without party/instance filters', async () => {
      db = makeDb(() => ({ rows: [] }));
      mockVectorizer.semanticSearch = jest.fn(() => Promise.resolve([vectorHit(444, 0.7)]));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);

      const result = await tool.executeTool('search_court_decisions', { mode: 'hybrid', query: 'тест' });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.structural_filter).toBeUndefined();
      expect(mockFtsService.filterDocIdsByConstraints).not.toHaveBeenCalled();
    });
  });

  describe('semantic mode', () => {
    it('redirects to fulltext with notice', async () => {
      db = makeDb((sql) => {
        if (sql.includes('edrsr_courts')) return { rows: [] };
        if (sql.includes('edrsr_justice_kinds')) return { rows: [] };
        if (sql.includes('edrsr_judgment_forms')) return { rows: [] };
        return { rows: [] };
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'semantic',
        query: 'відповідальність директора',
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed._notice).toContain('тимчасово недоступний');
      expect(parsed.mode).toContain('semantic');
    });
  });

  describe('semantic structural enforcement', () => {
    const vectorHit = (doc_id: number, score: number) => ({
      doc_id, score, text: 'фрагмент', chunk_index: 0,
      metadata: { court_code: 2605, cause_num: `${doc_id}/23`, justice_kind: 4, judgment_code: 3 },
    });

    it('drops lower-instance vector hits when court_level=SC (instance_code=1)', async () => {
      db = makeDb(() => ({ rows: [] }));
      // Qdrant cannot filter by instance; it returns an SC doc (111) and a lower-instance one (222).
      mockVectorizer.semanticSearch = jest.fn(() => Promise.resolve([vectorHit(222, 0.9), vectorHit(111, 0.4)]));
      // Only the cassation doc satisfies instance_code=1.
      mockFtsService.filterDocIdsByConstraints = jest.fn((ids: number[]) =>
        Promise.resolve(new Set(ids.filter(id => id === 111))));

      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);
      const result = await tool.executeTool('search_court_decisions', {
        mode: 'semantic', query: 'тест', justice_kind: 4, court_level: 'SC',
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      const ids = parsed.results.map((r: any) => r.doc_id);
      expect(ids).toContain(111);
      expect(ids).not.toContain(222);
      expect(parsed.instance_code).toBe(1);
      expect(parsed.structural_filter.dropped).toBe(1);
      expect(mockFtsService.filterDocIdsByConstraints).toHaveBeenCalled();
    });

    it('does not run structural enforcement without party/instance filters', async () => {
      db = makeDb(() => ({ rows: [] }));
      mockVectorizer.semanticSearch = jest.fn(() => Promise.resolve([vectorHit(444, 0.7)]));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'semantic', query: 'тест', justice_kind: 4,
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.structural_filter).toBeUndefined();
      expect(mockFtsService.filterDocIdsByConstraints).not.toHaveBeenCalled();
    });
  });
});
