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
      return {
        tools: [
          ...this.mcpAPI.getTools(),
          ...this.legislationTools.getToolDefinitions(),
        ],
      };
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
