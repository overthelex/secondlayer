/**
 * Legal Advice Tools - Handlers for precedent search, citation analysis, and answer formatting
 *
 * 4 tools:
 * - format_answer_pack
 * - search_legal_precedents
 * - get_similar_reasoning
 * - get_citation_graph
 */

import { load } from 'cheerio';
import { QueryPlanner } from '../../services/query-planner.js';
import { EdsrLocalAdapter } from '../../adapters/edrsr-local-adapter.js';
import { SemanticSectionizer } from '../../services/semantic-sectionizer.js';
import type { IEmbeddingPort, ILLMPort } from '../../domain/ports/index.js';
import { LegalPatternStore } from '../../services/legal-pattern-store.js';
import { CitationValidator } from '../../services/citation-validator.js';
import type { CitationGraphService } from '../../services/citation-graph-service.js';
import { ShepardizationService, ShepardizationResult } from '../../services/shepardization-service.js';
import type { EdsrFtsService, EdsrFtsFilters, EdsrFtsResult } from '../../services/edrsr-fts-service.js';
import { SectionType } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { CourtDecisionHTMLParser, extractSearchTermsWithAI } from '../../utils/html-parser.js';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { countAllResults, buildSupremeCourtWhereFilter, mapProcedureCodeToJusticeKind, extractSnippets, formatCourtDate } from '../tool-utils.js';

/** Max cases to enrich with precedent status per search (cost/latency guard) */
const MAX_SHEPARDIZATION_BATCH = 15;

export class LegalAdviceTools extends BaseToolHandler {
  constructor(
    private queryPlanner: QueryPlanner,
    private zoAdapter: EdsrLocalAdapter,
    private zoPracticeAdapter: EdsrLocalAdapter,
    private sectionizer: SemanticSectionizer,
    private embeddingService: IEmbeddingPort,
    private patternStore: LegalPatternStore,
    private citationValidator: CitationValidator,
    private shepardizationService?: ShepardizationService,
    private readonly llm?: ILLMPort,
    private readonly db?: { query: (sql: string, params?: any[]) => Promise<any> },
    private readonly ftsService?: EdsrFtsService,
    private readonly citationGraphService?: CitationGraphService
  ) {
    super();
  }

  /**
   * Resolve any case identifier (UUID, numeric doc_id, case_number) to the EDRSR
   * doc_id (bigint as string) used as the Decision key in the Neo4j citation graph.
   * Chain: UUID → documents.zakononline_id; case_number → edrsr_documents.doc_id; numeric → as-is.
   */
  private async resolveToEdrsrDocId(input: string): Promise<string | null> {
    if (!this.db) return null;
    if (/^\d+$/.test(input)) return input;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(input)) {
      const doc = await this.db.query(
        `SELECT zakononline_id::text AS doc_id FROM documents WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [input]
      );
      return doc.rows[0]?.doc_id ?? null;
    }

    const edrsr = await this.db.query(
      `SELECT doc_id::text AS doc_id FROM edrsr_documents WHERE cause_num = $1 ORDER BY adjudication_date DESC NULLS LAST LIMIT 1`,
      [input]
    );
    return edrsr.rows[0]?.doc_id ?? null;
  }

  /** Map EDRSR FTS rows to the case shape this tool's responses expose. */
  private mapFtsResults(rows: EdsrFtsResult[]): any[] {
    return rows.map((r) => ({
      doc_id: r.doc_id,
      cause_num: r.cause_num,
      judge: r.judge,
      court_code: r.court_code,
      justice_kind: r.justice_kind,
      adjudication_date: formatCourtDate(r.adjudication_date),
      url: `https://reyestr.court.gov.ua/Review/${r.doc_id}`,
      ...(r.headline ? { headline: r.headline } : {}),
      ...(r.rank != null ? { rank: r.rank } : {}),
    }));
  }

  /** Build EDRSR FTS filters from court_level (SC → cassation) + procedure_code. */
  private buildEdsrFilters(courtLevel?: string, procedureCode?: string): EdsrFtsFilters {
    const f: EdsrFtsFilters = {};
    if (procedureCode) {
      const jk = mapProcedureCodeToJusticeKind(procedureCode);
      if (jk !== null) f.justice_kind = jk;
    }
    if (courtLevel && courtLevel !== 'all') f.instance_code = 1; // Supreme Court = cassation
    return f;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'format_answer_pack',
        annotations: { title: 'Пакування відповіді' },
        description: `Пакування результату в структуру norm/position/conclusion/risks (структурне, без генерації тексту)`,
        inputSchema: {
          type: 'object',
          properties: {
            desired_output: { type: 'string' },
            norm: { type: ['object', 'string', 'null'] },
            position: { type: ['object', 'string', 'null'] },
            conclusion: { type: ['object', 'string', 'null'] },
            risks: { type: ['object', 'string', 'null'] },
          },
          required: [],
        },
      },
      {
        name: 'search_legal_precedents',
        annotations: { title: 'Пошук прецедентів', readOnlyHint: true, openWorldHint: true },
        description: `Пошук юридичних прецедентів із семантичним аналізом

Підтримує фільтрацію за рівнем суду (court_level) для пошуку практики Верховного Суду (ВП/КЦС/КГС/КАС/ККС) та за видом судочинства (procedure_code).
Повертає: релевантні рішення з цитатами, оцінкою релевантності, секціями мотивувальної частини.
Використовуйте для побудови правової позиції на основі усталеної практики.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковий запит' },
            domain: {
              type: 'string',
              enum: ['court', 'npa', 'echr', 'all'],
              default: 'all',
            },
            court_level: {
              type: 'string',
              enum: ['all', 'SC', 'GrandChamber'],
              default: 'all',
              description: 'Фільтр за рівнем суду: all (всі), SC (Верховний Суд: КЦС/КГС/КАС/ККС), GrandChamber (Велика Палата ВС)',
            },
            procedure_code: {
              type: 'string',
              enum: ['cpc', 'gpc', 'cac', 'crpc'],
              description: 'Вид судочинства: cpc (цивільне), gpc (господарське), cac (адміністративне), crpc (кримінальне)',
            },
            time_range: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
            },
            limit: { type: 'number', default: 10 },
            offset: { type: 'number', default: 0 },
            count_all: {
              type: 'boolean',
              default: false,
              description: 'Підрахувати ВСІ результати через пагінацію (може бути дорого).',
            },
            sections: {
              type: 'array',
              items: { type: 'string', enum: Object.values(SectionType) },
            },
            section_focus: {
              type: 'array',
              items: { type: 'string', enum: Object.values(SectionType) },
              description: 'Секції рішень для витягу сніпетів (коли court_level != all)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_similar_reasoning',
        annotations: { title: 'Схожі обґрунтування', readOnlyHint: true },
        description: `Пошук схожих судових обґрунтувань за векторною подібністю

Векторний пошук по ембедінгах через Qdrant. Знаходить рішення зі схожою аргументацією суду.
Використовуйте для пошуку рішень, де суд використав аналогічну логіку обґрунтування.
Підтримує фільтри: дата, суд, палата, категорія спору, результат.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            section_type: { type: 'string', enum: Object.values(SectionType) },
            date_from: { type: 'string', description: 'YYYY-MM-DD' },
            date_to: { type: 'string', description: 'YYYY-MM-DD' },
            court: { type: 'string' },
            chamber: { type: 'string' },
            dispute_category: { type: 'string' },
            outcome: { type: 'string' },
            deviation_flag: { type: ['boolean', 'null'] },
            precedent_status: { type: 'string' },
            case_number: { type: 'string' },
            limit: { type: 'number', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_citation_graph',
        annotations: { title: 'Граф цитувань', readOnlyHint: true, idempotentHint: true },
        description: `Граф цитувань судового рішення: на які НОРМИ/СТАТТІ законодавства воно посилається (decision→article).

Повертає зв'язки рішення→стаття (CITES_ARTICLE), батьківський закон кожної статті (OF_LAW) та споріднені co-cited норми. НЕ будує граф рішення↔рішення.
Приймає case_id — UUID/doc_id документа або номер справи (наприклад "756/1234/23"). Номер справи автоматично конвертується в doc_id. depth керує глибиною обходу.
Використовуйте для аналізу правової основи рішення. Покриття часткове (переважно старіші рішення з завантаженого екстракту) — порожній граф означає брак даних графа, а не відсутність цитувань.`,
        inputSchema: {
          type: 'object',
          properties: {
            case_id: { type: 'string', description: 'UUID/doc_id документа або номер справи (cause_num)' },
            depth: { type: 'number', default: 2 },
          },
          required: ['case_id'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'format_answer_pack':
        return await this.formatAnswerPack(args);
      case 'search_legal_precedents':
      case 'search_supreme_court_practice': // backward-compat alias
        return await this.searchLegalPrecedents(args);
      case 'get_similar_reasoning':
        return await this.getSimilarReasoning(args);
      case 'get_citation_graph':
        return await this.getCitationGraph(args);
      default:
        return null;
    }
  }

  private async formatAnswerPack(args: any): Promise<ToolResult> {
    const desiredOutput = typeof args.desired_output === 'string' ? args.desired_output : undefined;
    return this.wrapResponse({
      desired_output: desiredOutput,
      norm: args.norm || args.legal_framework || null,
      position: args.position || args.practice || null,
      conclusion: args.conclusion || null,
      risks: args.risks || args.counterarguments_and_risks || null,
      warning: 'format_answer_pack currently performs a structural packaging only.',
    });
  }

  private async getSimilarReasoning(args: any): Promise<ToolResult> {
    const defaultDateFrom = (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 3);
      return d.toISOString().slice(0, 10);
    })();
    const defaultSupremeCourtChambers = ['ВП ВС', 'КЦС', 'КГС', 'КАС', 'ККС'];

    const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);
    const similar = await this.embeddingService.searchSimilar(
      queryEmbedding,
      {
        section_type: args.section_type as SectionType,
        date_from: args.date_from || defaultDateFrom,
        date_to: args.date_to,
        court: args.court,
        chamber: args.chamber || defaultSupremeCourtChambers,
        dispute_category: args.dispute_category,
        outcome: args.outcome,
        deviation_flag: args.deviation_flag,
        precedent_status: args.precedent_status,
        case_number: args.case_number,
      },
      args.limit || 10
    );

    return this.wrapResponse({ similar });
  }

  /**
   * Resolve any case identifier (UUID, numeric doc_id, case_number) to
   * the documents.id UUID used by citation_links.
   *
   * Chain: case_number → edrsr_documents.doc_id → documents.zakononline_id → documents.id (UUID)
   */
  private async resolveToDocumentsUUID(input: string): Promise<string | null> {
    if (!this.db) return null;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(input)) return input;

    // Numeric doc_id or case_number — both need documents.id lookup
    let zoId = input;

    if (!/^\d+$/.test(input)) {
      // Case number (e.g. "176/973/26") → find doc_id in edrsr_documents
      const edrsr = await this.db.query(
        `SELECT doc_id::text AS doc_id FROM edrsr_documents WHERE cause_num = $1 ORDER BY adjudication_date DESC NULLS LAST LIMIT 1`,
        [input]
      );
      if (edrsr.rows.length === 0) return null;
      zoId = edrsr.rows[0].doc_id;
    }

    // Numeric doc_id → documents.id UUID via zakononline_id
    const doc = await this.db.query(
      `SELECT id FROM documents WHERE zakononline_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [zoId]
    );
    if (doc.rows.length > 0) return doc.rows[0].id;

    // No matching UUID in documents table — return null to avoid passing integer as UUID
    return null;
  }

  private async getCitationGraph(args: any): Promise<ToolResult> {
    const input = String(args.case_id).trim();
    const depth = args.depth || 2;

    // CITATION_BACKEND=neo4j → serve the decision→article graph from Neo4j.
    if (this.citationGraphService?.isEnabled()) {
      const docId = await this.resolveToEdrsrDocId(input);
      if (!docId) {
        return this.wrapResponse({
          error: `Не вдалося конвертувати "${input}" у doc_id ЄДРСР для графа цитувань.`,
          provided_value: input,
          backend: 'neo4j',
        });
      }
      try {
        const graph = await this.citationGraphService.getCitationGraph(docId, depth);
        return this.wrapResponse({ graph, backend: 'neo4j' });
      } catch (error: any) {
        logger.error('[LegalAdviceTools] Neo4j citation graph failed', { input, docId, error: error?.message });
        return this.wrapResponse({
          error: 'Граф цитувань (Neo4j) тимчасово недоступний.',
          detail: error?.message,
          provided_value: input,
          backend: 'neo4j',
        });
      }
    }

    if (!this.db) {
      // No DB — only UUID passthrough works
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(input)) {
        return this.wrapResponse({
          error: `Параметр case_id "${input}" не є UUID, а БД недоступна для конвертації.`,
          provided_value: input,
        });
      }
      const graph = await this.citationValidator.buildCitationGraph(input, args.depth || 2);
      return this.wrapResponse({ graph });
    }

    const resolvedId = await this.resolveToDocumentsUUID(input);

    if (!resolvedId) {
      return this.wrapResponse({
        error: `Справу "${input}" знайдено в ЄДРСР, але вона ще не імпортована до бази цитувань (documents). Граф цитувань поки недоступний для цього рішення.`,
        provided_value: input,
        hint: 'Використовуйте get_court_decision або get_case_documents_chain для перегляду рішення.',
      });
    }

    if (resolvedId !== input) {
      logger.info('[LegalAdviceTools] Resolved case_id to documents UUID', {
        input,
        resolved: resolvedId,
      });
    }

    const graph = await this.citationValidator.buildCitationGraph(resolvedId, args.depth || 2);
    return this.wrapResponse({ graph });
  }

  private async searchLegalPrecedents(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query parameter is required and cannot be empty');

    logger.info('[MCP Tool] search_legal_precedents called', {
      query: query.substring(0, 100),
      limit: args.limit || 10,
      offset: args.offset || 0,
      count_all: args.count_all || false,
    });

    if (args.count_all === true) {
      if (!this.ftsService || !this.db) throw new Error('FTS сервіс недоступний');
      const countResult = await countAllResults(this.ftsService, this.db, query);
      return this.wrapResponse({
        query,
        count_all_mode: true,
        total_count: countResult.total_count,
        time_taken_ms: countResult.time_taken_ms,
        note: 'Оцінка кількості через FTS (точний підрахунок доступний для пошуку за стороною — count_cases_by_party).',
        // Include first page results so the right panel can display decisions
        results: countResult.first_results,
      });
    }

    // Case number detection for semantic search
    const caseNumberPattern = /\b(\d{1,4}\/\d{1,6}\/\d{2}(-\w)?)\b/;
    const caseNumberMatch = query.match(caseNumberPattern);

    if (caseNumberMatch && this.ftsService && this.db) {
      const caseNumber = caseNumberMatch[1];
      try {
        // Load the source case straight from the prod EDRSR DB (replaces dead ZO stub).
        const srcRes = await this.db.query(
          `SELECT d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
                  d.category_code, d.adjudication_date, f.full_text
           FROM edrsr_documents d
           LEFT JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
           WHERE d.cause_num = $1
           ORDER BY d.adjudication_date DESC NULLS LAST
           LIMIT 1`,
          [caseNumber],
        );
        const sourceCase = srcRes.rows?.[0];
        if (!sourceCase) return await this.performRegularSearch(args);

        const textForAnalysis = typeof sourceCase.full_text === 'string'
          ? sourceCase.full_text.substring(0, 5000)
          : '';
        if (!textForAnalysis || textForAnalysis.length < 50) return await this.performRegularSearch(args);

        const searchTerms = await extractSearchTermsWithAI(textForAnalysis, this.llm);
        const smartQuery = searchTerms.searchQuery || searchTerms.disputeType || '';
        if (!smartQuery) return await this.performRegularSearch(args);

        const requestedDisplay = Math.min(50, Math.max(1, Number(args.limit || 10)));
        const ftsResp = await this.ftsService.searchFulltext(
          smartQuery, this.db, {}, Math.max(requestedDisplay * 2, 20), 0,
        );
        const similarCasesForDisplay = this.mapFtsResults(
          ftsResp.results.filter((r) => r.doc_id !== sourceCase.doc_id),
        ).slice(0, requestedDisplay).map((c) => ({ ...c, similarity_reason: 'fts_keywords' }));

        const enrichedSimilar = await this.enrichWithPrecedentStatus(similarCasesForDisplay);

        return this.wrapResponse({
          source_case: {
            cause_num: sourceCase.cause_num,
            doc_id: sourceCase.doc_id,
            judge: sourceCase.judge,
            court_code: sourceCase.court_code,
            adjudication_date: formatCourtDate(sourceCase.adjudication_date),
            url: `https://reyestr.court.gov.ua/Review/${sourceCase.doc_id}`,
            category_code: sourceCase.category_code,
            justice_kind: sourceCase.justice_kind,
          },
          search_method: 'smart_fts_search',
          text_length: textForAnalysis.length,
          extracted_terms: {
            law_articles: searchTerms.lawArticles,
            keywords: searchTerms.keywords,
            dispute_type: searchTerms.disputeType,
            case_essence: searchTerms.caseEssence,
          },
          search_query: smartQuery,
          similar_cases: enrichedSimilar,
          total_found: ftsResp.total,
          displaying: enrichedSimilar.length,
        });
      } catch (error: any) {
        logger.error('Smart FTS search failed, falling back to regular search', error);
        return await this.performRegularSearch(args);
      }
    }

    return await this.performRegularSearch(args);
  }

  private async performRegularSearch(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query parameter is required and cannot be empty');

    const limit = Math.min(50, Math.max(1, Number(args.limit || 10)));
    const offset = Math.max(0, Number(args.offset || 0));
    const courtLevel = args.court_level ? String(args.court_level) : undefined;
    const procedureCode = args.procedure_code ? String(args.procedure_code) : undefined;
    const sectionFocus = Array.isArray(args.section_focus) ? args.section_focus : undefined;

    if (!this.ftsService || !this.db) throw new Error('FTS сервіс недоступний для пошуку прецедентів');

    const budget = query.length < 30 ? 'quick' : 'standard';
    const intent = await this.queryPlanner.classifyIntent(query, budget as 'quick' | 'standard');
    // Optimize long queries — plainto_tsquery ANDs every token, so a long phrase matches little.
    const searchQuery = query.length > 40
      ? await this.queryPlanner.generateOptimizedSearchQuery(query, intent, budget as 'quick' | 'standard')
      : query;

    const filters = this.buildEdsrFilters(courtLevel, procedureCode);
    // Over-fetch when filtering by court level to compensate for the GrandChamber post-filter.
    const fetchLimit = (courtLevel && courtLevel !== 'all') ? Math.max(limit * 3, 30) : limit;

    const runFts = async (q: string) => {
      try {
        const resp = await this.ftsService!.searchFulltext(q, this.db, filters, fetchLimit, offset);
        return resp.results;
      } catch (error: any) {
        logger.warn('[search_legal_precedents] FTS leg failed', { error: error.message });
        return [];
      }
    };

    let rows = await runFts(searchQuery);

    // Relax-on-empty: strip operators, then fall back to the 4 most distinctive words.
    if (rows.length === 0) {
      const stripped = query.replace(/["'|()]/g, ' ').replace(/\s+/g, ' ').trim();
      if (stripped && stripped !== searchQuery) {
        rows = await runFts(stripped);
        if (rows.length === 0) {
          const keyWords = stripped.split(/\s+/).filter(w => w.length >= 6).slice(0, 4).join(' ');
          if (keyWords && keyWords !== stripped) rows = await runFts(keyWords);
        }
      }
    }

    let filtered = this.mapFtsResults(rows);
    // Grand Chamber lives under a single court_code (9901).
    if (courtLevel === 'GrandChamber') {
      filtered = filtered.filter((d: any) => String(d?.court_code || '') === '9901');
    }
    filtered = filtered.slice(0, limit);

    // Expose the FTS headline as a snippet when a section focus is requested.
    if (sectionFocus && filtered.length > 0) {
      for (const r of filtered) {
        if (r.headline) r.snippets = [r.headline];
      }
    }

    const enriched = await this.enrichWithPrecedentStatus(filtered);

    return this.wrapResponse({
      results: enriched,
      intent,
      search_method: 'fts',
      total: enriched.length,
      ...(courtLevel && courtLevel !== 'all' ? { court_level: courtLevel } : {}),
      ...(procedureCode ? { procedure_code: procedureCode } : {}),
    });
  }

  /**
   * Enrich an array of search results with precedent status (case stability).
   * Uses ShepardizationService.batchAnalyze() to check the procedural chain
   * for each case and determine if it was upheld, overruled, or modified.
   */
  private async enrichWithPrecedentStatus(results: any[]): Promise<any[]> {
    if (!this.shepardizationService || results.length === 0) return results;

    // Extract unique case numbers from results (limit batch size for cost/latency)
    const caseNumbers = results
      .map(r => r.cause_num || r.case_number)
      .filter(Boolean)
      .slice(0, MAX_SHEPARDIZATION_BATCH);

    if (caseNumbers.length === 0) return results;

    try {
      const startTime = Date.now();
      const statuses = await this.shepardizationService.batchAnalyze(caseNumbers);
      const elapsed = Date.now() - startTime;

      // Build lookup map: case_number → ShepardizationResult
      const statusMap = new Map<string, ShepardizationResult>();
      for (const s of statuses) {
        statusMap.set(s.case_number, s);
      }

      logger.info('[LegalAdviceTools] Precedent status enrichment complete', {
        cases: caseNumbers.length,
        enriched: statuses.length,
        elapsed_ms: elapsed,
        statuses: {
          valid: statuses.filter(s => s.status === 'valid').length,
          overruled: statuses.filter(s => s.status === 'explicitly_overruled').length,
          limited: statuses.filter(s => s.status === 'limited').length,
          unknown: statuses.filter(s => s.status === 'unknown').length,
        },
      });

      // Merge status into each result
      return results.map(r => {
        const cn = r.cause_num || r.case_number;
        const status = cn ? statusMap.get(cn) : undefined;
        if (!status) return r;

        // Determine the highest court instance that reviewed this case
        let highestInstance: string | undefined;
        if (status.affecting_decisions.length > 0) {
          highestInstance = status.affecting_decisions[status.affecting_decisions.length - 1].instance;
        }
        // Fallback: infer from the result's own title/court (the result itself IS the highest instance doc)
        if (!highestInstance) {
          const title = (r.title || '').toLowerCase();
          if (title.includes('велика палата')) highestInstance = 'Велика Палата ВС';
          else if (title.includes('касаційний')) highestInstance = 'Касація';
          else if (title.includes('апеляційний')) highestInstance = 'Апеляція';
          else highestInstance = 'Перша інстанція';
        }

        return {
          ...r,
          precedent_status: {
            status: status.status,
            confidence: status.confidence,
            highest_instance: highestInstance,
            affecting_decisions: status.affecting_decisions.map(d => ({
              instance: d.instance,
              court: d.court,
              date: d.date,
              outcome: d.outcome,
              effect: d.effect,
            })),
            check_source: status.check_source,
            chain_length: status.chain_length,
          },
        };
      });
    } catch (err: any) {
      logger.warn('[LegalAdviceTools] Precedent status enrichment failed, returning results without status', {
        error: err.message,
        cases: caseNumbers.length,
      });
      return results;
    }
  }
}
