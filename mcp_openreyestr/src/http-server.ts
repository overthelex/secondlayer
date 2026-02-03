/**
 * OpenReyestr MCP Server - HTTP REST entry point
 * Provides Ukrainian State Register access via REST API with SSE streaming
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import { logger } from './utils/logger';
import { requireAPIKey, AuthenticatedRequest } from './middleware/dual-auth';
import { Database } from './database/database';
import { OpenReyestrTools } from './api/openreyestr-tools';
import { CostTracker } from './services/cost-tracker';
import { MCPOpenReyestrAPI } from './api/mcp-openreyestr-api';

dotenv.config();

class HTTPOpenReyestrServer {
  private app: express.Application;
  private db: Database;
  private pool: Pool;
  private tools: OpenReyestrTools;
  private costTracker: CostTracker;
  private mcpAPI: MCPOpenReyestrAPI;

  constructor() {
    this.app = express();

    // Initialize database FIRST
    this.db = new Database();
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5435'),
      user: process.env.POSTGRES_USER || 'openreyestr',
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB || 'openreyestr',
    });

    // Initialize cost tracker
    this.costTracker = new CostTracker(this.db);

    // Initialize services
    this.tools = new OpenReyestrTools(this.pool);

    // Initialize MCP API
    this.mcpAPI = new MCPOpenReyestrAPI(this.tools, this.costTracker);

    logger.info('Cost tracking initialized for OpenReyestr server');

    // Setup middleware and routes AFTER services are initialized
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    // CORS - allow requests from clients
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

    // Health check (public - no auth)
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        service: 'openreyestr-mcp-http',
        version: '1.0.0',
      });
    });

    // List available tools
    this.app.get('/api/tools', requireAPIKey as any, ((_req: AuthenticatedRequest, res: Response) => {
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
    }) as any);

    // Call MCP tool (with SSE support and cost tracking)
    this.app.post('/api/tools/:toolName', requireAPIKey as any, (async (req: AuthenticatedRequest, res: Response) => {
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
          return this.handleStreamingToolCall(req, res, toolName, args);
        }

        // 3. Execute tool
        const result = await this.mcpAPI.handleToolCall(toolName, args);

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
    }) as any);

    // Dedicated SSE streaming endpoint
    this.app.post('/api/tools/:toolName/stream', requireAPIKey as any, (async (req: AuthenticatedRequest, res: Response) => {
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
    }) as any);

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
      logger.info('HTTP OpenReyestr Server services initialized');
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
      // For now, all tools use regular execution (streaming can be added later)
      this.sendSSEEvent(res, {
        type: 'progress',
        data: { message: 'Processing request...', progress: 0.3 },
        id: 'processing',
      });

      const result = await this.mcpAPI.handleToolCall(toolName, args);

      this.sendSSEEvent(res, {
        type: 'progress',
        data: { message: 'Finalizing results...', progress: 0.9 },
        id: 'finalizing',
      });

      this.sendSSEEvent(res, {
        type: 'complete',
        data: result,
        id: 'final',
      });
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

    const port = parseInt(process.env.HTTP_PORT || '3004', 10);
    const host = process.env.HTTP_HOST || '0.0.0.0';

    this.app.listen(port, host, () => {
      logger.info(`HTTP OpenReyestr Server started on http://${host}:${port}`);
      logger.info('Available endpoints:');
      logger.info('  GET  /health - Health check');
      logger.info('  GET  /api/tools - List available tools');
      logger.info('  POST /api/tools/:toolName - Call a tool (JSON or SSE)');
      logger.info('  POST /api/tools/:toolName/stream - Stream tool execution (SSE)');
      logger.info('');
      logger.info('SSE Streaming:');
      logger.info('  - Add Accept: text/event-stream header for streaming');
      logger.info('  - Or use /api/tools/:toolName/stream endpoint');
      logger.info('');
      logger.info('Authentication: Use Authorization header with Bearer token');
      logger.info('  Example: Authorization: Bearer <OPENREYESTR_API_KEY>');
    });
  }
}

// Start server
const server = new HTTPOpenReyestrServer();
server.start().catch((error) => {
  logger.error('Failed to start HTTP OpenReyestr server:', error);
  process.exit(1);
});
