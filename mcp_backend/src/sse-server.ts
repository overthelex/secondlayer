import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
import { authenticateJWT } from './middleware/jwt-auth.js';

dotenv.config();

/**
 * MCP Server with SSE Transport for Remote Access
 *
 * This server implements the Model Context Protocol over Server-Sent Events (SSE),
 * allowing remote clients to connect via HTTPS instead of stdio.
 *
 * Endpoint: POST /v1/sse
 * - Accepts MCP JSON-RPC requests
 * - Returns responses via SSE stream
 */
class SSEMCPServer {
  private app: express.Application;
  private db: Database;
  private documentService: DocumentService;
  private zoAdapter: ZOAdapter;
  private queryPlanner: QueryPlanner;
  private sectionizer: SemanticSectionizer;
  private embeddingService: EmbeddingService;
  private patternStore: LegalPatternStore;
  private citationValidator: CitationValidator;
  private hallucinationGuard: HallucinationGuard;
  private mcpAPI: MCPQueryAPI;

  constructor() {
    this.app = express();

    // Initialize services
    this.db = new Database();
    this.documentService = new DocumentService(this.db);
    this.queryPlanner = new QueryPlanner();
    this.sectionizer = new SemanticSectionizer();
    this.embeddingService = new EmbeddingService();
    this.zoAdapter = new ZOAdapter(this.documentService, undefined, this.embeddingService);
    this.patternStore = new LegalPatternStore(this.db, this.embeddingService);
    this.citationValidator = new CitationValidator(this.db);
    this.hallucinationGuard = new HallucinationGuard(this.db);
    this.mcpAPI = new MCPQueryAPI(
      this.queryPlanner,
      this.zoAdapter,
      this.sectionizer,
      this.embeddingService,
      this.patternStore,
      this.citationValidator,
      this.hallucinationGuard
    );

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    // CORS for remote access
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      credentials: true,
    }));

    // JSON parsing
    this.app.use(express.json({ limit: '10mb' }));

    // Request logging
    this.app.use((req, _res, next) => {
      logger.info('SSE MCP request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
        hasAuth: !!req.headers.authorization,
      });
      next();
    });

    // JWT Authentication - protects all endpoints except /health
    this.app.use(authenticateJWT);
  }

  private setupRoutes() {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        service: 'secondlayer-mcp-sse',
        version: '1.0.0',
        transport: 'sse',
        tools: this.mcpAPI.getTools().length,
      });
    });

    // MCP over SSE endpoint
    this.app.post('/v1/sse', async (req: Request, res: Response) => {
      try {
        logger.info('New SSE MCP connection established');

        // Create MCP Server instance for this connection
        const mcpServer = new Server(
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

        // Setup handlers
        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
          return {
            tools: this.mcpAPI.getTools(),
          };
        });

        mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
          try {
            const result = await this.mcpAPI.handleToolCall(
              request.params.name,
              request.params.arguments || {}
            );
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

        // Create SSE transport
        const transport = new SSEServerTransport('/v1/sse', res);

        // Connect MCP server to transport
        await mcpServer.connect(transport);

        // Handle client disconnect
        req.on('close', () => {
          logger.info('SSE MCP client disconnected');
          mcpServer.close();
        });

      } catch (error: any) {
        logger.error('SSE MCP connection error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Failed to establish SSE connection',
            message: error.message,
          });
        }
      }
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.path} not found`,
        available_endpoints: [
          'GET /health - Health check',
          'POST /v1/sse - MCP over SSE endpoint',
        ],
      });
    });

    // Error handler
    this.app.use((err: any, _req: Request, res: Response, _next: any) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred',
      });
    });
  }

  async initialize() {
    try {
      await this.db.connect();
      await this.embeddingService.initialize();
      logger.info('SSE MCP Server services initialized');
    } catch (error) {
      logger.error('Failed to initialize server:', error);
      throw error;
    }
  }

  async start() {
    await this.initialize();

    const port = parseInt(process.env.HTTP_PORT || '3000', 10);
    const host = process.env.HTTP_HOST || '0.0.0.0';

    this.app.listen(port, host, () => {
      logger.info(`SSE MCP Server started on http://${host}:${port}`);
      logger.info('Remote MCP endpoint: POST /v1/sse');
      logger.info('Health check: GET /health');
      logger.info('');
      logger.info('Client Configuration:');
      logger.info('  {');
      logger.info('    "SecondLayerMCP": {');
      logger.info(`      "url": "https://mcp.legal.org.ua/v1/sse",`);
      logger.info('      "headers": {}');
      logger.info('    }');
      logger.info('  }');
    });
  }
}

// Start server
const server = new SSEMCPServer();
server.start().catch((error) => {
  logger.error('Failed to start SSE MCP server:', error);
  process.exit(1);
});
