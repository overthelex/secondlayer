import {
  QueryPlanner,
} from '../services/query-planner.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { LegalPatternStore } from '../services/legal-pattern-store.js';
import { CitationValidator } from '../services/citation-validator.js';
import { HallucinationGuard } from '../services/hallucination-guard.js';
import { SectionType, EnhancedMCPResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { CourtDecisionHTMLParser, extractSearchTermsWithAI } from '../utils/html-parser.js';

export type StreamEventCallback = (event: {
  type: string;
  data: any;
  id?: string;
}) => void;

export class MCPQueryAPI {
  constructor(
    private queryPlanner: QueryPlanner,
    private zoAdapter: ZOAdapter,
    private sectionizer: SemanticSectionizer,
    private embeddingService: EmbeddingService,
    private patternStore: LegalPatternStore,
    private citationValidator: CitationValidator,
    private hallucinationGuard: HallucinationGuard
  ) {}

  getTools() {
    return [
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
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
              },
            },
            limit: { type: 'number', default: 10, description: 'Количество результатов для возврата' },
            offset: { type: 'number', default: 0, description: 'Смещение для пагинации (пропустить первые N результатов)' },
            count_all: {
              type: 'boolean',
              default: false,
              description: 'Подсчитать ВСЕ результаты через пагинацию (может быть дорого и долго). Если true - вернет только общий счетчик без загрузки документов.',
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
        name: 'analyze_case_pattern',
        description: `Анализирует паттерны судебной практики: аргументы, риски, статистика исходов

💰 Примерная стоимость: $0.02-$0.08 USD
Анализ существующих дел в базе данных. Включает OpenAI API (анализ паттернов) и доступ к PostgreSQL.`,
        inputSchema: {
          type: 'object',
          properties: {
            intent: { type: 'string' },
            case_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['intent'],
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
            section_type: {
              type: 'string',
              enum: Object.values(SectionType),
            },
            limit: { type: 'number', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'extract_document_sections',
        description: `Извлекает структурированные секции из полного текста документа (ФАКТЫ, ОБОСНУВАННЯ, РІШЕННЯ)

💰 Примерная стоимость: $0.005-$0.05 USD
При use_llm=false: минимальная стоимость (только парсинг HTML). При use_llm=true: включает OpenAI API для точной экстракции секций.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: {
              type: ['string', 'number'],
              description: 'ID документа из Zakononline для загрузки полного текста'
            },
            document_id: {
              type: 'string',
              description: 'Альтернативное название для doc_id'
            },
            text: {
              type: 'string',
              description: 'Полный текст документа (если уже есть)'
            },
            use_llm: { type: 'boolean', default: false },
          },
          required: [],
        },
      },
      {
        name: 'count_cases_by_party',
        description: `Подсчитывает точное количество судебных дел по названию стороны (истец/ответчик)

💰 Примерная стоимость: зависит от количества результатов
Использует пагинацию через API Zakononline для точного подсчёта всех дел. Стоимость ~$0.007 за каждую страницу (1000 дел).`,
        inputSchema: {
          type: 'object',
          properties: {
            party_name: {
              type: 'string',
              description: 'Название компании или ФИО (например, "Фінансова компанія Фангарант груп")'
            },
            party_type: {
              type: 'string',
              enum: ['plaintiff', 'defendant', 'any'],
              default: 'any',
              description: 'Тип стороны: истец (plaintiff), ответчик (defendant), или любая (any)'
            },
            date_from: {
              type: 'string',
              description: 'Дата начала периода поиска (формат: YYYY-MM-DD)'
            },
            date_to: {
              type: 'string',
              description: 'Дата окончания периода поиска (формат: YYYY-MM-DD)'
            },
            return_cases: {
              type: 'boolean',
              default: false,
              description: 'Вернуть список дел вместе с подсчётом'
            },
            max_cases_to_return: {
              type: 'number',
              default: 100,
              description: 'Максимальное количество дел для возврата в списке (по умолчанию 100)'
            }
          },
          required: ['party_name'],
        },
      },
      {
        name: 'find_relevant_law_articles',
        description: `Находит статьи законов, которые часто применяются в делах по теме

💰 Примерная стоимость: $0.01-$0.02 USD
Запрос к базе данных legal patterns. Минимальная стоимость (только PostgreSQL запросы).`,
        inputSchema: {
          type: 'object',
          properties: {
            intent: { type: 'string' },
            limit: { type: 'number', default: 10 },
          },
          required: ['intent'],
        },
      },
      {
        name: 'check_precedent_status',
        description: `Проверяет актуальность и статус прецедента: действующий, отменённый, сомнительный

💰 Примерная стоимость: $0.005-$0.015 USD
Проверка статуса в базе данных. Минимальная стоимость (только PostgreSQL запросы).`,
        inputSchema: {
          type: 'object',
          properties: {
            case_id: { type: 'string' },
          },
          required: ['case_id'],
        },
      },
      {
        name: 'load_full_texts',
        description: `Загружает полные тексты судебных решений и сохраняет в базу данных

💰 Примерная стоимость: зависит от количества документов
~$0.007 за каждый документ (Zakononline web scraping). Проверяет наличие в PostgreSQL и Redis кэше перед загрузкой.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Массив ID документов для загрузки (например, [110679112, 110441965])'
            },
            max_docs: {
              type: 'number',
              default: 1000,
              description: 'Максимальное количество документов для загрузки (защита от перегрузки)'
            },
            batch_size: {
              type: 'number',
              default: 100,
              description: 'Размер батча для обработки (по умолчанию 100)'
            }
          },
          required: ['doc_ids'],
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
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    logger.info('Tool call', { name, args });

    try {
      switch (name) {
        case 'search_legal_precedents':
          return await this.searchLegalPrecedents(args);
        case 'analyze_case_pattern':
          return await this.analyzeCasePattern(args);
        case 'get_similar_reasoning':
          return await this.getSimilarReasoning(args);
        case 'extract_document_sections':
          return await this.extractDocumentSections(args);
        case 'count_cases_by_party':
          return await this.countCasesByParty(args);
        case 'find_relevant_law_articles':
          return await this.findRelevantLawArticles(args);
        case 'check_precedent_status':
          return await this.checkPrecedentStatus(args);
        case 'load_full_texts':
          return await this.loadFullTexts(args);
        case 'get_citation_graph':
          return await this.getCitationGraph(args);
        case 'get_legal_advice':
          return await this.getLegalAdvice(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      logger.error('Tool call error:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async searchLegalPrecedents(args: any) {
    // If count_all is requested, use pagination to count ALL results
    if (args.count_all === true) {
      logger.info('count_all requested, starting pagination', { query: args.query });

      try {
        const countResult = await this.countAllResults(args.query);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query: args.query,
                count_all_mode: true,
                total_count: countResult.total_count,
                pages_fetched: countResult.pages_fetched,
                time_taken_ms: countResult.time_taken_ms,
                cost_estimate_usd: countResult.cost_estimate_usd,
                note: 'Подсчитано через пагинацию с limit=1000. Документы НЕ загружались для экономии стоимости.',
                warning: countResult.total_count >= 10000000
                  ? 'Достигнут лимит безопасности в 10,000,000 результатов. Реальное количество может быть больше.'
                  : null,
              }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        logger.error('count_all failed:', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error counting all results: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Detect if query contains a case number (e.g., 756/655/23)
    const caseNumberPattern = /\b(\d{1,4}\/\d{1,6}\/\d{2}(-\w)?)\b/;
    const caseNumberMatch = args.query?.match(caseNumberPattern);

    // If searching for a specific case number, use semantic search
    if (caseNumberMatch) {
      const caseNumber = caseNumberMatch[1];
      logger.info('Detected case number search, using semantic approach', { caseNumber });

      try {
        // Step 1: Get the source case document
        const sourceCase = await this.zoAdapter.getDocumentByCaseNumber(caseNumber);
        
        if (!sourceCase) {
          logger.warn('Source case not found', { caseNumber });
          return await this.performRegularSearch(args);
        }

        // Step 2: Extract text for semantic analysis
        // Use HTML parser to extract key content (facts + reasoning)
        let textForAnalysis = '';
        let textSource = 'metadata';
        
        if (sourceCase.full_text) {
          try {
            // Check if full_text is HTML
            if (sourceCase.full_text.includes('<html') || sourceCase.full_text.includes('<!DOCTYPE')) {
              // Parse HTML and extract key sections
              const parser = new CourtDecisionHTMLParser(sourceCase.full_text);
              const paragraphs = parser.extractMainText();
              const sections = parser.identifySections(paragraphs);
              
              // Extract only key content (max 5000 chars for embedding model)
              textForAnalysis = parser.extractKeyContent(sections);
              textSource = 'parsed_html_key_sections';
              
              logger.info('Extracted key sections from HTML', {
                caseNumber,
                sections: {
                  ustanovyv: sections.ustanovyv.length,
                  reasoning: sections.reasoning.length,
                  vyrishyv: sections.vyrishyv.length,
                },
                textLength: textForAnalysis.length,
              });
            } else {
              // Plain text - truncate to 5000 chars
              textForAnalysis = sourceCase.full_text.substring(0, 5000);
              textSource = 'full_text_truncated';
            }
            
            // Ensure we don't exceed embedding model limits (~8192 tokens = ~32k chars max)
            // Use 5000 chars to be safe
            if (textForAnalysis.length > 5000) {
              textForAnalysis = textForAnalysis.substring(0, 5000);
            }
            
            logger.info('Prepared text for semantic search', { 
              caseNumber,
              source: textSource,
              fullTextLength: sourceCase.full_text.length,
              analyzedLength: textForAnalysis.length,
            });
          } catch (error: any) {
            logger.warn('HTML parsing failed, using truncated full text', error);
            textForAnalysis = sourceCase.full_text.substring(0, 5000);
            textSource = 'full_text_truncated_fallback';
          }
        } else {
          // Combine available text fields if no full text
          const parts = [
            sourceCase.title,
            sourceCase.resolution, 
            sourceCase.snippet ? sourceCase.snippet.replace(/<[^>]*>/g, '') : '', // Remove HTML tags
          ].filter(Boolean);
          textForAnalysis = parts.join('\n');
          textSource = 'combined_metadata';
          
          logger.info('Using combined metadata for semantic search', { 
            caseNumber,
            textLength: textForAnalysis.length,
          });
        }

        if (!textForAnalysis || textForAnalysis.length < 50) {
          logger.warn('Insufficient text for semantic analysis', { 
            caseNumber,
            textLength: textForAnalysis?.length 
          });
          return await this.performRegularSearch(args);
        }

        // Step 3: Extract search terms using OpenAI for intelligent analysis
        logger.info('Extracting search terms using AI from source case');
        const searchTerms = await extractSearchTermsWithAI(textForAnalysis);
        
        // Use AI-generated search query
        const smartQuery = searchTerms.searchQuery || searchTerms.disputeType || '';
        
        logger.info('AI extracted search terms and query', {
          caseNumber,
          query: smartQuery,
          lawArticles: searchTerms.lawArticles,
          keywords: searchTerms.keywords,
          disputeType: searchTerms.disputeType,
          caseEssence: searchTerms.caseEssence,
        });
        
        // Step 5: Search for similar cases using pagination
        // Use explicit limit parameter if provided, otherwise default to 10
        // Support offset parameter to skip first N results
        const requestedDisplay = args.limit || 10;
        const userOffset = args.offset || 0; // User's requested offset
        const maxApiLimit = 1000; // Zakononline API maximum limit

        logger.info('Searching for similar cases via pagination', {
          limit: requestedDisplay,
          offset: userOffset,
        });

        let similarCasesForDisplay: any[] = [];
        let totalFound = 0;
        let offset = userOffset; // Start from user's offset
        let pagesFetched = 0;
        let hasMore = true;
        const maxPages = 10000; // Safety limit (10 million results max)

        while (hasMore && pagesFetched < maxPages) {
          const similarSearchParams = {
            meta: {
              search: smartQuery,
            },
            limit: maxApiLimit,
            offset: offset,
          };

          logger.info('Fetching page of similar cases', {
            page: pagesFetched + 1,
            offset,
            limit: maxApiLimit,
          });

          const similarResponse = await this.zoAdapter.searchCourtDecisions(similarSearchParams);
          const normalized = await this.zoAdapter.normalizeResponse(similarResponse);

          // Filter out source case
          const pageResults = normalized.data.filter((doc: any) => doc.doc_id !== sourceCase.doc_id);

          // Store results up to requestedDisplay limit
          if (similarCasesForDisplay.length < requestedDisplay) {
            const remainingSlots = requestedDisplay - similarCasesForDisplay.length;
            const resultsToKeep = pageResults.slice(0, remainingSlots).map((doc: any) => ({
              cause_num: doc.cause_num,
              doc_id: doc.doc_id,
              title: doc.title,
              resolution: doc.resolution,
              judge: doc.judge,
              court_code: doc.court_code,
              adjudication_date: doc.adjudication_date,
              url: doc.url,
              similarity_reason: 'metadata_and_keywords',
            }));
            similarCasesForDisplay.push(...resultsToKeep);
          }

          totalFound += pageResults.length;
          pagesFetched++;

          logger.info('Page fetched', {
            page: pagesFetched,
            resultsInPage: normalized.data.length,
            totalSoFar: totalFound,
            keptForDisplay: similarCasesForDisplay.length,
          });

          // Stop conditions:
          // 1. Got less than maxApiLimit - this is the last page
          // 2. Already have enough results for user's request
          if (normalized.data.length < maxApiLimit) {
            hasMore = false;
            logger.info('Last page reached', {
              totalFound,
              pagesFetched,
            });
          } else if (similarCasesForDisplay.length >= requestedDisplay) {
            hasMore = false;
            logger.info('Collected enough results for request', {
              collected: similarCasesForDisplay.length,
              requested: requestedDisplay,
              totalSeen: totalFound,
              pagesFetched,
            });
          } else {
            // Continue to next page
            offset += maxApiLimit;
          }
        }

        if (pagesFetched >= maxPages) {
          logger.warn('Reached safety limit of pages', {
            maxPages,
            totalFound,
          });
        }

        const reachedLimit = pagesFetched >= maxPages;
        const similarCases = similarCasesForDisplay;

        logger.info('Search completed', {
          totalFound,
          reachedLimit,
          pagesFetched,
          displaying: similarCases.length,
        });

        // Save found documents to database (limited to 1000 max)
        if (similarCases.length > 0) {
          logger.info('Saving found documents to database', {
            count: similarCases.length,
          });
          // Run in background, don't wait
          this.zoAdapter.saveDocumentsToDatabase(similarCases, 1000).catch(err => {
            logger.error('Failed to save documents to database:', err);
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
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
                similar_cases: similarCases,
                total_found: totalFound,
                pages_fetched: pagesFetched,
                reached_safety_limit: reachedLimit,
                displaying: similarCases.length,
                total_available_info: reachedLimit
                  ? `Найдено минимум ${totalFound} прецедентов (показано первых ${similarCases.length}). Достигнут лимит безопасности в ${maxPages} страниц.`
                  : `Найдено ${totalFound} прецедентов через ${pagesFetched} страниц (показано первых ${similarCases.length}).`,
              }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        logger.error('Semantic search failed, falling back to regular search', error);
        return await this.performRegularSearch(args);
      }
    }

    // Regular search for non-case-number queries
    return await this.performRegularSearch(args);
  }

  /**
   * Count ALL results through pagination (offset-based)
   * Uses limit=1000 and keeps fetching until results < 1000
   */
  private async countAllResults(query: string, queryParams?: any): Promise<{
    total_count: number;
    pages_fetched: number;
    time_taken_ms: number;
    cost_estimate_usd: number;
  }> {
    const startTime = Date.now();
    const maxApiLimit = 1000;
    let offset = 0;
    let totalCount = 0;
    let pagesFetched = 0;
    let hasMore = true;

    logger.info('Starting pagination to count all results', { query });

    while (hasMore) {
      const searchParams = {
        meta: { search: query },
        limit: maxApiLimit,
        offset: offset,
        ...queryParams,
      };

      logger.info('Fetching page', {
        page: pagesFetched + 1,
        offset,
        limit: maxApiLimit
      });

      try {
        const response = await this.zoAdapter.searchCourtDecisions(searchParams);
        const normalized = await this.zoAdapter.normalizeResponse(response);

        const resultsInPage = normalized.data.length;
        totalCount += resultsInPage;
        pagesFetched++;

        logger.info('Page fetched', {
          page: pagesFetched,
          resultsInPage,
          totalSoFar: totalCount,
          offset
        });

        // If we got less than maxApiLimit, this is the last page
        if (resultsInPage < maxApiLimit) {
          hasMore = false;
          logger.info('Last page reached', {
            totalCount,
            pagesFetched
          });
        } else {
          // Continue to next page
          offset += maxApiLimit;

          // Safety limit: max 10,000 pages (10,000,000 results)
          if (pagesFetched >= 10000) {
            logger.warn('Reached safety limit of 10,000 pages', { totalCount });
            hasMore = false;
          }
        }
      } catch (error: any) {
        logger.error('Error during pagination', {
          page: pagesFetched + 1,
          offset,
          error: error.message
        });
        throw new Error(`Pagination failed at page ${pagesFetched + 1}: ${error.message}`);
      }
    }

    const timeTaken = Date.now() - startTime;

    // Estimate cost: ZakonOnline API calls only (no document processing)
    // Each page = 1 API call at ~$0.00714
    const costEstimate = pagesFetched * 0.00714;

    logger.info('Pagination completed', {
      totalCount,
      pagesFetched,
      timeTakenMs: timeTaken,
      costEstimateUsd: costEstimate.toFixed(6),
    });

    return {
      total_count: totalCount,
      pages_fetched: pagesFetched,
      time_taken_ms: timeTaken,
      cost_estimate_usd: parseFloat(costEstimate.toFixed(6)),
    };
  }

  /**
   * Regular text-based search (original implementation)
   */
  private async performRegularSearch(args: any) {
    // Use 'quick' budget to avoid LLM timeouts for simple searches
    const budget = args.query?.length < 30 ? 'quick' : 'standard';
    const intent = await this.queryPlanner.classifyIntent(args.query, budget as 'quick' | 'standard');
    const queryParams = this.queryPlanner.buildQueryParams(intent, args.query);
    
    // Only use court endpoint for now (NPA/ECHR endpoints not available on court.searcher domain)
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
          // NPA and ECHR endpoints disabled - not available on court.searcher API
          // case 'npa':
          //   response = await this.zoAdapter.searchNPA(queryParams);
          //   break;
          // case 'echr':
          //   response = await this.zoAdapter.searchECHRPractice(queryParams);
          //   break;
          default:
            continue;
        }

        const normalized = await this.zoAdapter.normalizeResponse(response);
        results.push(...normalized.data.slice(0, args.limit || 10));
      } catch (error: any) {
        logger.warn(`Endpoint ${endpoint} failed:`, error.message);
        errors.push(`${endpoint}: ${error.message}`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results,
            intent,
            search_method: 'text_based',
            total: results.length,
            ...(errors.length > 0 && { warnings: errors }),
          }, null, 2),
        },
      ],
    };
  }

  private async analyzeCasePattern(args: any) {
    const patterns = await this.patternStore.findPatterns(args.intent);
    
    if (args.case_ids && args.case_ids.length > 0) {
      const newPattern = await this.patternStore.extractPatterns(
        args.case_ids,
        args.intent
      );
      if (newPattern) {
        await this.patternStore.savePattern(newPattern);
        patterns.unshift(newPattern);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ patterns }, null, 2),
        },
      ],
    };
  }

  private async getSimilarReasoning(args: any) {
    const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);
    const similar = await this.embeddingService.searchSimilar(
      queryEmbedding,
      {
        section_type: args.section_type as SectionType,
      },
      args.limit || 10
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ similar }, null, 2),
        },
      ],
    };
  }

  private async extractDocumentSections(args: any) {
    let text = args.text;
    const docId = args.doc_id || args.document_id;

    // If no text provided but doc_id is available, fetch the document
    if (!text && docId) {
      logger.info('Fetching document by doc_id', { docId });

      try {
        // Try to get from ZOAdapter which checks database first, then fetches from API
        const fullTextData = await this.zoAdapter.getDocumentFullText(docId);

        if (fullTextData && fullTextData.text) {
          text = fullTextData.text;
          logger.info('Document loaded successfully', {
            docId,
            textLength: text.length,
          });
        } else {
          throw new Error(`Failed to load document ${docId}: no text returned`);
        }
      } catch (error: any) {
        logger.error('Failed to fetch document', { docId, error: error.message });
        throw new Error(`Failed to fetch document ${docId}: ${error.message}`);
      }
    }

    // Validate that we have text to work with
    if (!text) {
      throw new Error('Either "text" or "doc_id"/"document_id" must be provided');
    }

    // Extract sections from the text
    const sections = await this.sectionizer.extractSections(
      text,
      args.use_llm || false
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ sections }, null, 2),
        },
      ],
    };
  }

  private async countCasesByParty(args: any) {
    const partyName = args.party_name;
    const partyType = args.party_type || 'any';
    const returnCases = args.return_cases || false;
    const maxCasesToReturn = args.max_cases_to_return || 100;

    logger.info('Counting cases by party', { partyName, partyType, returnCases, maxCasesToReturn });

    // Build search query based on party type
    let searchQuery = partyName;
    if (partyType === 'plaintiff') {
      searchQuery = `позивач ${partyName}`;
    } else if (partyType === 'defendant') {
      searchQuery = `відповідач ${partyName}`;
    }

    try {
      // Use pagination to count ALL results
      const startTime = Date.now();
      const maxApiLimit = 1000;
      let offset = 0;
      let totalCount = 0;
      let pagesFetched = 0;
      let hasMore = true;
      const allCases: any[] = [];
      const seenDocIds = new Set<number>(); // Track unique doc_ids to avoid duplicates
      const SAFETY_LIMIT = 100000; // Stop at 100k results
      // When using date filters, limit pages to avoid scanning millions of records
      const MAX_PAGES_WITH_DATE_FILTER = 100; // Max 100k docs to scan when filtering by date
      const hasDateFilter = !!(args.date_from || args.date_to);
      let reachedPageLimit = false;

      while (hasMore && totalCount < SAFETY_LIMIT) {
        // Stop early if using date filter and scanned enough pages
        if (hasDateFilter && pagesFetched >= MAX_PAGES_WITH_DATE_FILTER) {
          logger.warn('Reached max pages limit for date-filtered query', {
            pagesFetched,
            maxPages: MAX_PAGES_WITH_DATE_FILTER,
            totalCount
          });
          reachedPageLimit = true;
          break;
        }

        const searchParams: any = {
          meta: { search: searchQuery },
          limit: maxApiLimit,
          offset: offset,
        };

        // NOTE: Date filtering via API where clause is VERY slow (120+ seconds per request)
        // Instead, we fetch all results and filter locally
        // This is much faster for date-range queries

        logger.info('Fetching page', {
          page: pagesFetched + 1,
          offset,
          limit: maxApiLimit,
          totalSoFar: totalCount,
          hasDateFilter: !!(args.date_from || args.date_to)
        });

        const response = await this.zoAdapter.searchCourtDecisions(searchParams);
        pagesFetched++;

        if (Array.isArray(response) && response.length > 0) {
          // Filter results by date locally if date filters are provided
          let filteredResponse: any[] = response;
          if (args.date_from || args.date_to) {
            filteredResponse = response.filter(doc => {
              const docDate = doc.adjudication_date ? new Date(doc.adjudication_date) : null;
              if (!docDate) return false;

              if (args.date_from) {
                const fromDate = new Date(args.date_from);
                if (docDate < fromDate) return false;
              }

              if (args.date_to) {
                const toDate = new Date(args.date_to);
                if (docDate > toDate) return false;
              }

              return true;
            });

            logger.info('Local date filtering', {
              beforeFilter: response.length,
              afterFilter: filteredResponse.length,
              dateFrom: args.date_from,
              dateTo: args.date_to
            });
          }

          // Deduplicate results - only count and collect unique doc_ids
          const uniqueResults = filteredResponse.filter(doc => {
            if (!doc.doc_id) return false;
            if (seenDocIds.has(doc.doc_id)) return false;
            seenDocIds.add(doc.doc_id);
            return true;
          });

          // Check if API is returning duplicates (sign of pagination issue)
          if (uniqueResults.length === 0 && filteredResponse.length > 0) {
            logger.warn('API returned only duplicate results, stopping pagination', {
              totalResults: filteredResponse.length,
              uniqueCount: 0,
              totalUniqueSoFar: seenDocIds.size
            });
            hasMore = false;
            break;
          }

          totalCount += uniqueResults.length;

          // Collect cases if requested
          if (returnCases && allCases.length < maxCasesToReturn) {
            const casesToAdd = uniqueResults.slice(0, maxCasesToReturn - allCases.length);
            allCases.push(...casesToAdd.map(doc => ({
              cause_num: doc.cause_num,
              doc_id: doc.doc_id,
              title: doc.title,
              resolution: doc.resolution,
              judge: doc.judge,
              court_code: doc.court_code,
              adjudication_date: doc.adjudication_date,
              url: `https://zakononline.ua/court-decisions/show/${doc.doc_id}`,
            })));
          }

          // If got less than maxApiLimit, we've reached the end
          if (response.length < maxApiLimit) {
            hasMore = false;
            logger.info('Reached end of results', {
              lastPageSize: response.length
            });
          } else {
            offset += maxApiLimit;
          }
        } else {
          hasMore = false;
          logger.info('No more results', { totalCount });
        }

        // Safety delay to avoid rate limits
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      const timeTaken = Date.now() - startTime;
      const costEstimate = pagesFetched * 0.00714;

      const result: any = {
        party_name: partyName,
        party_type: partyType,
        search_query: searchQuery,
        total_unique_cases: totalCount,
        unique_doc_ids_found: seenDocIds.size,
        pages_fetched: pagesFetched,
        time_taken_ms: timeTaken,
        cost_estimate_usd: parseFloat(costEstimate.toFixed(6)),
      };

      if (args.date_from) result.date_from = args.date_from;
      if (args.date_to) result.date_to = args.date_to;

      if (args.date_from || args.date_to) {
        result.filtering_method = 'local';
        result.note = 'Фильтрация по датам выполнена локально (API-фильтр слишком медленный)';
      }

      if (reachedPageLimit) {
        result.warning = `Достигнут лимит в ${MAX_PAGES_WITH_DATE_FILTER} страниц для date-фильтрованного запроса. Просканировано ${pagesFetched * maxApiLimit} дел, найдено ${totalCount}. Для более точного подсчёта используйте запрос без date-фильтра.`;
        result.scanned_documents = pagesFetched * maxApiLimit;
      } else if (totalCount >= SAFETY_LIMIT) {
        result.warning = `Достигнут лимит безопасности в ${SAFETY_LIMIT} дел. Реальное количество может быть больше.`;
      }

      if (returnCases) {
        result.cases = allCases;
        result.cases_returned = allCases.length;
      }

      logger.info('Case counting completed', {
        totalCases: totalCount,
        pagesFetched,
        timeTakenMs: timeTaken,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('Failed to count cases by party', { error: error.message });
      throw new Error(`Failed to count cases: ${error.message}`);
    }
  }

  private async loadFullTexts(args: any) {
    const docIds: number[] = args.doc_ids || [];
    const maxDocs = args.max_docs || 1000;

    if (!docIds || docIds.length === 0) {
      throw new Error('doc_ids parameter is required and must be a non-empty array');
    }

    // Deduplicate doc_ids first
    const uniqueDocIds = Array.from(new Set(docIds));
    const duplicatesRemoved = docIds.length - uniqueDocIds.length;

    if (duplicatesRemoved > 0) {
      logger.warn('Removed duplicate doc_ids', {
        totalProvided: docIds.length,
        uniqueCount: uniqueDocIds.length,
        duplicatesRemoved
      });
    }

    logger.info('Loading full texts for documents', {
      totalDocs: uniqueDocIds.length,
      maxDocs,
      limitedTo: Math.min(uniqueDocIds.length, maxDocs),
      duplicatesRemoved
    });

    try {
      const startTime = Date.now();

      // Create document objects with doc_id
      const docs = uniqueDocIds.slice(0, maxDocs).map(docId => ({
        doc_id: docId
      }));

      // Use ZOAdapter's batch loading with cache checking
      await this.zoAdapter.saveDocumentsToDatabase(docs, maxDocs);

      const timeTaken = Date.now() - startTime;

      // Estimate cost: web scraping cost only (documents in cache/DB are free)
      // We don't know exact count without checking, so estimate maximum
      const estimatedCost = docs.length * 0.00714; // SecondLayer web scraping cost

      const result: any = {
        requested_docs: docIds.length,
        unique_docs: uniqueDocIds.length,
        duplicates_removed: duplicatesRemoved,
        processed_docs: docs.length,
        limited_to: maxDocs,
        time_taken_ms: timeTaken,
        estimated_cost_usd: parseFloat(estimatedCost.toFixed(6)),
        note: 'Документы проверены на наличие в PostgreSQL и Redis кэше перед загрузкой. Загружены только отсутствующие документы.',
      };

      if (duplicatesRemoved > 0) {
        result.deduplication_note = `Обнаружено и удалено ${duplicatesRemoved} дубликатов doc_id из входного списка`;
      }

      if (uniqueDocIds.length > maxDocs) {
        result.warning = `Запрошено ${uniqueDocIds.length} уникальных документов, но обработано только ${maxDocs} из-за лимита безопасности`;
      }

      logger.info('Full texts loading completed', {
        processedDocs: docs.length,
        timeTakenMs: timeTaken,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('Failed to load full texts', { error: error.message });
      throw new Error(`Failed to load full texts: ${error.message}`);
    }
  }

  private async findRelevantLawArticles(args: any) {
    const patterns = await this.patternStore.findPatterns(args.intent);
    const articles = new Set<string>();

    for (const pattern of patterns) {
      pattern.law_articles.forEach((a) => articles.add(a));
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              articles: Array.from(articles).slice(0, args.limit || 10),
              patterns_count: patterns.length,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async checkPrecedentStatus(args: any) {
    const status = await this.citationValidator.validatePrecedentStatus(args.case_id);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status }, null, 2),
        },
      ],
    };
  }

  private async getCitationGraph(args: any) {
    const graph = await this.citationValidator.buildCitationGraph(
      args.case_id,
      args.depth || 2
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ graph }, null, 2),
        },
      ],
    };
  }

  private async getLegalAdvice(args: any): Promise<any> {
    const budget = args.reasoning_budget || 'standard';
    
    // Step 1: Classify intent
    const intent = await this.queryPlanner.classifyIntent(args.query, budget);
    
    // Step 2: Search precedents (pass original query for full-text search)
    const queryParams = this.queryPlanner.buildQueryParams(intent, args.query);
    const searchResponse = await this.zoAdapter.searchCourtDecisions(queryParams);
    const normalized = await this.zoAdapter.normalizeResponse(searchResponse);
    
    // Step 3: Extract sections from top results
    const precedentChunks: any[] = [];
    const sources: string[] = [];
    
    for (const doc of normalized.data.slice(0, 5)) {
      sources.push(doc.id || doc.zakononline_id);
      
      if (doc.full_text) {
        const sections = await this.sectionizer.extractSections(
          doc.full_text,
          budget === 'deep'
        );
        
        // Generate embeddings for reasoning sections
        const reasoningSections = sections.filter(
          (s) => s.type === SectionType.COURT_REASONING
        );
        
        for (const section of reasoningSections.slice(0, 2)) {
          const embedding = await this.embeddingService.generateEmbedding(section.text);
          const similar = await this.embeddingService.searchSimilar(embedding, {
            section_type: SectionType.COURT_REASONING,
          }, 3);
          
          precedentChunks.push({
            text: section.text,
            source_doc_id: doc.id || doc.zakononline_id,
            section_type: section.type,
            similarity_score: 0.8,
            similar_cases: similar,
          });
        }
      }
    }
    
    // Step 4: Find patterns
    const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);
    const patterns = await this.patternStore.matchPatterns(queryEmbedding, intent.intent);
    
    // Step 5: Extract law articles
    const lawArticles = new Set<string>();
    patterns.forEach((p) => p.law_articles.forEach((a) => lawArticles.add(a)));
    
    // Step 6: Build response
    const response: EnhancedMCPResponse = {
      summary: `Знайдено ${normalized.data.length} релевантних справ за запитом "${args.query}"`,
      confidence_score: intent.confidence,
      relevant_patterns: patterns,
      precedent_chunks: precedentChunks,
      law_articles: Array.from(lawArticles),
      risk_notes: patterns.flatMap((p) => p.risk_factors),
      reasoning_chain: [
        {
          step: 1,
          action: 'intent_classification',
          input: args.query,
          output: intent,
          confidence: intent.confidence,
          sources: [],
        },
        {
          step: 2,
          action: 'precedent_search',
          input: queryParams,
          output: { count: normalized.data.length },
          confidence: 0.8,
          sources: sources,
        },
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
      validation: {
        is_valid: true,
        claims_without_sources: [],
        invalid_citations: [],
        confidence: 0.8,
        warnings: [],
      },
    };
    
    // Step 7: Validate with Hallucination Guard
    const validation = await this.hallucinationGuard.validateResponse(
      response,
      sources
    );
    response.validation = validation;
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  /**
   * Streaming версия getLegalAdvice с SSE событиями прогресса
   */
  async getLegalAdviceStream(
    args: any,
    onEvent: StreamEventCallback
  ): Promise<any> {
    const budget = args.reasoning_budget || 'standard';

    try {
      logger.info('getLegalAdviceStream started', { query: args.query, budget });

      // Step 1: Classify intent
      onEvent({
        type: 'progress',
        data: {
          step: 1,
          action: 'intent_classification',
          message: 'Класифікація наміру запиту...',
          progress: 0.1,
        },
        id: 'step-1',
      });

      logger.info('Calling classifyIntent...');
      const intent = await this.queryPlanner.classifyIntent(args.query, budget);
      logger.info('classifyIntent completed', { intent: intent.intent });
      
      onEvent({
        type: 'progress',
        data: {
          step: 1,
          action: 'intent_classification',
          message: `Намір визначено: ${intent.intent}`,
          progress: 0.2,
          result: { intent: intent.intent, confidence: intent.confidence },
        },
        id: 'step-1-complete',
      });
      
      // Step 2: Search precedents (pass original query for full-text search)
      onEvent({
        type: 'progress',
        data: {
          step: 2,
          action: 'precedent_search',
          message: 'Пошук релевантних прецедентів...',
          progress: 0.3,
        },
        id: 'step-2',
      });

      logger.info('Building query params...');
      const queryParams = this.queryPlanner.buildQueryParams(intent, args.query);
      logger.info('Searching court decisions...', { queryParams });
      const searchResponse = await this.zoAdapter.searchCourtDecisions(queryParams);
      logger.info('Normalizing response...');
      const normalized = await this.zoAdapter.normalizeResponse(searchResponse);
      logger.info('Search completed', { resultsCount: normalized.data.length });
      
      onEvent({
        type: 'progress',
        data: {
          step: 2,
          action: 'precedent_search',
          message: `Знайдено ${normalized.data.length} справ`,
          progress: 0.4,
          result: { count: normalized.data.length },
        },
        id: 'step-2-complete',
      });
      
      // Step 3: Extract sections
      onEvent({
        type: 'progress',
        data: {
          step: 3,
          action: 'section_extraction',
          message: 'Витягнення семантичних секцій з документів...',
          progress: 0.5,
        },
        id: 'step-3',
      });
      
      const precedentChunks: any[] = [];
      const sources: string[] = [];
      const totalDocs = Math.min(5, normalized.data.length);
      
      for (let i = 0; i < totalDocs; i++) {
        const doc = normalized.data[i];
        sources.push(doc.id || doc.zakononline_id);
        
        onEvent({
          type: 'progress',
          data: {
            step: 3,
            action: 'section_extraction',
            message: `Обробка документа ${i + 1}/${totalDocs}...`,
            progress: 0.5 + (i / totalDocs) * 0.2,
            current: i + 1,
            total: totalDocs,
          },
          id: `step-3-doc-${i + 1}`,
        });
        
        if (doc.full_text) {
          const sections = await this.sectionizer.extractSections(
            doc.full_text,
            budget === 'deep'
          );
          
          const reasoningSections = sections.filter(
            (s) => s.type === SectionType.COURT_REASONING
          );
          
          for (const section of reasoningSections.slice(0, 2)) {
            const embedding = await this.embeddingService.generateEmbedding(section.text);
            const similar = await this.embeddingService.searchSimilar(embedding, {
              section_type: SectionType.COURT_REASONING,
            }, 3);
            
            precedentChunks.push({
              text: section.text,
              source_doc_id: doc.id || doc.zakononline_id,
              section_type: section.type,
              similarity_score: 0.8,
              similar_cases: similar,
            });
          }
        }
      }
      
      onEvent({
        type: 'progress',
        data: {
          step: 3,
          action: 'section_extraction',
          message: `Витягнуто ${precedentChunks.length} релевантних секцій`,
          progress: 0.7,
          result: { chunks: precedentChunks.length },
        },
        id: 'step-3-complete',
      });
      
      // Step 4: Find patterns
      onEvent({
        type: 'progress',
        data: {
          step: 4,
          action: 'pattern_matching',
          message: 'Пошук релевантних паттернів...',
          progress: 0.75,
        },
        id: 'step-4',
      });
      
      const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);
      const patterns = await this.patternStore.matchPatterns(queryEmbedding, intent.intent);
      
      onEvent({
        type: 'progress',
        data: {
          step: 4,
          action: 'pattern_matching',
          message: `Знайдено ${patterns.length} паттернів`,
          progress: 0.85,
          result: { patterns: patterns.length },
        },
        id: 'step-4-complete',
      });
      
      // Step 5: Extract law articles
      const lawArticles = new Set<string>();
      patterns.forEach((p) => p.law_articles.forEach((a) => lawArticles.add(a)));
      
      // Step 6: Build response
      const response: EnhancedMCPResponse = {
        summary: `Знайдено ${normalized.data.length} релевантних справ за запитом "${args.query}"`,
        confidence_score: intent.confidence,
        relevant_patterns: patterns,
        precedent_chunks: precedentChunks,
        law_articles: Array.from(lawArticles),
        risk_notes: patterns.flatMap((p) => p.risk_factors),
        reasoning_chain: [
          {
            step: 1,
            action: 'intent_classification',
            input: args.query,
            output: intent,
            confidence: intent.confidence,
            sources: [],
          },
          {
            step: 2,
            action: 'precedent_search',
            input: queryParams,
            output: { count: normalized.data.length },
            confidence: 0.8,
            sources: sources,
          },
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
        validation: {
          is_valid: true,
          claims_without_sources: [],
          invalid_citations: [],
          confidence: 0.8,
          warnings: [],
        },
      };
      
      // Step 7: Validate with Hallucination Guard
      onEvent({
        type: 'progress',
        data: {
          step: 5,
          action: 'validation',
          message: 'Перевірка джерел та валідація відповіді...',
          progress: 0.9,
        },
        id: 'step-5',
      });
      
      logger.info('Validating response...');
      const validation = await this.hallucinationGuard.validateResponse(
        response,
        sources
      );
      response.validation = validation;
      logger.info('Validation completed', { isValid: validation.is_valid });

      // Final result
      logger.info('Sending complete event...');
      onEvent({
        type: 'complete',
        data: response,
        id: 'final',
      });
      logger.info('Complete event sent, returning result');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('getLegalAdviceStream error', { error: error.message, stack: error.stack });
      onEvent({
        type: 'error',
        data: {
          message: error.message,
          error: error.toString(),
        },
        id: 'error',
      });
      throw error;
    }
  }
}
