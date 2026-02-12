/**
 * Legal Advice Tools - Handlers for legal advice, precedent search, and citation analysis
 *
 * 5 tools:
 * - get_legal_advice
 * - format_answer_pack
 * - search_legal_precedents
 * - get_similar_reasoning
 * - get_citation_graph
 */

import { QueryPlanner } from '../../services/query-planner.js';
import { ZOAdapter } from '../../adapters/zo-adapter.js';
import { SemanticSectionizer } from '../../services/semantic-sectionizer.js';
import { EmbeddingService } from '../../services/embedding-service.js';
import { LegalPatternStore } from '../../services/legal-pattern-store.js';
import { CitationValidator } from '../../services/citation-validator.js';
import { HallucinationGuard } from '../../services/hallucination-guard.js';
import { LegislationTools } from '../legislation-tools.js';
import { SectionType, EnhancedMCPResponse, PackagedLawyerAnswer, LegalPattern } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { CourtDecisionHTMLParser, extractSearchTermsWithAI } from '../../utils/html-parser.js';
import { getOpenAIManager } from '../../utils/openai-client.js';
import { ModelSelector } from '../../utils/model-selector.js';
import { BaseToolHandler, ToolDefinition, ToolResult, StreamEventCallback } from '../base-tool-handler.js';
import { buildSupremeCourtHints, pickSectionTypesForAnswer, countAllResults } from '../tool-utils.js';

export class LegalAdviceTools extends BaseToolHandler {
  constructor(
    private queryPlanner: QueryPlanner,
    private zoAdapter: ZOAdapter,
    private zoPracticeAdapter: ZOAdapter,
    private sectionizer: SemanticSectionizer,
    private embeddingService: EmbeddingService,
    private patternStore: LegalPatternStore,
    private citationValidator: CitationValidator,
    private hallucinationGuard: HallucinationGuard,
    private legislationTools: LegislationTools
  ) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'get_legal_advice',
        description: `Главный инструмент: комплексный юридический анализ ситуации с проверкой источников и детекцией галлюцинаций

💰 Примерная стоимость: $0.10-$0.30 USD (зависит от reasoning_budget)
• quick: ~$0.10 (базовый анализ)
• standard: ~$0.15-$0.20 (рекомендуется)
• deep: ~$0.25-$0.30 (глубокий анализ с проверкой всех источников)

Самый дорогой инструмент. Включает множественные вызовы OpenAI API, ZakonOnline API, SecondLayer MCP и проверку галлюцинаций.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            reasoning_budget: {
              type: 'string',
              enum: ['quick', 'standard', 'deep'],
              default: 'standard',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'format_answer_pack',
        description: `Упаковщик результата в структуру norm/position/conclusion/risks (структурно, без генерации текста)`,
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
        description: `Поиск юридических прецедентов с семантическим анализом

💰 Примерная стоимость: $0.03-$0.10 USD
Стоимость зависит от сложности запроса и количества результатов. Включает OpenAI API (embeddings), ZakonOnline API (поиск), SecondLayer MCP (обработка документов).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            domain: {
              type: 'string',
              enum: ['court', 'npa', 'echr', 'all'],
              default: 'all',
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
              description: 'Подсчитать ВСЕ результаты через пагинацию (может быть дорого и долго).',
            },
            sections: {
              type: 'array',
              items: { type: 'string', enum: Object.values(SectionType) },
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_similar_reasoning',
        description: `Находит похожие судебные обоснования по векторному сходству

💰 Примерная стоимость: $0.01-$0.03 USD
Векторный поиск по эмбеддингам. Включает OpenAI API (embeddings) и Qdrant (векторная БД).`,
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
        description: `Строит граф цитирований между делами: прямые и обратные связи

💰 Примерная стоимость: $0.005-$0.02 USD
Построение графа из базы данных. Минимальная стоимость (только PostgreSQL запросы).`,
        inputSchema: {
          type: 'object',
          properties: {
            case_id: { type: 'string' },
            depth: { type: 'number', default: 2 },
          },
          required: ['case_id'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'get_legal_advice':
        return await this.getLegalAdvice(args);
      case 'format_answer_pack':
        return await this.formatAnswerPack(args);
      case 'search_legal_precedents':
        return await this.searchLegalPrecedents(args);
      case 'get_similar_reasoning':
        return await this.getSimilarReasoning(args);
      case 'get_citation_graph':
        return await this.getCitationGraph(args);
      default:
        return null;
    }
  }

  async executeToolStream(name: string, args: any, callback: StreamEventCallback): Promise<ToolResult | null> {
    if (name === 'get_legal_advice') {
      return await this.getLegalAdviceStream(args, callback);
    }
    return null;
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

  private async getCitationGraph(args: any): Promise<ToolResult> {
    const graph = await this.citationValidator.buildCitationGraph(args.case_id, args.depth || 2);
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
      const countResult = await countAllResults(this.zoAdapter, query);
      return this.wrapResponse({
        query,
        count_all_mode: true,
        total_count: countResult.total_count,
        pages_fetched: countResult.pages_fetched,
        time_taken_ms: countResult.time_taken_ms,
        cost_estimate_usd: countResult.cost_estimate_usd,
        note: 'Подсчитано через пагинацию с limit=1000. Документы НЕ загружались для экономии стоимости.',
        warning: countResult.total_count >= 10000000
          ? 'Достигнут лимит безопасности в 10,000,000 результатов.'
          : null,
      });
    }

    // Case number detection for semantic search
    const caseNumberPattern = /\b(\d{1,4}\/\d{1,6}\/\d{2}(-\w)?)\b/;
    const caseNumberMatch = query.match(caseNumberPattern);

    if (caseNumberMatch) {
      const caseNumber = caseNumberMatch[1];
      try {
        const sourceCase = await this.zoAdapter.getDocumentByCaseNumber(caseNumber);
        if (!sourceCase) return await this.performRegularSearch(args);

        let textForAnalysis = '';
        let textSource = 'metadata';

        if (sourceCase.full_text) {
          try {
            if (sourceCase.full_text.includes('<html') || sourceCase.full_text.includes('<!DOCTYPE')) {
              const parser = new CourtDecisionHTMLParser(sourceCase.full_text);
              const paragraphs = parser.extractMainText();
              const sections = parser.identifySections(paragraphs);
              textForAnalysis = parser.extractKeyContent(sections);
              textSource = 'parsed_html_key_sections';
            } else {
              textForAnalysis = sourceCase.full_text.substring(0, 5000);
              textSource = 'full_text_truncated';
            }
            if (textForAnalysis.length > 5000) textForAnalysis = textForAnalysis.substring(0, 5000);
          } catch {
            textForAnalysis = sourceCase.full_text.substring(0, 5000);
            textSource = 'full_text_truncated_fallback';
          }
        } else {
          const parts = [sourceCase.title, sourceCase.resolution, sourceCase.snippet?.replace(/<[^>]*>/g, '')].filter(Boolean);
          textForAnalysis = parts.join('\n');
          textSource = 'combined_metadata';
        }

        if (!textForAnalysis || textForAnalysis.length < 50) return await this.performRegularSearch(args);

        const searchTerms = await extractSearchTermsWithAI(textForAnalysis);
        const smartQuery = searchTerms.searchQuery || searchTerms.disputeType || '';

        const requestedDisplay = args.limit || 10;
        const userOffset = args.offset || 0;
        const maxApiLimit = 1000;
        let similarCasesForDisplay: any[] = [];
        let totalFound = 0;
        let offset = userOffset;
        let pagesFetched = 0;
        let hasMore = true;
        const maxPages = 10000;

        while (hasMore && pagesFetched < maxPages) {
          const similarResponse = await this.zoAdapter.searchCourtDecisions({
            meta: { search: smartQuery },
            limit: maxApiLimit,
            offset,
          });
          const normalized = await this.zoAdapter.normalizeResponse(similarResponse);
          const pageResults = normalized.data.filter((doc: any) => doc.doc_id !== sourceCase.doc_id);

          if (similarCasesForDisplay.length < requestedDisplay) {
            const remainingSlots = requestedDisplay - similarCasesForDisplay.length;
            similarCasesForDisplay.push(...pageResults.slice(0, remainingSlots).map((doc: any) => ({
              cause_num: doc.cause_num,
              doc_id: doc.doc_id,
              title: doc.title,
              resolution: doc.resolution,
              judge: doc.judge,
              court_code: doc.court_code,
              adjudication_date: doc.adjudication_date,
              url: doc.url,
              similarity_reason: 'metadata_and_keywords',
            })));
          }

          totalFound += pageResults.length;
          pagesFetched++;

          if (normalized.data.length < maxApiLimit) {
            hasMore = false;
          } else if (similarCasesForDisplay.length >= requestedDisplay) {
            hasMore = false;
          } else {
            offset += maxApiLimit;
          }
        }

        const reachedLimit = pagesFetched >= maxPages;

        if (similarCasesForDisplay.length > 0) {
          this.zoAdapter.saveDocumentsToDatabase(similarCasesForDisplay, 1000).catch(err => {
            logger.error('Failed to save documents to database:', err);
          });
        }

        return this.wrapResponse({
          source_case: {
            cause_num: sourceCase.cause_num,
            doc_id: sourceCase.doc_id,
            title: sourceCase.title,
            resolution: sourceCase.resolution,
            judge: sourceCase.judge,
            court_code: sourceCase.court_code,
            adjudication_date: sourceCase.adjudication_date,
            url: sourceCase.url,
            category_code: sourceCase.category_code,
            justice_kind: sourceCase.justice_kind,
          },
          search_method: 'smart_text_search_with_pagination',
          text_source: textSource,
          text_length: textForAnalysis.length,
          extracted_terms: {
            law_articles: searchTerms.lawArticles,
            keywords: searchTerms.keywords,
            dispute_type: searchTerms.disputeType,
            case_essence: searchTerms.caseEssence,
          },
          search_query: smartQuery,
          similar_cases: similarCasesForDisplay,
          total_found: totalFound,
          pages_fetched: pagesFetched,
          reached_safety_limit: reachedLimit,
          displaying: similarCasesForDisplay.length,
          total_available_info: reachedLimit
            ? `Найдено минимум ${totalFound} прецедентов (показано первых ${similarCasesForDisplay.length}).`
            : `Найдено ${totalFound} прецедентов через ${pagesFetched} страниц.`,
        });
      } catch (error: any) {
        logger.error('Semantic search failed, falling back to regular search', error);
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

    const budget = query.length < 30 ? 'quick' : 'standard';
    const intent = await this.queryPlanner.classifyIntent(query, budget as 'quick' | 'standard');
    const queryParams = this.queryPlanner.buildQueryParams(intent, query);
    const endpoints = this.queryPlanner.selectEndpoints(intent).filter(e => e === 'court');

    const results: any[] = [];
    const errors: string[] = [];

    for (const endpoint of endpoints) {
      try {
        let response;
        switch (endpoint) {
          case 'court':
            response = await this.zoAdapter.searchCourtDecisions(queryParams);
            break;
          default:
            continue;
        }
        const normalized = await this.zoAdapter.normalizeResponse(response);
        results.push(...normalized.data.slice(offset, offset + limit));
      } catch (error: any) {
        errors.push(`${endpoint}: ${error.message}`);
      }
    }

    return this.wrapResponse({
      results,
      intent,
      search_method: 'text_based',
      total: results.length,
      ...(errors.length > 0 && { warnings: errors }),
    });
  }

  private async getLegalAdvice(args: any): Promise<ToolResult> {
    const budget = args.reasoning_budget || 'standard';

    logger.info('[MCP Tool] get_legal_advice started', {
      query: String(args.query || '').substring(0, 100),
      budget,
    });

    // Step 1: Classify intent
    const intent = await this.queryPlanner.classifyIntent(args.query, budget);

    // Step 2: Search precedents
    const queryParams = this.queryPlanner.buildQueryParams(intent, args.query);
    const scHints = buildSupremeCourtHints(intent);
    if (scHints && queryParams?.meta?.search) {
      queryParams.meta.search = `${queryParams.meta.search}${scHints}`.trim();
    }

    const searchResponse = await this.zoAdapter.searchCourtDecisions(queryParams);
    const normalized = await this.zoAdapter.normalizeResponse(searchResponse);

    // Step 3: Extract sections from top results
    const precedentChunks: any[] = [];
    const sources: string[] = [];
    const sourceDocs: any[] = [];
    const maxSources = 10;
    const sectionTypesForAnswer = pickSectionTypesForAnswer(intent);

    for (const doc of normalized.data.slice(0, maxSources)) {
      const sourceDocId = String(doc.doc_id || doc.id || doc.zakononline_id || '');
      if (!sourceDocId) continue;
      sources.push(sourceDocId);

      if (!doc.full_text && doc.doc_id) {
        const fullTextData = await this.zoAdapter.getDocumentFullText(doc.doc_id);
        if (fullTextData?.text) {
          doc.full_text = fullTextData.text;
          doc.full_text_html = fullTextData.html;
        }
      }

      sourceDocs.push(doc);

      if (!doc.full_text || typeof doc.full_text !== 'string' || doc.full_text.length < 100) continue;

      const sections = await this.sectionizer.extractSections(doc.full_text, budget === 'deep');
      const selected = sections.filter((s) => sectionTypesForAnswer.includes(s.type));

      for (const sectionType of sectionTypesForAnswer) {
        const first = selected.find((s) => s.type === sectionType);
        if (!first) continue;
        precedentChunks.push({
          text: first.text,
          source_doc_id: sourceDocId,
          section_type: first.type,
          similarity_score: 0.8,
          similar_cases: [],
        });
      }
    }

    // Background save
    try {
      this.zoAdapter.saveDocumentsMetadataToDatabase(sourceDocs, maxSources).catch((err: any) => {
        logger.error('Failed to save get_legal_advice documents to database:', err?.message);
      });
    } catch (e: any) {
      logger.warn('Document persistence skipped (non-fatal)', { message: e?.message });
    }

    // Step 4: Find patterns
    const patterns: LegalPattern[] = [];
    if (budget !== 'quick') {
      try {
        const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);
        const matched = await this.patternStore.matchPatterns(queryEmbedding, intent.intent);
        patterns.push(...matched);
      } catch (e: any) {
        logger.warn('Pattern matching failed', { message: e?.message });
      }
    }

    // Step 5: Law articles
    const lawArticles = new Set<string>();
    patterns.forEach((p) => p.law_articles.forEach((a: string) => lawArticles.add(a)));

    // Step 6: Final synthesis
    let packagedAnswer: PackagedLawyerAnswer | undefined;
    try {
      const model = ModelSelector.getChatModel(budget);
      const supportsJsonMode = ModelSelector.supportsJsonMode(model);
      const openaiManager = getOpenAIManager();

      const synthesisSources = sourceDocs.slice(0, maxSources).map((d: any) => ({
        document_id: String(d.doc_id || d.id || d.zakononline_id || ''),
        case_number: d.cause_num || d.case_number || null,
        court: d.court || d.court_name || null,
        date: d.adjudication_date || d.date || null,
        judge: d.judge || null,
        url: d.url || (d.doc_id ? `https://zakononline.ua/court-decisions/show/${d.doc_id}` : null),
      }));

      const chunkPayload = precedentChunks.slice(0, 50).map((c: any) => ({
        source_doc_id: c.source_doc_id,
        section_type: c.section_type,
        quote: String(c.text || '').substring(0, 900),
      }));

      const requestConfig: any = {
        model,
        messages: [
          {
            role: 'system',
            content: `Ти юрист-аналітик (Україна). Зроби відповідь, придатну для вставки в процесуальний документ.

Дай відповідь в СТРУКТУРІ PackagedLawyerAnswer (JSON) з полями:
- short_conclusion: { conclusion, conditions?, risk_or_exception? }
- legal_framework: { norms: [{ act?, article_ref, quote?, comment? }] }
- supreme_court_positions: [{ thesis, quotes: [{ quote, source_doc_id, section_type }], context? }]
- practice: [{ source_doc_id, section_type, quote, relevance_reason?, case_number?, court?, date? }]
- criteria_test: string[]
- counterarguments_and_risks: string[]
- checklist: { steps: string[], evidence: string[] }
- sources: [{ document_id, section_type?, quote }]

Правила:
- Не вигадуй реквізити; використовуй тільки подані source_doc_id/case_number/court/date.
- Цитати бери ТІЛЬКИ з наданих фрагментів.
- Для процесуальних питань обов'язково: правова рамка + чеклист дій/доказів + ризики/контраргументи.
- Для "позиції ВС" зроби 2–4 тези і під кожну 1–2 короткі цитати з COURT_REASONING.

Поверни ТІЛЬКИ валідний JSON без додаткового тексту.`,
          },
          {
            role: 'user',
            content: JSON.stringify({ query: args.query, intent, sources: synthesisSources, extracted_chunks: chunkPayload }, null, 2),
          },
        ],
        temperature: 0.2,
        max_tokens: budget === 'deep' ? 3500 : 2000,
      };

      if (supportsJsonMode) requestConfig.response_format = { type: 'json_object' };

      const llmResp = await openaiManager.executeWithRetry(async (client) => {
        return await client.chat.completions.create(requestConfig);
      });

      let content = llmResp.choices[0].message.content || '{}';
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) content = jsonMatch[1];
      const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) content = jsonObjectMatch[0];
      packagedAnswer = JSON.parse(content) as PackagedLawyerAnswer;
    } catch (e: any) {
      logger.warn('Final synthesis failed', { message: e?.message });
    }

    // Step 7: Build response
    const response: EnhancedMCPResponse = {
      summary: `Знайдено ${normalized.data.length} релевантних справ за запитом "${args.query}"`,
      confidence_score: intent.confidence,
      intent,
      relevant_patterns: patterns,
      precedent_chunks: precedentChunks,
      law_articles: Array.from(lawArticles),
      risk_notes: patterns.flatMap((p) => p.risk_factors),
      packaged_answer: packagedAnswer,
      reasoning_chain: [
        { step: 1, action: 'intent_classification', input: args.query, output: intent, confidence: intent.confidence, sources: [] },
        { step: 2, action: 'precedent_search', input: queryParams, output: { count: normalized.data.length }, confidence: 0.8, sources },
        { step: 3, action: 'fulltext_and_section_extraction', input: { top_sources: maxSources, section_types: sectionTypesForAnswer }, output: { precedent_chunks: precedentChunks.length }, confidence: 0.75, sources },
        { step: 4, action: 'final_answer_packaging', input: { budget }, output: { packaged_answer: !!packagedAnswer }, confidence: packagedAnswer ? 0.8 : 0.5, sources },
      ],
      explanation: {
        why_relevant: `Знайдені справи стосуються теми "${intent.intent}"`,
        key_factors: patterns.flatMap((p) => p.success_arguments),
        differences: [],
        risks: patterns.flatMap((p) => p.risk_factors),
      },
      source_attribution: precedentChunks.map((chunk) => ({
        document_id: chunk.source_doc_id,
        section: chunk.section_type,
        quote: chunk.text.substring(0, 200),
        relevance_score: chunk.similarity_score,
      })),
      validation: { is_valid: true, claims_without_sources: [], invalid_citations: [], confidence: 0.8, warnings: [] },
    };

    // Step 8: Validate
    const validation = await this.hallucinationGuard.validateResponse(response, sources);
    response.validation = validation;

    return this.wrapResponse(response);
  }

  private async getLegalAdviceStream(args: any, onEvent: StreamEventCallback): Promise<ToolResult> {
    const budget = args.reasoning_budget || 'standard';

    try {
      onEvent({ type: 'progress', data: { step: 1, action: 'intent_classification', message: 'Класифікація наміру запиту...', progress: 0.1 }, id: 'step-1' });

      const intent = await this.queryPlanner.classifyIntent(args.query, budget);
      onEvent({ type: 'progress', data: { step: 1, action: 'intent_classification', message: `Намір визначено: ${intent.intent}`, progress: 0.2, result: { intent: intent.intent, confidence: intent.confidence } }, id: 'step-1-complete' });

      onEvent({ type: 'progress', data: { step: 2, action: 'precedent_search', message: 'Пошук релевантних прецедентів...', progress: 0.3 }, id: 'step-2' });

      const queryParams = this.queryPlanner.buildQueryParams(intent, args.query);
      const searchResponse = await this.zoAdapter.searchCourtDecisions(queryParams);
      const normalized = await this.zoAdapter.normalizeResponse(searchResponse);

      onEvent({ type: 'progress', data: { step: 2, action: 'precedent_search', message: `Знайдено ${normalized.data.length} справ`, progress: 0.4, result: { count: normalized.data.length } }, id: 'step-2-complete' });

      onEvent({ type: 'progress', data: { step: 3, action: 'section_extraction', message: 'Витягнення семантичних секцій з документів...', progress: 0.5 }, id: 'step-3' });

      const precedentChunks: any[] = [];
      const sources: string[] = [];
      const totalDocs = Math.min(5, normalized.data.length);

      for (let i = 0; i < totalDocs; i++) {
        const doc = normalized.data[i];
        sources.push(doc.id || doc.zakononline_id);
        onEvent({ type: 'progress', data: { step: 3, action: 'section_extraction', message: `Обробка документа ${i + 1}/${totalDocs}...`, progress: 0.5 + (i / totalDocs) * 0.2, current: i + 1, total: totalDocs }, id: `step-3-doc-${i + 1}` });

        if (doc.full_text) {
          const sections = await this.sectionizer.extractSections(doc.full_text, budget === 'deep');
          const reasoningSections = sections.filter((s) => s.type === SectionType.COURT_REASONING);
          for (const section of reasoningSections.slice(0, 2)) {
            const embedding = await this.embeddingService.generateEmbedding(section.text);
            const similar = await this.embeddingService.searchSimilar(embedding, { section_type: SectionType.COURT_REASONING }, 3);
            precedentChunks.push({ text: section.text, source_doc_id: doc.id || doc.zakononline_id, section_type: section.type, similarity_score: 0.8, similar_cases: similar });
          }
        }
      }

      onEvent({ type: 'progress', data: { step: 4, action: 'pattern_analysis', message: 'Аналіз правових паттернів...', progress: 0.75 }, id: 'step-4' });

      const patterns: LegalPattern[] = [];
      if (budget !== 'quick') {
        try {
          const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);
          const matched = await this.patternStore.matchPatterns(queryEmbedding, intent.intent);
          patterns.push(...matched);
        } catch (e: any) {
          logger.warn('Pattern matching failed in stream', { message: e?.message });
        }
      }

      onEvent({ type: 'progress', data: { step: 4, action: 'pattern_analysis', message: `Знайдено ${patterns.length} паттернів`, progress: 0.8 }, id: 'step-4-complete' });

      const response: EnhancedMCPResponse = {
        summary: `Знайдено ${normalized.data.length} релевантних справ`,
        confidence_score: intent.confidence,
        intent,
        relevant_patterns: patterns,
        precedent_chunks: precedentChunks,
        law_articles: [],
        risk_notes: patterns.flatMap((p) => p.risk_factors),
        packaged_answer: {
          short_conclusion: { conclusion: `За запитом "${args.query}" знайдено ${normalized.data.length} релевантних справ` },
          legal_framework: { norms: [] },
          supreme_court_positions: patterns.length > 0 ? patterns.map((p) => ({ thesis: p.intent, quotes: p.success_arguments.slice(0, 2).map((arg) => ({ quote: arg, source_doc_id: 'pattern_store', section_type: 'analysis' as SectionType })), context: `Паттерн: ${p.intent}` })) : [],
          practice: precedentChunks.slice(0, 10).map((c) => ({ source_doc_id: c.source_doc_id, section_type: c.section_type, quote: c.text.substring(0, 300), relevance_reason: c.section_type === SectionType.COURT_REASONING ? 'Мотивування суду' : 'Фрагмент з рішення' })),
          criteria_test: patterns.flatMap((p) => p.success_arguments).slice(0, 7),
          counterarguments_and_risks: patterns.flatMap((p) => p.risk_factors).slice(0, 7),
          checklist: {
            steps: intent.intent === 'procedural_deadlines'
              ? ['Перевірити норму про строк', 'Зафіксувати дату події/вручення', 'Підготувати клопотання']
              : ['Зібрати рішення та виписати тези', 'Сформувати аргументацію', 'Перевірити контраргументи'],
            evidence: intent.intent === 'procedural_deadlines'
              ? ['Документи про дату вручення', 'Підтвердження поважних причин']
              : ['Докази фактичних обставин', 'Документи правової кваліфікації'],
          },
          sources: precedentChunks.slice(0, 10).map((c) => ({ document_id: c.source_doc_id, section_type: c.section_type, quote: c.text.substring(0, 200) })),
        },
        reasoning_chain: [
          { step: 1, action: 'intent_classification', input: args.query, output: intent, confidence: intent.confidence, sources: [] },
          { step: 2, action: 'precedent_search', input: queryParams, output: { count: normalized.data.length }, confidence: 0.8, sources },
        ],
        explanation: {
          why_relevant: `Знайдені справи стосуються теми "${intent.intent}"`,
          key_factors: patterns.flatMap((p) => p.success_arguments),
          differences: [],
          risks: patterns.flatMap((p) => p.risk_factors),
        },
        source_attribution: precedentChunks.map((chunk) => ({ document_id: chunk.source_doc_id, section: chunk.section_type, quote: chunk.text.substring(0, 200), relevance_score: chunk.similarity_score })),
        validation: { is_valid: true, claims_without_sources: [], invalid_citations: [], confidence: 0.8, warnings: [] },
      };

      onEvent({ type: 'progress', data: { step: 5, action: 'validation', message: 'Перевірка джерел та валідація відповіді...', progress: 0.9 }, id: 'step-5' });

      const validation = await this.hallucinationGuard.validateResponse(response, sources);
      response.validation = validation;

      onEvent({ type: 'complete', data: response, id: 'final' });

      return this.wrapResponse(response);
    } catch (error: any) {
      logger.error('getLegalAdviceStream error', { error: error.message });
      onEvent({ type: 'error', data: { message: error.message, error: error.toString() }, id: 'error' });
      throw error;
    }
  }
}
