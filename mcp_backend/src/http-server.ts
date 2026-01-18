import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './utils/logger.js';
import { authenticateClient, AuthenticatedRequest } from './middleware/auth.js';
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
import { createRestAPIRouter } from './routes/rest-api.js';
import { CostTracker } from './services/cost-tracker.js';
import { requestContext } from './utils/openai-client.js';
import { getOpenAIManager } from './utils/openai-client.js';

dotenv.config();

class HTTPMCPServer {
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
  private costTracker: CostTracker;

  constructor() {
    this.app = express();

    // Initialize services FIRST
    this.db = new Database();
    this.documentService = new DocumentService(this.db);
    this.zoAdapter = new ZOAdapter(this.documentService);
    this.queryPlanner = new QueryPlanner();
    this.sectionizer = new SemanticSectionizer();
    this.embeddingService = new EmbeddingService();
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

    // Initialize cost tracker and inject into adapters
    this.costTracker = new CostTracker(this.db);
    const openaiManager = getOpenAIManager();
    openaiManager.setCostTracker(this.costTracker);
    this.zoAdapter.setCostTracker(this.costTracker);
    logger.info('Cost tracking initialized');

    // Setup middleware and routes AFTER services are initialized
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    // CORS - разрешаем запросы от клиентов
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      credentials: true,
    }));

    // JSON parsing
    this.app.use(express.json({ limit: '10mb' }));

    // Request logging
    this.app.use((req, _res, next) => {
      logger.info('HTTP request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
      next();
    });
  }

  private setupRoutes() {
    // Health check (без аутентификации)
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        service: 'secondlayer-mcp-http',
        version: '1.0.0',
      });
    });

    // Все остальные endpoints требуют аутентификации
    this.app.use(authenticateClient);

    // REST API for admin panel (CRUD operations)
    this.app.use('/api', createRestAPIRouter(this.db));

    // List available tools
    this.app.get('/api/tools', (_req: AuthenticatedRequest, res: Response) => {
      try {
        const tools = this.mcpAPI.getTools();
        res.json({
          tools,
          count: tools.length,
        });
      } catch (error: any) {
        logger.error('Error listing tools:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: error.message,
        });
      }
    });

    // Call MCP tool (with SSE support and cost tracking)
    this.app.post('/api/tools/:toolName', async (req: AuthenticatedRequest, res: Response) => {
      const requestId = uuidv4();
      const startTime = Date.now();

      try {
        const { toolName } = req.params;
        const args = req.body.arguments || req.body;
        const acceptHeader = req.headers.accept || '';

        logger.info('Tool call request', {
          requestId,
          tool: toolName,
          clientKey: req.clientKey?.substring(0, 8) + '...',
          streaming: acceptHeader.includes('text/event-stream'),
        });

        // 1. Create tracking record (pending)
        await this.costTracker.createTrackingRecord({
          requestId,
          toolName,
          clientKey: req.clientKey || 'unknown',
          userQuery: args.query || JSON.stringify(args),
          queryParams: args,
        });

        // 2. Estimate cost BEFORE execution
        const estimate = await this.costTracker.estimateCost({
          toolName,
          queryLength: (args.query || '').length,
          reasoningBudget: args.reasoning_budget || 'standard',
        });

        logger.info('Cost estimate before execution', {
          requestId,
          toolName,
          estimate,
        });

        // Check if client wants SSE streaming
        if (acceptHeader.includes('text/event-stream')) {
          // SSE streaming response (TODO: add cost tracking to streaming)
          return this.handleStreamingToolCall(req, res, toolName, args);
        }

        // 3. Execute in request context
        const result = await requestContext.run(
          { requestId, task: toolName },
          async () => {
            return await this.mcpAPI.handleToolCall(toolName, args);
          }
        );

        // 4. Complete tracking and get breakdown
        const executionTime = Date.now() - startTime;
        const breakdown = await this.costTracker.completeTrackingRecord({
          requestId,
          executionTimeMs: executionTime,
          status: 'completed',
        });

        logger.info('Request completed with cost tracking', {
          requestId,
          toolName,
          totalCostUsd: breakdown.totals.cost_usd.toFixed(6),
        });

        // 5. Return result with cost tracking info
        res.json({
          success: true,
          tool: toolName,
          result,
          cost_tracking: {
            request_id: requestId,
            estimate_before: estimate,
            actual_cost: breakdown,
          },
        });
      } catch (error: any) {
        logger.error('Tool call error:', error);

        // Record failure
        const executionTime = Date.now() - startTime;
        try {
          await this.costTracker.completeTrackingRecord({
            requestId,
            executionTimeMs: executionTime,
            status: 'failed',
            errorMessage: error.message,
          });
        } catch (trackingError) {
          logger.error('Failed to record error in cost tracking:', trackingError);
        }

        res.status(500).json({
          error: 'Tool execution failed',
          message: error.message,
          tool: req.params.toolName,
          cost_tracking: {
            request_id: requestId,
          },
        });
      }
    });

    // Dedicated SSE streaming endpoint
    this.app.post('/api/tools/:toolName/stream', async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { toolName } = req.params;
        const args = req.body.arguments || req.body;

        logger.info('Streaming tool call request', {
          tool: toolName,
          clientKey: req.clientKey?.substring(0, 8) + '...',
        });

        await this.handleStreamingToolCall(req, res, toolName, args);
      } catch (error: any) {
        logger.error('Streaming tool call error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Tool execution failed',
            message: error.message,
            tool: req.params.toolName,
          });
        }
      }
    });

    // Batch tool calls
    this.app.post('/api/tools/batch', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { calls } = req.body;

        if (!Array.isArray(calls)) {
          res.status(400).json({
            error: 'Invalid request',
            message: 'Expected array of tool calls in "calls" field',
          });
          return;
        }

        const results = await Promise.all(
          calls.map(async (call: { name: string; arguments?: any }) => {
            try {
              const result = await this.mcpAPI.handleToolCall(
                call.name,
                call.arguments || {}
              );
              return {
                tool: call.name,
                success: true,
                result,
              };
            } catch (error: any) {
              return {
                tool: call.name,
                success: false,
                error: error.message,
              };
            }
          })
        );

        res.json({
          success: true,
          results,
        });
      } catch (error: any) {
        logger.error('Batch tool call error:', error);
        res.status(500).json({
          error: 'Batch execution failed',
          message: error.message,
        });
      }
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.path} not found`,
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
      logger.info('HTTP MCP Server services initialized');
    } catch (error) {
      logger.error('Failed to initialize server:', error);
      throw error;
    }
  }

  private async handleStreamingToolCall(
    _req: AuthenticatedRequest,
    res: Response,
    toolName: string,
    args: any
  ): Promise<void> {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial connection event
    this.sendSSEEvent(res, {
      type: 'connected',
      data: { tool: toolName, timestamp: new Date().toISOString() },
      id: 'connection',
    });

    try {
      // Only get_legal_advice supports streaming currently
      if (toolName === 'get_legal_advice') {
        await this.mcpAPI.getLegalAdviceStream(args, (event) => {
          this.sendSSEEvent(res, event);
        });
      } else {
        // For other tools, stream the regular result
        const result = await this.mcpAPI.handleToolCall(toolName, args);
        this.sendSSEEvent(res, {
          type: 'progress',
          data: { message: 'Processing...', progress: 0.5 },
          id: 'processing',
        });
        this.sendSSEEvent(res, {
          type: 'complete',
          data: result,
          id: 'final',
        });
      }
    } catch (error: any) {
      this.sendSSEEvent(res, {
        type: 'error',
        data: {
          message: error.message,
          error: error.toString(),
        },
        id: 'error',
      });
    } finally {
      // Send end event and close connection
      this.sendSSEEvent(res, {
        type: 'end',
        data: { message: 'Stream completed' },
        id: 'end',
      });
      res.end();
    }
  }

  private sendSSEEvent(res: Response, event: {
    type: string;
    data: any;
    id?: string;
  }): void {
    try {
      if (event.id) {
        res.write(`id: ${event.id}\n`);
      }
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    } catch (error) {
      logger.error('Error sending SSE event:', error);
    }
  }

  async start() {
    await this.initialize();

    const port = parseInt(process.env.HTTP_PORT || '3000', 10);
    const host = process.env.HTTP_HOST || '0.0.0.0';

    this.app.listen(port, host, () => {
      logger.info(`HTTP MCP Server started on http://${host}:${port}`);
      logger.info('Available endpoints:');
      logger.info('  GET  /health - Health check');
      logger.info('  GET  /api/tools - List available tools');
      logger.info('  POST /api/tools/:toolName - Call a tool (JSON or SSE)');
      logger.info('  POST /api/tools/:toolName/stream - Stream tool execution (SSE)');
      logger.info('  POST /api/tools/batch - Batch tool calls');
      logger.info('');
      logger.info('SSE Streaming:');
      logger.info('  - Add Accept: text/event-stream header for streaming');
      logger.info('  - Or use /api/tools/:toolName/stream endpoint');
      logger.info('  - Currently supported: get_legal_advice');
      logger.info('');
      logger.info('Authentication: Use Authorization header with Bearer token');
      logger.info('  Example: Authorization: Bearer <SECONDARY_LAYER_KEY>');
    });
  }
}

// Start server
const server = new HTTPMCPServer();
server.start().catch((error) => {
  logger.error('Failed to start HTTP server:', error);
  process.exit(1);
});
