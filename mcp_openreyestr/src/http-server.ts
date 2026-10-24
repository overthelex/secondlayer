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
import { globalApiRateLimit, healthCheckRateLimit } from './middleware/rate-limit';
import rateLimit from 'express-rate-limit';
import type { ChildProcess } from 'child_process';

dotenv.config();

class HTTPOpenReyestrServer {
  private app: express.Application;
  private db: Database;
  private tools: OpenReyestrTools;
  private costTracker: CostTracker;
  private mcpAPI: MCPOpenReyestrAPI;
  private metricsService: MetricsService;
  private prozorroImport: ChildProcess | null = null;

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
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://legal.org.ua,https://stage.legal.org.ua').split(',').map(o => o.trim());
    this.app.use(cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (origin.match(/^https?:\/\/localhost(:\d+)?$/)) return callback(null, true);
        callback(new Error(`CORS not allowed for origin: ${origin}`));
      },
      credentials: true,
    }));

    // JSON parsing
    this.app.use(express.json({ limit: '10mb' }));

    // Global rate limiter (express-rate-limit) — recognised by CodeQL
    this.app.use(rateLimit({
      windowMs: 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too Many Requests', code: 'RATE_LIMIT_EXCEEDED' },
    }));

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
    this.app.get('/health/ready', healthCheckRateLimit as any, async (_req, res) => {
      try {
        const start = Date.now();
        await this.db.query('SELECT 1');
        const latencyMs = Date.now() - start;
        res.json({ status: 'ok', latencyMs });
      } catch (err: any) {
        logger.warn('Healthcheck /ready failed', { error: err.message });
        res.status(503).json({ status: 'unavailable', error: err.message });
      }
    });

    // Full health check with dependency status
    this.app.get('/health', healthCheckRateLimit as any, async (_req, res) => {
      const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};
      let degraded = false;

      // PostgreSQL
      try {
        const start = Date.now();
        await this.db.query('SELECT 1');
        checks.postgres = { ok: true, latencyMs: Date.now() - start };
      } catch (err: any) {
        checks.postgres = { ok: false, error: err.message };
        degraded = true;
      }

      const status = degraded ? 'degraded' : 'ok';

      if (degraded) {
        const failedChecks = Object.entries(checks)
          .filter(([, v]) => !v.ok)
          .map(([k, v]) => `${k}: ${v.error}`);
        logger.warn('Healthcheck degraded', { failedChecks });
      }

      res.status(degraded ? 503 : 200).json({
        status,
        service: 'openreyestr-mcp-http',
        uptime: Math.round(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        checks,
      });
    });

    // Global API rate limiter — baseline protection for all /api/ routes (120 req/min per IP)
    this.app.use('/api', globalApiRateLimit as any);

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
          { key: 'administrative_units', table: 'administrative_units', source: 'НАІС — Адміністративно-територіальний устрій', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щотижня (імпорт XML)' },
          { key: 'streets', table: 'streets', source: 'НАІС — Вулиці населених пунктів', sourceUrl: 'https://nais.gov.ua/pass_opendata', frequency: 'Щотижня (імпорт XML)' },
        ];

        // Use pg_class.reltuples for fast row estimates (avoids full table scans on 30M+ row tables)
        const tableNames = queries.map(q => q.table);
        const rowEstimates: Record<string, number> = {};
        try {
          const estResult = await this.db.query(
            `SELECT relname, reltuples::bigint as approx_rows
             FROM pg_class WHERE relname = ANY($1)`,
            [tableNames]
          );
          for (const row of estResult.rows) {
            rowEstimates[row.relname] = Math.max(0, parseInt(row.approx_rows || '0'));
          }
        } catch { /* ignore */ }

        // Get last update times from import_log (fast — small table)
        const importTimes: Record<string, { lastUpdate: string | null; lastBatchCount: number }> = {};
        try {
          const importResult = await this.db.query(`
            SELECT DISTINCT ON (registry_name) registry_name, import_completed_at, records_imported
            FROM import_log WHERE status = 'completed'
            ORDER BY registry_name, import_started_at DESC
          `);
          for (const row of importResult.rows) {
            importTimes[row.registry_name] = {
              lastUpdate: row.import_completed_at,
              lastBatchCount: parseInt(row.records_imported || '0'),
            };
          }
        } catch { /* ignore */ }

        // For tables without import_log entries, get MAX(updated_at) only for small tables
        for (const q of queries) {
          const est = rowEstimates[q.table] || 0;
          const imp = importTimes[q.table] || importTimes[q.key];
          if (imp) {
            tables[q.key] = {
              rows: est,
              source: q.source,
              sourceUrl: q.sourceUrl,
              updateFrequency: q.frequency,
              lastUpdate: imp.lastUpdate,
              lastBatchCount: imp.lastBatchCount,
            };
          } else {
            // Fallback: only query MAX(updated_at) for small tables (< 1M rows)
            let lastUpdate: string | null = null;
            let lastBatchCount = 0;
            if (est < 1_000_000) {
              try {
                const result = await this.db.query(
                  `SELECT MAX(updated_at) as last_update FROM ${q.table}`
                );
                lastUpdate = result.rows[0]?.last_update || null;
              } catch { /* ignore */ }
            }
            tables[q.key] = {
              rows: est,
              source: q.source,
              sourceUrl: q.sourceUrl,
              updateFrequency: q.frequency,
              lastUpdate,
              lastBatchCount,
            };
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

    // Admin: trigger NAIS registry sync (called by opendata-sync scheduler)
    this.app.post('/api/admin/sync-registry', requireAPIKey as any, (async (req: AuthenticatedRequest, res: Response) => {
      const { registry } = req.body;
      if (!registry || typeof registry !== 'string') {
        res.status(400).json({ error: 'Missing "registry" parameter' });
        return;
      }

      logger.info('Admin sync-registry triggered', { registry, clientKey: req.clientKey?.substring(0, 8) });

      // ProZorro is an API feed, not a NAIS dataset: run the incremental
      // importer (LEXAI-2089) as a child process. It resumes from its own cursor
      // and holds a pg advisory lock, so an overlapping trigger exits at once.
      if (registry === 'prozorro') {
        if (this.prozorroImport && this.prozorroImport.exitCode === null) {
          res.status(409).json({ error: 'ProZorro import already running', pid: this.prozorroImport.pid });
          return;
        }
        const { spawn } = await import('child_process');
        const path = await import('path');
        const maxMinutes = String(parseInt(process.env.PROZORRO_SYNC_MAX_MINUTES || '180', 10));
        const child = spawn(
          process.execPath,
          [path.join(__dirname, 'scripts', 'import-prozorro.js'), `--max-minutes=${maxMinutes}`],
          { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
        );
        this.prozorroImport = child;
        child.stdout?.on('data', (d: Buffer) => logger.info(`[prozorro] ${d.toString().trimEnd()}`));
        child.stderr?.on('data', (d: Buffer) => logger.warn(`[prozorro] ${d.toString().trimEnd()}`));
        child.on('exit', (code) => logger.info('ProZorro import finished', { code }));
        res.status(202).json({ status: 'accepted', message: 'ProZorro incremental import started', registry, pid: child.pid });
        return;
      }

      try {
        // Import and run sync for the specified registry
        const { REGISTRIES } = await import('./config/registries');
        const config = REGISTRIES[registry];
        if (!config) {
          res.status(404).json({ error: `Unknown registry: ${registry}`, available: Object.keys(REGISTRIES) });
          return;
        }

        // Run sync in background — return immediately with 202
        res.status(202).json({
          status: 'accepted',
          message: `Sync started for ${config.title} (${registry})`,
          registry,
        });

        // Execute sync after responding
        const { Pool } = await import('pg');
        const pool = new Pool({
          host: process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.POSTGRES_PORT || '5432'),
          user: process.env.POSTGRES_USER || 'openreyestr',
          password: process.env.POSTGRES_PASSWORD,
          database: process.env.POSTGRES_DB || 'openreyestr_prod',
        });

        try {
          const { importXml } = await import('./services/generic-xml-importer');
          const { importCsv } = await import('./services/csv-importer');
          const fs = await import('fs');
          const path = await import('path');
          const https = await import('https');
          const http = await import('http');

          const dataDir = process.env.NAIS_DATA_DIR || '/tmp/nais-sync';
          const registryDir = path.join(dataDir, registry);
          fs.mkdirSync(registryDir, { recursive: true });
          const zipPath = path.join(dataDir, `${registry}.zip`);

          // Download
          logger.info(`Downloading ${registry} from ${config.datasetUrl}`);
          await new Promise<void>((resolve, reject) => {
            const proto = config.datasetUrl.startsWith('https') ? https : http;
            const doGet = (url: string) => {
              (proto as any).get(url, { timeout: 30 * 60 * 1000 }, (response: any) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                  doGet(response.headers.location.startsWith('http') ? response.headers.location : new URL(response.headers.location, url).href);
                  return;
                }
                if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
                const ws = fs.createWriteStream(zipPath);
                response.pipe(ws);
                ws.on('finish', () => { ws.close(); resolve(); });
                ws.on('error', reject);
              }).on('error', reject);
            };
            doGet(config.datasetUrl);
          });

          // Extract
          const { execFileSync } = await import('child_process');
          try {
            execFileSync('unzip', ['-o', '-q', zipPath, '-d', registryDir], { timeout: 10 * 60 * 1000 });
          } catch { /* fallback handled by sync-all-registries */ }

          // Find data file
          const ext = config.format === 'csv' ? '.csv' : '.xml';
          const files = fs.readdirSync(registryDir);
          const dataFile = config.innerFileName
            ? files.find((f: string) => f.includes(config.innerFileName))
            : files.find((f: string) => f.toLowerCase().endsWith(ext));

          if (!dataFile) {
            logger.error(`No ${ext} file found for ${registry}`);
            return;
          }

          const dataFilePath = path.join(registryDir, dataFile);

          // Log import
          await pool.query(
            `INSERT INTO import_log (registry_name, file_name, status) VALUES ($1, $2, 'in_progress')`,
            [registry, dataFile],
          );

          // Import
          let imported = 0;
          let errors = 0;
          if (config.format === 'xml') {
            const stats = await importXml(pool, config, dataFilePath, dataFile);
            imported = stats.imported;
            errors = stats.errors;
          } else {
            const stats = await importCsv(pool, config, dataFilePath, dataFile);
            imported = stats.imported;
            errors = stats.errors;
          }

          // Update metadata
          await pool.query(
            `UPDATE registry_metadata SET last_update_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP WHERE registry_name = $1`,
            [registry],
          );
          await pool.query(
            `UPDATE import_log SET import_completed_at = CURRENT_TIMESTAMP, records_imported = $1, records_failed = $2, status = 'completed' WHERE registry_name = $3 AND status = 'in_progress'`,
            [imported, errors, registry],
          );

          // Cleanup
          try { fs.unlinkSync(zipPath); } catch { /* ok */ }
          try { fs.rmSync(registryDir, { recursive: true, force: true }); } catch { /* ok */ }

          logger.info(`Sync complete: ${registry} — ${imported} imported, ${errors} errors`);
        } catch (syncErr: any) {
          logger.error(`Sync failed for ${registry}:`, syncErr);
          try {
            await pool.query(
              `UPDATE import_log SET import_completed_at = CURRENT_TIMESTAMP, status = 'failed', error_message = $1 WHERE registry_name = $2 AND status = 'in_progress'`,
              [syncErr.message, registry],
            );
          } catch { /* ok */ }
        } finally {
          await pool.end();
        }
      } catch (err: any) {
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        }
        logger.error('sync-registry error:', err);
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
