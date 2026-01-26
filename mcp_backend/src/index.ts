import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema 
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { logger } from './utils/logger.js';
import { Database } from './database/database.js';
import { DocumentService } from './services/document-service.js';
import { ZOAdapter } from './adapters/zo-adapter.js';
import { QueryPlanner } from './services/query-planner.js';
import { SemanticSectionizer } from './services/semantic-sectionizer.js';
import { EmbeddingService } from './services/embedding-service.js';
import { LegalPatternStore } from './services/legal-pattern-store.js';
import { CitationValidator } from './services/citation-validator.js';
import { HallucinationGuard } from './services/hallucination-guard.js';
import { MCPQueryAPI } from './api/mcp-query-api.js';
import { LegislationTools } from './api/legislation-tools.js';
import { VaultTools } from './api/vault-tools.js';
import { DocumentServiceClient } from './clients/document-service-client.js';
import { DocumentParser } from './services/document-parser.js';
import { DueDiligenceService } from './services/due-diligence-service.js';
import { DueDiligenceTools } from './api/due-diligence-tools.js';

dotenv.config();

class SecondLayerMCPServer {
  private server: Server;
  private db: Database;
  private documentService: DocumentService;
  private zoAdapter: ZOAdapter;
  private zoPracticeAdapter: ZOAdapter;
  private queryPlanner: QueryPlanner;
  private sectionizer: SemanticSectionizer;
  private embeddingService: EmbeddingService;
  private patternStore: LegalPatternStore;
  private citationValidator: CitationValidator;
  private hallucinationGuard: HallucinationGuard;
  private mcpAPI: MCPQueryAPI;
  private legislationTools: LegislationTools;
  private vaultTools: VaultTools;
  private documentServiceClient: DocumentServiceClient;
  private documentParser?: DocumentParser;
  private ddService?: DueDiligenceService;
  private ddTools?: DueDiligenceTools;

  constructor() {
    this.server = new Server(
      {
        name: 'secondlayer-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize services
    this.db = new Database();
    this.documentService = new DocumentService(this.db);
    this.queryPlanner = new QueryPlanner();
    this.sectionizer = new SemanticSectionizer();
    this.embeddingService = new EmbeddingService();
    this.zoAdapter = new ZOAdapter(this.documentService, undefined, this.embeddingService);
    this.zoPracticeAdapter = new ZOAdapter('court_practice', this.documentService, this.embeddingService);
    this.patternStore = new LegalPatternStore(this.db, this.embeddingService);
    this.citationValidator = new CitationValidator(this.db);
    this.hallucinationGuard = new HallucinationGuard(this.db);
    this.legislationTools = new LegislationTools(this.db.getPool(), this.embeddingService);

    // Initialize vault tools (Stage 4)
    // DocumentParser will be initialized if vision credentials are available
    try {
      const visionKeyPath = process.env.VISION_CREDENTIALS_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
      if (visionKeyPath) {
        this.documentParser = new DocumentParser(visionKeyPath);
        this.vaultTools = new VaultTools(
          this.documentParser,
          this.sectionizer,
          this.patternStore,
          this.embeddingService,
          this.documentService
        );
        logger.info('VaultTools initialized successfully');
      } else {
        logger.warn('Vision credentials not configured, vault tools with OCR disabled');
        this.vaultTools = null as any;
      }
    } catch (error) {
      logger.warn('VaultTools initialization failed, vault features disabled', error);
      this.vaultTools = null as any;
    }

    // Initialize document service client (microservice)
    this.documentServiceClient = new DocumentServiceClient();

    // Initialize due diligence tools (Stage 5)
    try {
      this.ddService = new DueDiligenceService(
        this.sectionizer,
        this.patternStore,
        this.citationValidator,
        this.documentService
      );
      this.ddTools = new DueDiligenceTools(this.ddService);
      logger.info('DueDiligenceTools initialized successfully');
    } catch (error) {
      logger.warn('DueDiligenceTools initialization failed, DD features disabled', error);
    }

    this.mcpAPI = new MCPQueryAPI(
      this.queryPlanner,
      this.zoAdapter,
      this.zoPracticeAdapter,
      this.sectionizer,
      this.embeddingService,
      this.patternStore,
      this.citationValidator,
      this.hallucinationGuard,
      this.legislationTools
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: any[] = [
        ...this.mcpAPI.getTools(),
        ...this.legislationTools.getToolDefinitions(),
      ];

      // Add vault tools if available (Stage 4)
      if (this.vaultTools) {
        tools.push(...this.vaultTools.getToolDefinitions());
      }

      // Add due diligence tools if available (Stage 5)
      if (this.ddTools) {
        tools.push(...this.ddTools.getToolDefinitions());
      }

      // Add document analysis tools if service is available
      if (this.documentServiceClient.isEnabled()) {
        tools.push(
          {
            name: 'parse_document',
            description: `Парсинг документа (PDF/DOCX/HTML) с извлечением текста и метаданных.

Стратегия:
- PDF: сначала нативное извлечение текста, затем OCR через Playwright + Google Vision API
- DOCX: сначала mammoth, затем OCR
- HTML: screenshot + OCR

Поддерживает языки: украинский, русский, английский`,
            inputSchema: {
              type: 'object',
              properties: {
                fileBase64: {
                  type: 'string',
                  description: 'Base64-encoded содержимое файла',
                },
                mimeType: {
                  type: 'string',
                  description: 'MIME type: application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, text/html',
                },
                filename: {
                  type: 'string',
                  description: 'Имя файла (опционально, для логирования)',
                },
              },
              required: ['fileBase64'],
            },
          },
          {
            name: 'extract_key_clauses',
            description: `Извлечение ключевых положений из контракта/соглашения.

Выделяет и классифицирует клаузы по типам:
- Стороны и предмет договора
- Права и обязательства
- Сроки и условия
- Платежи и финансы
- Ответственность и штрафы
- Форс-мажор и прекращение
- Конфиденциальность

Анализирует риски через analyze_legal_patterns.`,
            inputSchema: {
              type: 'object',
              properties: {
                documentText: {
                  type: 'string',
                  description: 'Текст документа (можно получить через parse_document)',
                },
                documentId: {
                  type: 'string',
                  description: 'ID документа из БД (опционально)',
                },
              },
              required: ['documentText'],
            },
          },
          {
            name: 'summarize_document',
            description: `Создание краткого и детального резюме документа.

Включает:
- Executive summary (2-3 абзаца для руководства)
- Detailed summary (по секциям)
- Ключевые факты: стороны, даты, суммы

Использует budget-aware model selection (quick/standard/deep).`,
            inputSchema: {
              type: 'object',
              properties: {
                documentText: {
                  type: 'string',
                  description: 'Текст документа',
                },
                detailLevel: {
                  type: 'string',
                  enum: ['quick', 'standard', 'deep'],
                  description: 'Уровень детализации (quick = executive only, deep = с анализом)',
                },
              },
              required: ['documentText'],
            },
          },
          {
            name: 'compare_documents',
            description: `Семантическое сравнение двух версий документа.

Находит и классифицирует изменения:
- Критические: изменения сумм, сроков, обязательств
- Значительные: новые клаузы, изменения прав
- Незначительные: форматирование, опечатки

Использует векторные эмбеддинги для семантического анализа.`,
            inputSchema: {
              type: 'object',
              properties: {
                oldDocumentText: {
                  type: 'string',
                  description: 'Текст старой версии документа',
                },
                newDocumentText: {
                  type: 'string',
                  description: 'Текст новой версии документа',
                },
              },
              required: ['oldDocumentText', 'newDocumentText'],
            },
          }
        );
      }

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const toolName = request.params.name;
        const args = request.params.arguments || {};

        // Route legislation tools
        if (toolName.startsWith('get_legislation_') || toolName === 'search_legislation') {
          let result;
          switch (toolName) {
            case 'get_legislation_article':
              result = await this.legislationTools.getLegislationArticle(args as any);
              break;
            case 'get_legislation_section':
              result = await this.legislationTools.getLegislationSection(args as any);
              break;
            case 'get_legislation_articles':
              result = await this.legislationTools.getLegislationArticles(args as any);
              break;
            case 'search_legislation':
              result = await this.legislationTools.searchLegislation(args as any);
              break;
            case 'get_legislation_structure':
              result = await this.legislationTools.getLegislationStructure(args as any);
              break;
            default:
              throw new Error(`Unknown legislation tool: ${toolName}`);
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        // Route vault tools (Stage 4)
        if (['store_document', 'get_document', 'list_documents', 'semantic_search'].includes(toolName)) {
          if (!this.vaultTools) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Error: Vault tools are not available. Document parser initialization may have failed.',
                },
              ],
              isError: true,
            };
          }

          let result;
          switch (toolName) {
            case 'store_document':
              result = await this.vaultTools.storeDocument(args as any);
              break;
            case 'get_document':
              result = await this.vaultTools.getDocument(args as any);
              break;
            case 'list_documents':
              result = await this.vaultTools.listDocuments(args as any);
              break;
            case 'semantic_search':
              result = await this.vaultTools.semanticSearch(args as any);
              break;
            default:
              throw new Error(`Unknown vault tool: ${toolName}`);
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        // Route due diligence tools (Stage 5)
        if (['bulk_review_runner', 'risk_scoring', 'generate_dd_report'].includes(toolName)) {
          if (!this.ddTools) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Error: Due diligence tools are not available.',
                },
              ],
              isError: true,
            };
          }

          let result;
          switch (toolName) {
            case 'bulk_review_runner':
              result = await this.ddTools.bulkReviewRunner(args as any);
              break;
            case 'risk_scoring':
              result = await this.ddTools.riskScoring(args as any);
              break;
            case 'generate_dd_report':
              result = await this.ddTools.generateDDReport(args as any);
              break;
            default:
              throw new Error(`Unknown due diligence tool: ${toolName}`);
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        // Route document analysis tools to microservice
        if (['parse_document', 'extract_key_clauses', 'summarize_document', 'compare_documents'].includes(toolName)) {
          if (!this.documentServiceClient.isEnabled()) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Error: Document analysis service is not configured. Please set DOCUMENT_SERVICE_URL environment variable.',
                },
              ],
              isError: true,
            };
          }

          let result;
          switch (toolName) {
            case 'parse_document':
              result = await this.documentServiceClient.parseDocument(args as any);
              break;
            case 'extract_key_clauses':
              result = await this.documentServiceClient.extractKeyClauses(args as any);
              break;
            case 'summarize_document':
              result = await this.documentServiceClient.summarizeDocument(args as any);
              break;
            case 'compare_documents':
              result = await this.documentServiceClient.compareDocuments(args as any);
              break;
            default:
              throw new Error(`Unknown document analysis tool: ${toolName}`);
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        // Route to main MCP API
        const result = await this.mcpAPI.handleToolCall(toolName, args);
        return result;
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
    });
  }

  async initialize() {
    try {
      await this.db.connect();
      await this.embeddingService.initialize();

      // Check document service health
      if (this.documentServiceClient.isEnabled()) {
        const isHealthy = await this.documentServiceClient.healthCheck();
        if (isHealthy) {
          logger.info('Document analysis service is available');
        } else {
          logger.warn('Document analysis service is not responding (will be unavailable)');
        }
      }

      logger.info('SecondLayer MCP Server initialized');
    } catch (error) {
      logger.error('Failed to initialize server:', error);
      throw error;
    }
  }

  async start() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('SecondLayer MCP Server started');
  }
}

// Start server
const server = new SecondLayerMCPServer();
server.start().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
