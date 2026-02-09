import { DocumentParser, ParsedDocument } from '../services/document-parser.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { LegalPatternStore } from '../services/legal-pattern-store.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { DocumentService, Document } from '../services/document-service.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { DocumentSection } from '../types/index.js';
import fs from 'fs/promises';

/**
 * Vault Tools API - Stage 4 Implementation
 *
 * Implements document vault with:
 * - Document storage with automatic parsing, sectioning, embedding
 * - Semantic search across vault
 * - Document retrieval with metadata
 * - Filtering and querying
 *
 * Pipeline: store → parse → section → embed → analyze_patterns → save
 */

export interface VaultDocument {
  id: string;
  title: string;
  type: 'contract' | 'legislation' | 'court_decision' | 'internal' | 'other';
  content: string;
  metadata: {
    uploadedAt: string;
    uploadedBy?: string;
    tags?: string[];
    category?: string;
    parties?: string[];
    dates?: string[];
    riskLevel?: 'low' | 'medium' | 'high';
    [key: string]: any;
  };
  sections?: DocumentSection[];
  patterns?: {
    riskFactors?: string[];
    keyArguments?: string[];
    confidence?: number;
  };
}

export interface SemanticSearchResult {
  documentId: string;
  title: string;
  relevance: number;
  matchedSections: Array<{
    sectionType: string;
    text: string;
    relevance: number;
  }>;
  metadata: any;
}

export class VaultTools {
  constructor(
    private documentParser: DocumentParser,
    private sectionizer: SemanticSectionizer,
    private patternStore: LegalPatternStore,
    private embeddingService: EmbeddingService,
    private documentService: DocumentService
  ) {}

  getToolDefinitions() {
    return [
      {
        name: 'store_document',
        description: `Сохранить документ в Vault с автоматической обработкой.

Pipeline:
1. Parse document (PDF/DOCX/HTML → text)
2. Extract sections (semantic sectionizer)
3. Generate embeddings (vector index)
4. Analyze legal patterns (risks/arguments)
5. Save with metadata

Поддерживает:
- Контракты, законодательство, судебные решения
- Автоматическое извлечение метаданных
- Тегирование и категоризация
- Семантический поиск`,
        inputSchema: {
          type: 'object',
          properties: {
            fileBase64: {
              type: 'string',
              description: 'Base64-encoded файл (PDF/DOCX/HTML)',
            },
            mimeType: {
              type: 'string',
              description: 'MIME type документа',
            },
            title: {
              type: 'string',
              description: 'Название документа',
            },
            type: {
              type: 'string',
              enum: ['contract', 'legislation', 'court_decision', 'internal', 'other'],
              description: 'Тип документа',
            },
            metadata: {
              type: 'object',
              description: 'Дополнительные метаданные (tags, category, uploadedBy, etc)',
            },
          },
          required: ['fileBase64', 'title', 'type'],
        },
      },
      {
        name: 'get_document',
        description: `Получить документ из Vault по ID.

Возвращает:
- Полный текст документа
- Метаданные и теги
- Секции (если доступны)
- Результаты анализа паттернов
- История изменений`,
        inputSchema: {
          type: 'object',
          properties: {
            documentId: {
              type: 'string',
              description: 'UUID документа в vault',
            },
            includeSections: {
              type: 'boolean',
              description: 'Включить секции документа',
            },
            includePatterns: {
              type: 'boolean',
              description: 'Включить результаты анализа паттернов',
            },
          },
          required: ['documentId'],
        },
      },
      {
        name: 'list_documents',
        description: `Список документов в Vault с фильтрацией.

Фильтры:
- По типу документа
- По тегам
- По категории
- По дате загрузки
- По уровню риска

Поддерживает пагинацию и сортировку.`,
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['contract', 'legislation', 'court_decision', 'internal', 'other'],
              description: 'Фильтр по типу',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Фильтр по тегам (любой из списка)',
            },
            category: {
              type: 'string',
              description: 'Фильтр по категории',
            },
            uploadedAfter: {
              type: 'string',
              description: 'Загружены после даты (ISO 8601)',
            },
            uploadedBefore: {
              type: 'string',
              description: 'Загружены до даты (ISO 8601)',
            },
            limit: {
              type: 'number',
              description: 'Количество результатов (default: 20)',
            },
            offset: {
              type: 'number',
              description: 'Смещение для пагинации',
            },
            sortBy: {
              type: 'string',
              enum: ['uploadedAt', 'title', 'riskLevel'],
              description: 'Поле сортировки',
            },
            sortOrder: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Порядок сортировки',
            },
          },
        },
      },
      {
        name: 'semantic_search',
        description: `Семантический поиск по документам в Vault.

Использует векторные эмбеддинги для поиска релевантных документов.

Возможности:
- Поиск по смыслу (не только ключевые слова)
- Фильтрация по типу/категории/тегам
- Ранжирование по релевантности
- Возврат релевантных секций

Примеры:
- "договоры с условием форс-мажор"
- "судебные решения о правах акционеров"
- "риски в контрактах с иностранными контрагентами"`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Поисковый запрос (семантический)',
            },
            type: {
              type: 'string',
              enum: ['contract', 'legislation', 'court_decision', 'internal', 'other'],
              description: 'Фильтр по типу документа',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Фильтр по тегам',
            },
            limit: {
              type: 'number',
              description: 'Количество результатов (default: 10)',
            },
            threshold: {
              type: 'number',
              description: 'Минимальная релевантность 0-1 (default: 0.7)',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  /**
   * Store document from file path (used by chunked upload)
   * Same pipeline as storeDocument but reads from disk instead of Base64
   */
  async storeDocumentFromPath(args: {
    filePath: string;
    mimeType?: string;
    title: string;
    type: 'contract' | 'legislation' | 'court_decision' | 'internal' | 'other';
    metadata?: any;
    userId?: string;
  }): Promise<VaultDocument> {
    const fileBuffer = await fs.readFile(args.filePath);
    const fileBase64 = fileBuffer.toString('base64');

    return this.storeDocument({
      fileBase64,
      mimeType: args.mimeType,
      title: args.title,
      type: args.type,
      metadata: args.metadata,
      userId: args.userId,
    });
  }

  /**
   * Store document in vault with full processing pipeline
   *
   * Pipeline:
   * 1. Parse document (PDF/DOCX/HTML → text)
   * 2. Extract sections (semantic sectionizer)
   * 3. Generate embeddings for sections
   * 4. Analyze legal patterns
   * 5. Save document + sections + embeddings + metadata
   */
  async storeDocument(args: {
    fileBase64: string;
    mimeType?: string;
    title: string;
    type: 'contract' | 'legislation' | 'court_decision' | 'internal' | 'other';
    metadata?: any;
    userId?: string;
  }): Promise<VaultDocument> {
    const startTime = Date.now();
    const documentId = uuidv4();

    try {
      logger.info('[Vault] store_document started', {
        documentId,
        title: args.title,
        type: args.type,
        sizeBytes: args.fileBase64.length,
      });

      // Step 1: Parse document
      const fileBuffer = Buffer.from(args.fileBase64, 'base64');
      const parsed: ParsedDocument = await this.documentParser.parseDocument(
        fileBuffer,
        args.mimeType
      );

      logger.info('[Vault] Document parsed', {
        documentId,
        textLength: parsed.text.length,
        pageCount: parsed.metadata.pageCount,
      });

      // Step 2: Extract sections
      const sections = await this.sectionizer.extractSections(parsed.text, false);

      logger.info('[Vault] Sections extracted', {
        documentId,
        sectionCount: sections.length,
      });

      // Step 3: Generate embeddings for full text + sections
      const embeddingTasks = [];

      // Generate embedding for full document
      const fullTextEmbedding = await this.embeddingService.generateEmbedding(
        parsed.text.slice(0, 8000) // Limit to prevent token overflow
      );

      // Store full document embedding
      embeddingTasks.push(
        this.embeddingService.storeChunk({
          id: documentId,
          source: 'zakononline',
          doc_id: documentId,
          section_type: 'FACTS' as any, // Default section type for full doc
          text: parsed.text.slice(0, 1000), // Preview only
          embedding: fullTextEmbedding,
          metadata: {
            date: new Date().toISOString(),
            ...args.metadata,
          },
          created_at: new Date().toISOString(),
        })
      );

      // Generate and store embeddings for each section
      for (const section of sections) {
        const sectionEmbedding = await this.embeddingService.generateEmbedding(
          section.text.slice(0, 8000)
        );

        embeddingTasks.push(
          this.embeddingService.storeChunk({
            id: `${documentId}:${section.type}`,
            source: 'zakononline',
            doc_id: documentId,
            section_type: section.type,
            text: section.text.slice(0, 1000),
            embedding: sectionEmbedding,
            metadata: {
              date: new Date().toISOString(),
              ...args.metadata,
            },
            created_at: new Date().toISOString(),
          })
        );
      }

      const embeddingResults = await Promise.allSettled(embeddingTasks);

      const embeddingSuccesses = embeddingResults.filter((r) => r.status === 'fulfilled').length;
      logger.info('[Vault] Embeddings generated', {
        documentId,
        total: embeddingResults.length,
        successful: embeddingSuccesses,
      });

      // Step 4: Analyze legal patterns (extract risks/arguments)
      let patterns: any = {};
      try {
        // Use generic intent for pattern finding
        const patternResults = await this.patternStore.findPatterns(
          args.type || 'general',
          0.5 // minConfidence
        );

        if (patternResults && patternResults.length > 0) {
          // Aggregate patterns from results
          const allRiskFactors: string[] = [];
          const allSuccessArguments: string[] = [];
          let totalConfidence = 0;

          for (const pattern of patternResults) {
            if (pattern.risk_factors) {
              allRiskFactors.push(...pattern.risk_factors);
            }
            if (pattern.success_arguments) {
              allSuccessArguments.push(...pattern.success_arguments);
            }
            totalConfidence += pattern.confidence;
          }

          patterns = {
            riskFactors: [...new Set(allRiskFactors)], // Deduplicate
            keyArguments: [...new Set(allSuccessArguments)],
            confidence: patternResults.length > 0 ? totalConfidence / patternResults.length : 0,
          };
        }
      } catch (error: any) {
        logger.warn('[Vault] Pattern analysis failed, continuing without patterns', {
          documentId,
          error: error.message,
        });
      }

      // Step 5: Save to database
      const document: Document = {
        id: documentId,
        zakononline_id: documentId, // Use same ID for vault documents
        type: args.type,
        title: args.title,
        full_text: parsed.text,
        user_id: args.userId,
        metadata: {
          ...parsed.metadata,
          ...args.metadata,
          uploadedAt: new Date().toISOString(),
          processedAt: new Date().toISOString(),
          processingTimeMs: Date.now() - startTime,
          sectionCount: sections.length,
          embeddingCount: embeddingSuccesses,
          patterns,
        },
      };

      await this.documentService.saveDocument(document);

      // Save sections
      if (sections.length > 0) {
        await this.documentService.saveSections(documentId, sections);
      }

      const duration = Date.now() - startTime;
      logger.info('[Vault] Document stored successfully', {
        documentId,
        title: args.title,
        type: args.type,
        sections: sections.length,
        embeddings: embeddingSuccesses,
        durationMs: duration,
      });

      return {
        id: documentId,
        title: args.title,
        type: args.type,
        content: parsed.text,
        metadata: document.metadata,
        sections,
        patterns,
      };
    } catch (error: any) {
      logger.error('[Vault] store_document failed', {
        documentId,
        title: args.title,
        error: error.message,
        stack: error.stack,
      });
      throw new Error(`Failed to store document: ${error.message}`);
    }
  }

  /**
   * Get document from vault by ID
   */
  async getDocument(args: {
    documentId: string;
    includeSections?: boolean;
    includePatterns?: boolean;
    userId?: string;
  }): Promise<VaultDocument | null> {
    try {
      logger.info('[Vault] get_document started', {
        documentId: args.documentId,
        includeSections: args.includeSections,
        includePatterns: args.includePatterns,
      });

      const doc = args.userId
        ? await this.documentService.getDocumentForUser(args.documentId, args.userId)
        : await this.documentService.getDocumentById(args.documentId);
      if (!doc) {
        logger.warn('[Vault] Document not found', { documentId: args.documentId });
        return null;
      }

      const result: VaultDocument = {
        id: doc.id!,
        title: doc.title || 'Untitled',
        type: doc.type as any,
        content: doc.full_text || '',
        metadata: typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata || {},
      };

      // Include sections if requested
      if (args.includeSections !== false) {
        result.sections = await this.documentService.getSections(args.documentId);
      }

      // Include patterns if requested
      if (args.includePatterns !== false && result.metadata.patterns) {
        result.patterns = result.metadata.patterns;
      }

      logger.info('[Vault] get_document completed', {
        documentId: args.documentId,
        hasContent: !!result.content,
        sectionsCount: result.sections?.length || 0,
      });

      return result;
    } catch (error: any) {
      logger.error('[Vault] get_document failed', {
        documentId: args.documentId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * List documents with filtering
   */
  async listDocuments(args: {
    type?: string;
    tags?: string[];
    category?: string;
    uploadedAfter?: string;
    uploadedBefore?: string;
    limit?: number;
    offset?: number;
    sortBy?: 'uploadedAt' | 'title' | 'riskLevel';
    sortOrder?: 'asc' | 'desc';
    userId?: string;
  }): Promise<{ documents: VaultDocument[]; total: number }> {
    try {
      logger.info('[Vault] list_documents started', args);

      const limit = args.limit || 20;
      const offset = args.offset || 0;
      const sortBy = args.sortBy || 'uploadedAt';
      const sortOrder = args.sortOrder || 'desc';

      // Build SQL query with filters
      const conditions: string[] = ['1=1'];
      const params: any[] = [];
      let paramIndex = 1;

      // User isolation: show own + public documents
      if (args.userId) {
        conditions.push(`(user_id = $${paramIndex} OR user_id IS NULL)`);
        params.push(args.userId);
        paramIndex++;
      }

      if (args.type) {
        conditions.push(`type = $${paramIndex}`);
        params.push(args.type);
        paramIndex++;
      }

      if (args.uploadedAfter) {
        conditions.push(`created_at >= $${paramIndex}`);
        params.push(args.uploadedAfter);
        paramIndex++;
      }

      if (args.uploadedBefore) {
        conditions.push(`created_at <= $${paramIndex}`);
        params.push(args.uploadedBefore);
        paramIndex++;
      }

      // Tags filter (check if metadata.tags contains any of the requested tags)
      if (args.tags && args.tags.length > 0) {
        conditions.push(`metadata::jsonb -> 'tags' ?| $${paramIndex}`);
        params.push(args.tags);
        paramIndex++;
      }

      // Category filter
      if (args.category) {
        conditions.push(`metadata::jsonb ->> 'category' = $${paramIndex}`);
        params.push(args.category);
        paramIndex++;
      }

      const whereClause = conditions.join(' AND ');

      // Sort mapping
      const sortColumn =
        sortBy === 'uploadedAt'
          ? 'created_at'
          : sortBy === 'riskLevel'
          ? "metadata::jsonb -> 'riskLevel'"
          : 'title';

      const query = `
        SELECT id, type, title, metadata, created_at, updated_at
        FROM documents
        WHERE ${whereClause}
        ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      params.push(limit, offset);

      const result = await this.documentService['db'].query(query, params);

      // Get total count
      const countQuery = `SELECT COUNT(*) as total FROM documents WHERE ${whereClause}`;
      const countResult = await this.documentService['db'].query(countQuery, params.slice(0, -2));
      const total = parseInt(countResult.rows[0].total, 10);

      const documents: VaultDocument[] = result.rows.map((row: any) => ({
        id: row.id,
        title: row.title || 'Untitled',
        type: row.type,
        content: '', // Don't include full content in list
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {},
      }));

      logger.info('[Vault] list_documents completed', {
        total,
        returned: documents.length,
        limit,
        offset,
      });

      return { documents, total };
    } catch (error: any) {
      logger.error('[Vault] list_documents failed', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Semantic search across vault documents
   */
  async semanticSearch(args: {
    query: string;
    type?: string;
    tags?: string[];
    limit?: number;
    threshold?: number;
  }): Promise<SemanticSearchResult[]> {
    try {
      logger.info('[Vault] semantic_search started', {
        query: args.query,
        type: args.type,
        limit: args.limit,
      });

      const limit = args.limit || 10;
      const threshold = args.threshold || 0.7;

      // Generate query embedding
      const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);

      // Search using embedding service
      const searchResults = await this.embeddingService.searchSimilar(
        queryEmbedding,
        {}, // No filters at embedding level, we'll filter below
        limit * 2 // Get more for filtering
      );

      // Filter by score threshold
      let filteredResults = searchResults.filter((r: any) => r.score >= threshold);

      if (args.type || args.tags) {
        // Get metadata for filtering
        const documentIds = filteredResults.map((r: any) => {
          const payload = r.payload || {};
          return payload.doc_id || r.id?.toString().split(':')[0] || '';
        });
        const uniqueIds = [...new Set(documentIds)].filter(Boolean);

        if (uniqueIds.length > 0) {
          const docsQuery = `
            SELECT id, type, title, metadata
            FROM documents
            WHERE id = ANY($1)
          `;
          const docsResult = await this.documentService['db'].query(docsQuery, [uniqueIds]);
          const docsMap = new Map(docsResult.rows.map((row: any) => [row.id, row]));

          filteredResults = filteredResults.filter((r: any) => {
            const payload = r.payload || {};
            const docId = payload.doc_id || r.id?.toString().split(':')[0];
            const doc = docsMap.get(docId) as any;
            if (!doc) return false;

            if (args.type && doc.type !== args.type) return false;

            if (args.tags && args.tags.length > 0) {
              const metadata =
                typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata;
              const docTags = metadata?.tags || [];
              const hasMatchingTag = args.tags.some((tag: string) => docTags.includes(tag));
              if (!hasMatchingTag) return false;
            }

            return true;
          });
        }
      }

      // Take top results
      filteredResults = filteredResults.slice(0, limit);

      // Format results
      const results: SemanticSearchResult[] = [];
      const processedDocs = new Set<string>();

      for (const searchResult of filteredResults) {
        const payload = searchResult.payload || {};
        const docId = payload.doc_id || searchResult.id?.toString().split(':')[0];
        const sectionType = payload.section_type;

        if (docId && !processedDocs.has(docId)) {
          const doc = await this.documentService.getDocumentById(docId);
          if (!doc) continue;

          const metadata =
            typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata || {};

          results.push({
            documentId: docId,
            title: doc.title || 'Untitled',
            relevance: searchResult.score || 0,
            matchedSections: [
              {
                sectionType: sectionType || 'full_text',
                text: payload.text || '',
                relevance: searchResult.score || 0,
              },
            ],
            metadata,
          });

          processedDocs.add(docId);
        }
      }

      logger.info('[Vault] semantic_search completed', {
        query: args.query,
        totalResults: results.length,
        avgRelevance: results.length > 0
          ? results.reduce((sum, r) => sum + r.relevance, 0) / results.length
          : 0,
      });

      return results;
    } catch (error: any) {
      logger.error('[Vault] semantic_search failed', {
        query: args.query,
        error: error.message,
      });

      // Return empty results instead of throwing (graceful degradation)
      logger.warn('[Vault] Returning empty results due to search failure');
      return [];
    }
  }
}
