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
import { EdsrUnifiedSearchTool, hybridFtsCandidateCap } from '../tools/edrsr-unified-search-tool.js';

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

    // LEXAI-2109: without a metadata filter searchFulltext returns bare doc_id/rank/headline
    // rows, and fulltext mode showed court_name/justice_kind_name/judgment_form as null.
    it('fills court, justice kind and form for bare FTS rows from edrsr_documents', async () => {
      mockFtsService.searchFulltext = jest.fn(() => Promise.resolve({
        query: 'тест', total: 1, results: [{ doc_id: '12345', headline: 'тест', rank: 0.5 }],
      }));
      db = makeDb((sql) => {
        if (sql.includes('FROM edrsr_documents')) {
          return { rows: [{ doc_id: '12345', court_code: 2605, cause_num: '756/1234/23', judge: 'Іванов І.І.', justice_kind: 1, judgment_code: 3, adjudication_date: '2024-06-14T21:00:00.000Z' }] };
        }
        if (sql.includes('edrsr_courts')) return { rows: [{ court_code: 2605, name: 'Оболонський' }] };
        if (sql.includes('edrsr_justice_kinds')) return { rows: [{ justice_kind: 1, name: 'Цивільне' }] };
        if (sql.includes('edrsr_judgment_forms')) return { rows: [{ judgment_code: 3, name: 'Рішення' }] };
        return { rows: [] };
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      const result = await tool.executeTool('search_court_decisions', { mode: 'fulltext', query: 'тест' });
      const r = JSON.parse(result?.content[0].text || '{}').results[0];
      expect(r.cause_num).toBe('756/1234/23');
      expect(r.court_name).toBe('Оболонський');
      expect(r.justice_kind_name).toBe('Цивільне');
      expect(r.judgment_form).toBe('Рішення');
      expect(r.adjudication_date).toBeTruthy();
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

  // LEXAI-2085: a timed-out FTS probe came back as an ordinary empty page, so relaxation,
  // role relaxation and the hybrid fallback each re-ran it — past the 120 s tool cap.
  describe('FTS timeout (LEXAI-2085)', () => {
    const timedOut = (q: string) => Promise.resolve({ query: q, total: 0, returned: 0, offset: 0, has_more: false, results: [], timed_out: true });
    const novaPoshta = {
      mode: 'fulltext', query: 'Нова Пошта втрата посилки відшкодування',
      party_name: 'Нова Пошта', party_role: 'defendant', limit: 5,
    };

    it('does not relax or re-probe a timed-out probe; hybrid runs without its FTS leg', async () => {
      db = makeDb(() => ({ rows: [] }));
      mockFtsService.searchFulltext = jest.fn((q: string) => timedOut(q));
      mockVectorizer.semanticSearch = jest.fn(() => Promise.resolve([]));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);

      const result = await tool.executeTool('search_court_decisions', novaPoshta);

      expect(mockFtsService.searchFulltext).toHaveBeenCalledTimes(1);
      expect(mockVectorizer.semanticSearch).toHaveBeenCalled();
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.mode).toBe('hybrid');
      expect(parsed.fallback_from).toBe('fulltext_timeout');
      expect(parsed.legs.fts_timed_out).toBe(true);
      expect(parsed._notice).toContain('не вклався в ліміт часу');
      expect(parsed._notice).toContain('«Нова Пошта»');
    });

    it('answers with Ukrainian advice when there is no vector leg to fall back to', async () => {
      db = makeDb(() => ({ rows: [] }));
      mockFtsService.searchFulltext = jest.fn((q: string) => timedOut(q));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);

      const result = await tool.executeTool('search_court_decisions', novaPoshta);

      expect(mockFtsService.searchFulltext).toHaveBeenCalledTimes(1);
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('Повнотекстовий пошук за стороною «Нова Пошта» не вклався в ліміт часу');
      expect(result?.content[0].text).toContain('date_from/date_to');
    });

    it('retries a topical probe once with the small cap (2087), then hybrid skips its FTS leg', async () => {
      db = makeDb(() => ({ rows: [] }));
      const caps: any[] = [];
      mockFtsService.searchFulltext = jest.fn((q: string, ...rest: any[]) => {
        caps.push(rest[6]?.candidateCap);
        return timedOut(q);
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'fulltext', query: 'стягнення моральної шкоди затримка виплати', limit: 5,
      });

      // First probe at the default cap, one retry at 100 — then no relaxation, no FTS leg in hybrid.
      expect(caps).toEqual([undefined, 100]);
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.fallback_from).toBe('fulltext_timeout');
      expect(parsed.legs.fts_timed_out).toBe(true);
    });

    it('starts no new FTS probe once the shared 40 s budget is spent', async () => {
      db = makeDb(() => ({ rows: [] }));
      const realNow = Date.now;
      let now = 1_000_000;
      (Date as any).now = () => now;
      try {
        mockFtsService.searchFulltext = jest.fn((q: string) => {
          now += 41_000; // every probe "takes" longer than the whole budget
          return Promise.resolve({ query: q, total: 0, returned: 0, offset: 0, has_more: false, results: [] });
        });
        tool = new EdsrUnifiedSearchTool(db, mockFtsService);

        await tool.executeTool('search_court_decisions', novaPoshta);
      } finally {
        (Date as any).now = realNow;
      }
      // One probe: no term relaxation and no role relaxation after the deadline.
      expect(mockFtsService.searchFulltext).toHaveBeenCalledTimes(1);
    });

    it('hybrid mode reports the FTS timeout when the vector leg has nothing either', async () => {
      db = makeDb(() => ({ rows: [] }));
      mockFtsService.searchFulltext = jest.fn((q: string) => timedOut(q));
      const failingVector = { semanticSearch: jest.fn(() => Promise.reject(new Error('Qdrant down'))) };
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, failingVector as any);

      const result = await tool.executeTool('search_court_decisions', { ...novaPoshta, mode: 'hybrid' });

      expect(mockFtsService.searchFulltext).toHaveBeenCalledTimes(1);
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('не вклався в ліміт часу');
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

  describe('FTS statement timeout is not "too narrow" (LEXAI-2087)', () => {
    // The reformulation observed in prod for "стягнення моральної шкоди за затримку виплати
    // заробітної плати": 16 terms. Every probe hit the 8s FTS timeout, the relax loop read the
    // empty response as an over-narrow AND-chain and dropped a term 4 times (5 × 8s), and the
    // hybrid leg ended with fts_candidates 0 / fts_collapsed.
    const SIXTEEN = 'моральна шкода заробітна плата затримка виплата відшкодування трудовий спір роботодавець немайнова шкода стаття 237 116 117 КЗпП';
    const reformulator = { reformulate: jest.fn(() => Promise.resolve({ fts: SIXTEEN, semantic: 'відшкодування моральної шкоди' })) };
    const hit = (id: number) => ({ doc_id: id, rank: 0.4, headline: 'моральна шкода' });
    const tokens = (q: string) => q.split(/\s+/).filter(Boolean).length;

    it('hybrid: probes a capped term set with a small candidate cap and fills the FTS leg', async () => {
      db = makeDb(() => ({ rows: [] }));
      const seen: { q: string; opts: any }[] = [];
      mockFtsService.searchFulltext = jest.fn((q: string, _db: any, _f: any, _l: number, _o: number, _h: any, _tsq: any, opts: any) => {
        seen.push({ q, opts });
        return Promise.resolve({ query: q, total: 100, results: Array.from({ length: 15 }, (_v, i) => hit(1000 + i)) });
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);
      tool.setQueryReformulator(reformulator as any);

      const result = await tool.executeTool('search_court_decisions', { mode: 'hybrid', query: 'стягнення моральної шкоди за затримку виплати заробітної плати', limit: 5 });
      const parsed = JSON.parse(result?.content[0].text || '{}');

      expect(seen).toHaveLength(1);
      expect(tokens(seen[0].q)).toBe(6);                 // 16 terms capped, not all-AND
      expect(seen[0].opts).toEqual({ candidateCap: 100 }); // limit 5 × oversample 3 → floor 100
      expect(parsed.legs.fts_candidates).toBe(15);
      expect(parsed.legs.fts_collapsed).toBeUndefined();
      expect(parsed.legs.fts_timed_out).toBeUndefined();
    });

    it('hybrid: a timed-out probe stops instead of dropping terms (one probe, not five)', async () => {
      db = makeDb(() => ({ rows: [] }));
      const seen: string[] = [];
      mockFtsService.searchFulltext = jest.fn((q: string) => {
        seen.push(q);
        return Promise.resolve({ query: q, total: 0, timed_out: true, results: [] });
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);
      tool.setQueryReformulator(reformulator as any);

      const result = await tool.executeTool('search_court_decisions', { mode: 'hybrid', query: 'стягнення моральної шкоди', limit: 5 });
      const parsed = JSON.parse(result?.content[0].text || '{}');

      // cap 100 is already the retry cap → no retry, and never a relax probe
      expect(seen).toHaveLength(1);
      expect(parsed.legs.fts_timed_out).toBe(true);
    });

    it('fulltext: on timeout retries the SAME terms once with a small cap, then relaxes normally', async () => {
      db = makeDb(() => ({ rows: [] }));
      const seen: { q: string; opts: any }[] = [];
      mockFtsService.searchFulltext = jest.fn((q: string, _db: any, _f: any, _l: number, _o: number, _h: any, _tsq: any, opts: any) => {
        seen.push({ q, opts });
        if (!opts) return Promise.resolve({ query: q, total: 0, timed_out: true, results: [] });
        return Promise.resolve({ query: q, total: 100, total_is_floor: true, candidate_cap: 100, results: [hit(1), hit(2), hit(3)] });
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);
      tool.setQueryReformulator(reformulator as any);

      const result = await tool.executeTool('search_court_decisions', { mode: 'fulltext', query: 'стягнення моральної шкоди за затримку виплати заробітної плати' });
      const parsed = JSON.parse(result?.content[0].text || '{}');

      expect(seen).toHaveLength(2);
      expect(seen[1].q).toBe(seen[0].q);                // same terms — no term dropped on timeout
      expect(seen[0].opts).toBeUndefined();             // default cap first
      expect(seen[1].opts).toEqual({ candidateCap: 100 });
      expect(parsed.total).toBe(100);
      expect(parsed.term_relaxed).toBeUndefined();
      expect(parsed.fts_timed_out).toBe(true);
    });

    it('fulltext: gives up after the retry also times out (2 probes, not 5 × 8s)', async () => {
      db = makeDb(() => ({ rows: [] }));
      const seen: string[] = [];
      mockFtsService.searchFulltext = jest.fn((q: string) => {
        seen.push(q);
        return Promise.resolve({ query: q, total: 0, timed_out: true, results: [] });
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService); // no vectorizer → no hybrid fallback
      tool.setQueryReformulator(reformulator as any);

      await tool.executeTool('search_court_decisions', { mode: 'fulltext', query: 'стягнення моральної шкоди' });
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe(seen[0]);
    });

    it('still relaxes a genuinely empty (non-timed-out) probe', async () => {
      db = makeDb(() => ({ rows: [] }));
      const seen: string[] = [];
      mockFtsService.searchFulltext = jest.fn((q: string) => {
        seen.push(q);
        return Promise.resolve(tokens(q) <= 3
          ? { query: q, total: 40, results: [hit(1)] }
          : { query: q, total: 0, results: [] });
      });
      tool = new EdsrUnifiedSearchTool(db, mockFtsService);
      tool.setQueryReformulator(reformulator as any);

      const result = await tool.executeTool('search_court_decisions', { mode: 'fulltext', query: 'стягнення моральної шкоди' });
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(seen.map(tokens)).toEqual([6, 5, 4, 3]);
      expect(parsed.term_relaxed).toEqual({ from_tokens: 6, to_tokens: 3 });
    });
  });

  describe('hybridFtsCandidateCap', () => {
    it('ranks ~5 candidates per needed hit, within [100, 500]', () => {
      expect(hybridFtsCandidateCap(15)).toBe(100);
      expect(hybridFtsCandidateCap(30)).toBe(150);
      expect(hybridFtsCandidateCap(250)).toBe(500);
      expect(hybridFtsCandidateCap(0)).toBe(100);
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

    it('reports the candidate pool, not a corpus total', async () => {
      db = makeDb(() => ({ rows: [] }));
      // Two chunks of doc 555 plus one of 666: the pool is 2 documents, not 3 chunks,
      // and certainly not "2 matching decisions in ЄДРСР".
      mockVectorizer.semanticSearch = jest.fn(() => Promise.resolve([
        vectorHit(555, 0.9), vectorHit(555, 0.8), vectorHit(666, 0.7),
      ]));
      tool = new EdsrUnifiedSearchTool(db, mockFtsService, mockVectorizer);

      const result = await tool.executeTool('search_court_decisions', {
        mode: 'semantic', query: 'тест', limit: 1,
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.total).toBeUndefined();
      expect(parsed.candidates).toBe(2);
      expect(parsed.returned).toBe(1);
      expect(parsed.note).toContain('limit');
      expect(mockVectorizer.semanticSearch).toHaveBeenCalledWith('тест', expect.anything(), 3);
    });
  });
});
