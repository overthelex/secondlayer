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
        description: 'Поиск юридических прецедентов с семантическим анализом',
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
            limit: { type: 'number', default: 10 },
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
        description: 'Анализирует паттерны судебной практики: аргументы, риски, статистика исходов',
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
        description: 'Находит похожие судебные обоснования по векторному сходству',
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
        description: 'Извлекает структурированные секции из полного текста документа',
        inputSchema: {
          type: 'object',
          properties: {
            document_id: { type: 'string' },
            text: { type: 'string' },
            use_llm: { type: 'boolean', default: false },
          },
          required: ['text'],
        },
      },
      {
        name: 'find_relevant_law_articles',
        description: 'Находит статьи законов, которые часто применяются в делах по теме',
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
        description: 'Проверяет актуальность и статус прецедента (с soft status)',
        inputSchema: {
          type: 'object',
          properties: {
            case_id: { type: 'string' },
          },
          required: ['case_id'],
        },
      },
      {
        name: 'get_citation_graph',
        description: 'Строит граф цитирований между делами',
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
        description: 'Главный инструмент: комплексный анализ ситуации с проверкой источников',
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
        case 'find_relevant_law_articles':
          return await this.findRelevantLawArticles(args);
        case 'check_precedent_status':
          return await this.checkPrecedentStatus(args);
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
        
        // Step 5: Search for similar cases using API with smart query
        // When user asks for "all", search with maximum limit to get total count
        // Use simple query without complex filters to avoid timeouts
        const requestedDisplay = args.query?.toLowerCase().includes('все') || args.query?.toLowerCase().includes('all') ? 5 : (args.limit || 10);
        const maxApiLimit = 1000; // Zakononline API maximum limit

        const similarSearchParams = {
          meta: {
            search: smartQuery,
          },
          // Request maximum available results to get accurate count
          limit: maxApiLimit,
        };

        logger.info('Searching for all similar cases via API', { maxLimit: maxApiLimit });
        const similarResponse = await this.zoAdapter.searchCourtDecisions(similarSearchParams);
        const normalized = await this.zoAdapter.normalizeResponse(similarResponse);

        // Exclude the source case itself from results
        const allSimilarCases = normalized.data
          .filter((doc: any) => doc.doc_id !== sourceCase.doc_id)
          .map((doc: any) => ({
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

        // Calculate total found
        const totalFound = allSimilarCases.length;
        const hasMore = totalFound >= (maxApiLimit - 1); // If we got max results, there might be more

        // Return only requested number for display
        const similarCases = allSimilarCases.slice(0, requestedDisplay);

        logger.info('Search completed', {
          totalFound,
          hasMore,
          displaying: similarCases.length,
        });

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
                search_method: 'smart_text_search',
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
                has_more: hasMore,
                displaying: similarCases.length,
                total_available_info: hasMore
                  ? `Найдено минимум ${totalFound} прецедентов (показано первых ${similarCases.length}). Возможно, существует больше результатов.`
                  : `Найдено ${totalFound} прецедентов (показано первых ${similarCases.length}).`,
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
    const sections = await this.sectionizer.extractSections(
      args.text,
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
      
      const intent = await this.queryPlanner.classifyIntent(args.query, budget);
      
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
      
      const queryParams = this.queryPlanner.buildQueryParams(intent, args.query);
      const searchResponse = await this.zoAdapter.searchCourtDecisions(queryParams);
      const normalized = await this.zoAdapter.normalizeResponse(searchResponse);
      
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
      
      const validation = await this.hallucinationGuard.validateResponse(
        response,
        sources
      );
      response.validation = validation;
      
      // Final result
      onEvent({
        type: 'complete',
        data: response,
        id: 'final',
      });
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (error: any) {
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
