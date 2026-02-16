/**
 * OpenReyestr MCP Server - HTTP REST entry point
 * Provides Ukrainian State Register access via REST API with SSE streaming
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './utils/logger';
import { requireAPIKey, AuthenticatedRequest } from './middleware/dual-auth';
import { Database } from './database/database';
import { OpenReyestrTools } from './api/openreyestr-tools';
import { CostTracker } from './services/cost-tracker';
import { MCPOpenReyestrAPI } from './api/mcp-openreyestr-api';
import { MetricsService } from './services/metrics-service';

dotenv.config();

class HTTPOpenReyestrServer {
  private app: express.Application;
  private db: Database;
  private tools: OpenReyestrTools;
  private costTracker: CostTracker;
  private mcpAPI: MCPOpenReyestrAPI;
  private metricsService: MetricsService;

  constructor() {
    this.app = express();

    // Initialize database FIRST
    this.db = new Database();

    // Initialize cost tracker
    this.costTracker = new CostTracker(this.db);

    // Initialize services
    this.tools = new OpenReyestrTools(this.db.getPool());

    // Initialize MCP API
    this.mcpAPI = new MCPOpenReyestrAPI(this.tools, this.costTracker);

    logger.info('Cost tracking initialized for OpenReyestr server');

    // Initialize Prometheus metrics
    this.metricsService = new MetricsService();
    this.db.setMetricsCollector((stats) => this.metricsService.updatePgPool(stats));
    logger.info('Prometheus metrics service initialized');

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

    // Prometheus HTTP metrics middleware
    this.app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const durationNs = Number(process.hrtime.bigint() - start);
        const durationSec = durationNs / 1e9;
        const route = this.metricsService.normalizeRoute(req.route?.path || req.path);
        const labels = { method: req.method, route, status_code: String(res.statusCode) };
        this.metricsService.httpRequestDuration.observe(labels, durationSec);
        this.metricsService.httpRequestsTotal.inc(labels);
      });
      next();
    });

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
    // Prometheus metrics endpoint (no auth - internal Docker network only)
    this.app.get('/metrics', async (_req, res) => {
      try {
        const metrics = await this.metricsService.getMetrics();
        res.set('Content-Type', this.metricsService.getContentType());
        res.end(metrics);
      } catch (err: any) {
        res.status(500).end(err.message);
      }
    });

    // Liveness probe
    this.app.get('/health/live', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // Readiness probe
    this.app.get('/health/ready', async (_req, res) => {
      try {
        await this.db.query('SELECT 1');
        res.json({ status: 'ok' });
      } catch (err: any) {
        res.status(503).json({ status: 'unavailable', error: err.message });
      }
    });

    // Full health check with dependency status
    this.app.get('/health', async (_req, res) => {
      const checks: Record<string, { ok: boolean; error?: string }> = {};
      let degraded = false;

      try {
        await this.db.query('SELECT 1');
        checks.postgres = { ok: true };
      } catch (err: any) {
        checks.postgres = { ok: false, error: err.message };
        degraded = true;
      }

      const status = degraded ? 'degraded' : 'ok';
      res.status(degraded ? 503 : 200).json({
        status,
        service: 'openreyestr-mcp-http',
        version: '1.0.0',
        checks,
      });
    });

    // Stats endpoint for admin monitoring (no auth — internal network only)
    this.app.get('/api/stats', async (_req, res) => {
      try {
        const tables: Record<string, { rows: number; source: string; sourceUrl: string; updateFrequency: string; lastUpdate: string | null; lastBatchCount: number }> = {};

        const queries: Array<{ key: string; table: string; source: string; sourceUrl: string; frequency: string }> = [
          { key: 'legal_entities', table: 'legal_entities', source: 'НАІС — ЄДР (юридичні особи)', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щоденно (імпорт XML)' },
          { key: 'individual_entrepreneurs', table: 'individual_entrepreneurs', source: 'НАІС — ЄДР (ФОП)', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щоденно (імпорт XML)' },
          { key: 'public_associations', table: 'public_associations', source: 'НАІС — ЄДР (ГО)', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щоденно (імпорт XML)' },
          { key: 'notaries', table: 'notaries', source: 'НАІС — Реєстр нотаріусів', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щотижня (імпорт XML)' },
          { key: 'court_experts', table: 'court_experts', source: 'НАІС — Реєстр судових експертів', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щотижня (імпорт XML)' },
          { key: 'arbitration_managers', table: 'arbitration_managers', source: 'НАІС — Реєстр арбітражних керуючих', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щотижня (імпорт XML)' },
          { key: 'debtors', table: 'debtors', source: 'НАІС — Реєстр боржників', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щоденно (імпорт CSV)' },
          { key: 'enforcement_proceedings', table: 'enforcement_proceedings', source: 'НАІС — Виконавчі провадження', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щоденно (імпорт CSV)' },
          { key: 'bankruptcy_cases', table: 'bankruptcy_cases', source: 'НАІС — Справи про банкрутство', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щоденно (імпорт XML)' },
          { key: 'special_forms', table: 'special_forms', source: 'НАІС — Спец. бланки нотаріусів', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щотижня (імпорт XML)' },
          { key: 'forensic_methods', table: 'forensic_methods', source: 'НАІС — Методики судових експертиз', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щотижня (імпорт XML)' },
          { key: 'legal_acts', table: 'legal_acts', source: 'НАІС — Нормативно-правові акти', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щотижня (імпорт XML)' },
        ];

        for (const q of queries) {
          try {
            const result = await this.db.query(
              `SELECT COUNT(*) as cnt, MAX(updated_at) as last_update, COUNT(*) FILTER (WHERE updated_at::date = (SELECT MAX(updated_at)::date FROM ${q.table})) as lb FROM ${q.table}`
            );
            tables[q.key] = {
              rows: parseInt(result.rows[0]?.cnt || '0'),
              source: q.source,
              sourceUrl: q.sourceUrl,
              updateFrequency: q.frequency,
              lastUpdate: result.rows[0]?.last_update || null,
              lastBatchCount: parseInt(result.rows[0]?.lb || '0'),
            };
          } catch {
            tables[q.key] = { rows: 0, source: q.source, sourceUrl: q.sourceUrl, updateFrequency: q.frequency, lastUpdate: null, lastBatchCount: 0 };
          }
        }

        // Registry metadata
        let registryMeta: any[] = [];
        try {
          const metaResult = await this.db.query('SELECT * FROM registry_metadata ORDER BY registry_name');
          registryMeta = metaResult.rows;
        } catch { /* ignore */ }

        // Last imports
        let recentImports: any[] = [];
        try {
          const importResult = await this.db.query('SELECT registry_name, status, records_imported, records_failed, import_completed_at FROM import_log ORDER BY import_started_at DESC LIMIT 20');
          recentImports = importResult.rows;
        } catch { /* ignore */ }

        // DB size
        let dbSizeMb = 0;
        try {
          const sizeResult = await this.db.query("SELECT pg_database_size(current_database()) as size_bytes");
          dbSizeMb = Math.round(parseInt(sizeResult.rows[0]?.size_bytes || '0') / 1024 / 1024);
        } catch { /* ignore */ }

        res.json({ service: 'openreyestr', tables, registryMeta, recentImports, dbSizeMb, timestamp: new Date().toISOString() });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
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
        const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
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
        const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
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
