import express, { Request, Response } from 'express';
import { createServer } from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { logger } from './utils/logger.js';
import { dualAuth, requireJWT, optionalJWT, AuthenticatedRequest as DualAuthRequest } from './middleware/dual-auth.js';
import { createSubstrateRoutes } from './routes/substrate-routes.js';
import { createAccessGate } from './middleware/access-gate-middleware.js';
import { createAccessRoutes } from './routes/access-routes.js';
import authRouter from './routes/auth.js';
import { setAuthCache } from './controllers/auth.js';
import { setOidcCache } from './services/oidc-service.js';
import { createBackendCoreServices, BackendCoreServices } from './factories/core-services.js';
import { createToolServices, ToolServices } from './factories/tool-services.js';
import { createAppServices, AppServices } from './factories/app-services.js';
import { createRestAPIRouter } from './routes/rest-api.js';
import { createBillingInlineRoutes } from './routes/billing-inline-routes.js';
import { createChatInlineRoutes } from './routes/chat-inline-routes.js';
import { createMiscInlineRoutes } from './routes/misc-inline-routes.js';
import { createMCPSSERoutes } from './routes/mcp-sse-routes.js';
import { createToolExecutionRoutes } from './routes/tool-execution-routes.js';
import { createUKJudgmentAccessRoutes } from './routes/uk-judgment-access-routes.js';
import { createPaymentRouter, createWebhookRouter } from './routes/payment-routes.js';
import { createBillingRoutes } from './routes/billing-routes.js';
import { createAdminRoutes } from './routes/admin-routes.js';
import { createB2BInvoiceRoutes } from './routes/b2b-invoice-routes.js';
import { createBillingServices, BillingServices } from './factories/billing-services.js';
import { createEncryptionRoutes } from './routes/encryption-routes.js';
import { createWorkerHeartbeatRoute } from './routes/worker-heartbeat-routes.js';
import { createDecisionsRoutes } from './routes/decisions-routes.js';
import { createERAUProxyRoutes } from './routes/erau-proxy-routes.js';
import { createNewsRoutes } from './routes/news-routes.js';
import { NewsArticleService } from './services/news-article-service.js';
import { ERAUCacheService } from './services/erau-cache-service.js';
import { attachTerminalWebSocket } from './routes/terminal-routes.js';
import { attachVideoCallSignaling } from './routes/video-call-signaling.js';
import { SttService } from './services/stt-service.js';
import { VideoCallService } from './services/video-call-service.js';
import { createVideoCallRoutes } from './routes/video-call-routes.js';
import { getConsultationMessageBus } from './services/consultation-message-bus.js';
import { createTeamRoutes } from './routes/team-routes.js';
import { createTeamService } from './services/team-service.js';
import { createTestEmailRoute } from './routes/test-email-route.js';
import passport from 'passport';
import { createApiKeyRouter } from './routes/api-key-routes.js';
import { getRedisClient } from './utils/redis-client.js';
import { getOpenAIManager } from '@secondlayer/shared';
import { CacheAdapter } from './infrastructure/adapters/cache-adapter.js';
import { LLMAdapter } from './infrastructure/adapters/llm-adapter.js';
import { createTemplateRoutes } from './routes/template-routes.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createOAuthRouter } from './routes/oauth-routes.js';
// createHybridAuthMiddleware available from './middleware/oauth-auth.js' if needed
import { healthCheckRateLimit, webhookRateLimit, globalApiRateLimit, consultationRateLimit, publicSearchRateLimit } from './middleware/rate-limit.js';
import { createUploadRouter } from './routes/upload-routes.js';
import { createConversationRouter } from './routes/conversation-routes.js';
import { createShareRouter } from './routes/share-routes.js';
import { createEvidenceRoutes } from './routes/evidence-routes.js';
import { createEdsrRoutes } from './routes/edrsr-routes.js';
import { createGdprRouter } from './routes/gdpr-routes.js';
import { createBlogCommentsRouter } from './routes/blog-comments.js';
import { createMatterRoutes } from './routes/matter-routes.js';
import { createContractRoutes } from './routes/contract-routes.js';
import { getUploadProcessingMetrics } from './routes/upload-routes.js';
import { createTimeEntryRoutes } from './routes/time-entry-routes.js';
import { createInvoiceRoutes } from './routes/invoice-routes.js';
import { getLLMManager } from './utils/llm-client-manager.js';
import { setRateLimitCache } from './middleware/rate-limit.js';
import { setUploadRateLimitCache } from './middleware/upload-rate-limit.js';
import { requireEmailVerified } from './middleware/require-email-verified.js';
import { createClassificationRoutes } from './routes/classification-routes.js';
import { createWorkflowSetRoutes, createWorkflowRoutes } from './routes/workflow-routes.js';
import { createAttorneyRoutes } from './routes/attorney-routes.js';
import { createConsultationRoutes } from './routes/consultation-routes.js';
import { JudgesService } from './services/judges-service.js';
import { createJudgesRoutes } from './routes/judges-routes.js';
import { JudgeAnalyticsService } from './services/judge-analytics-service.js';
import { createJudgeAnalyticsRoutes } from './routes/judge-analytics-routes.js';
import { createReferralRoutes } from './routes/referral-routes.js';
import { createSupportRoutes } from './routes/support-routes.js';
import { createAbuseRoutes } from './routes/abuse-routes.js';
import { createLegislationMonitoringRoutes } from './routes/legislation-monitoring-routes.js';
import { createUsageRoutes } from './routes/usage-routes.js';
import { createSessionReplayRoutes, createAdminSessionReplayRoutes } from './routes/session-replay-routes.js';
import { createEchrSyncRouter } from './routes/admin/echr-sync.js';
import { SessionReplayService } from './services/session-replay-service.js';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';

dotenv.config();

class HTTPMCPServer {
  private app: express.Application;
  private services: BackendCoreServices;
  private billing: BillingServices;
  private tools: ToolServices;
  private app_: AppServices;
  private mcpSseSessions: Map<string, SSEServerTransport> = new Map();

  constructor() {
    this.app = express();
    this.app.set('trust proxy', 1);

    // Initialize core services via factory
    this.services = createBackendCoreServices();

    // Create LLM adapter for dependency injection
    const llmAdapter = new LLMAdapter(getLLMManager());

    // Initialize billing, payment, and cost tracking services via factory
    this.billing = createBillingServices(this.services.db, this.services.embeddingService);

    // Initialize tool registry, service proxy, document tools, upload/minio/vault via factory
    this.tools = createToolServices(this.services, this.billing.costTracker, llmAdapter);

    // Initialize all application services via factory
    this.app_ = createAppServices(this.services, this.billing, this.tools, llmAdapter);

    // Setup middleware and routes AFTER services are initialized
    this.setupMiddleware();
    this.setupRoutes();

    // Scheduler role: these crons must run on exactly ONE instance. Web replicas set
    // RUN_SCHEDULER=false so escrow release / payout / Monobank reconciliation / cleanup
    // jobs are not multiplied across workers. Default (unset) = enabled, so a single
    // container keeps current behaviour (LEXAI-1802).
    if (process.env.RUN_SCHEDULER !== 'false') {
    // Cron: auto-release stale escrow payments daily at 07:00 Kyiv time
    cron.schedule('0 7 * * *', () => {
      logger.info('[Cron] Running auto-release stale escrow payments');
      this.app_.consultationPaymentService.autoReleaseStaleCompletedPayments().catch(err => {
        logger.error('[Cron] Auto-release escrow failed', { error: (err as Error).message });
      });
    }, { timezone: 'Europe/Kyiv' });

    // Cron: reconcile pending Monobank payments every 30 minutes
    cron.schedule('*/30 * * * *', () => {
      logger.info('[Cron] Running Monobank payment reconciliation');
      this.billing.monobankService.reconcilePendingPayments().catch(err => {
        logger.error('[Cron] Monobank reconciliation failed', { error: (err as Error).message });
      });
    }, { timezone: 'Europe/Kyiv' });

    // Cron: flag stuck consultations + alert on failed payouts daily at 08:00 Kyiv time
    cron.schedule('0 8 * * *', () => {
      logger.info('[Cron] Running stuck escrow and failed payout check');
      this.app_.consultationPaymentService.flagStuckConsultationsAndPayouts().catch(err => {
        logger.error('[Cron] Stuck escrow check failed', { error: (err as Error).message });
      });
    }, { timezone: 'Europe/Kyiv' });

    // Cron: check legislation changes daily at 06:00 Kyiv time
    cron.schedule('0 6 * * *', () => {
      logger.info('[Cron] Running legislation change detection');
      this.app_.legislationMonitoringService.checkAllSubscribedLegislation().catch(err => {
        logger.error('[Cron] Legislation change detection failed', { error: (err as Error).message });
      });
    }, { timezone: 'Europe/Kyiv' });

    // Cron: cleanup expired user sessions every 6 hours (GDPR Art.5(1)(c) data minimization)
    cron.schedule('0 */6 * * *', async () => {
      try {
        const { getUserService } = await import('./middleware/dual-auth.js');
        const count = await getUserService().cleanupExpiredSessions();
        if (count > 0) logger.info('[Cron] Cleaned up expired sessions', { count });
      } catch (err) {
        logger.error('[Cron] Session cleanup failed', { error: (err as Error).message });
      }
    }, { timezone: 'Europe/Kyiv' });

    // Cron: purge soft-deleted documents older than 30 days, daily at 03:00
    cron.schedule('0 3 * * *', async () => {
      try {
        await this.services.db.query('SELECT purge_soft_deleted_documents(30)');
        logger.info('[Cron] Purged soft-deleted documents');
      } catch (err) {
        logger.error('[Cron] Soft-delete purge failed', { error: (err as Error).message });
      }
    }, { timezone: 'Europe/Kyiv' });

    // Cron: cleanup expired OAuth tokens/codes, daily at 04:00
    cron.schedule('0 4 * * *', async () => {
      try {
        await this.services.db.query('SELECT cleanup_expired_oauth_data()');
        logger.info('[Cron] Cleaned up expired OAuth data');
      } catch (err) {
        logger.error('[Cron] OAuth cleanup failed', { error: (err as Error).message });
      }
    }, { timezone: 'Europe/Kyiv' });
    } else {
      logger.info('[Cron] RUN_SCHEDULER=false — crons disabled on this instance (web replica)');
    }
  }

  private setupMiddleware() {
    // CORS - разрешаем запросы от клиентов
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://legal.org.ua,https://stage.legal.org.ua').split(',').map(o => o.trim());
    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, curl, mobile apps)
        if (!origin) return callback(null, true);
        // Allow configured origins
        if (allowedOrigins.includes(origin)) return callback(null, true);
        // Allow localhost only in development
        if (process.env.NODE_ENV !== 'production' && origin.match(/^https?:\/\/localhost(:\d+)?$/)) return callback(null, true);
        logger.warn(`CORS blocked origin: ${origin}`);
        callback(null, false);
      },
      credentials: true,
      exposedHeaders: ['X-Upload-Queue-Depth', 'X-Upload-Throttle', 'Retry-After', 'X-Total-Count'],
    }));

    // Global rate limiter (express-rate-limit) — recognised by CodeQL as proper rate limiting.
    // Our custom Redis-backed limiters still apply per-route for finer control.
    // Upload routes are excluded — they have their own per-user Redis-backed limits
    // (upload-rate-limit.ts) and the global IP-based limit blocks bulk folder uploads
    // through Cloudflare (all requests arrive from the same CF edge IP).
    this.app.use(rateLimit({
      windowMs: 60 * 1000,
      max: 900,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too Many Requests', code: 'RATE_LIMIT_EXCEEDED' },
      skip: (req) => req.path.startsWith('/upload'),
    }));

    // Monobank webhooks need raw body BEFORE json parsing for signature verification
    // Mount webhook routes with raw body parser and rate limiting
    this.app.use(
      '/webhooks',
      webhookRateLimit as any,
      express.raw({ type: 'application/json', limit: '10mb' }),
      createWebhookRouter(this.billing.monobankService, this.billing.binancePayService, this.billing.nowpaymentsService, this.app_.consultationPaymentService)
    );

    // JSON parsing with UTF-8 support (for all other routes)
    this.app.use(express.json({
      limit: '10mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    }));

    // URL-encoded form parsing (required for OAuth 2.0 token endpoint)
    this.app.use(express.urlencoded({
      extended: true,
      limit: '10mb'
    }));

    // Initialize Passport middleware
    this.app.use(passport.initialize() as any);

    // Prometheus HTTP metrics middleware
    this.app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const durationNs = Number(process.hrtime.bigint() - start);
        const durationSec = durationNs / 1e9;
        const route = this.app_.metricsService.normalizeRoute(req.route?.path || req.path);
        const labels = { method: req.method, route, status_code: String(res.statusCode) };
        this.app_.metricsService.httpRequestDuration.observe(labels, durationSec);
        this.app_.metricsService.httpRequestsTotal.inc(labels);
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
        const metrics = await this.app_.metricsService.getMetrics();
        res.set('Content-Type', this.app_.metricsService.getContentType());
        res.end(metrics);
      } catch (err: any) {
        res.status(500).end(err.message);
      }
    });

    // Liveness probe — process is alive (always 200)
    this.app.get('/health/live', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // Readiness probe + full health — always 200 for Docker healthcheck,
    // returns detailed dependency checks array.
    // Works even during startup (reports initialized: false).
    const healthHandler = async (_req: any, res: any) => {
      const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

      // PostgreSQL
      try {
        const start = Date.now();
        await this.services.db.query('SELECT 1');
        checks.postgres = { ok: true, latencyMs: Date.now() - start };
      } catch (err: any) {
        checks.postgres = { ok: false, error: err.message };
      }

      // Redis
      try {
        const start = Date.now();
        const redis = await getRedisClient();
        if (redis) {
          await redis.ping();
          checks.redis = { ok: true, latencyMs: Date.now() - start };
        } else {
          checks.redis = { ok: false, error: 'not connected' };
        }
      } catch (err: any) {
        checks.redis = { ok: false, error: err.message };
      }

      // Qdrant
      try {
        const start = Date.now();
        const qdrantResult = await this.services.embeddingService.healthCheck();
        checks.qdrant = { ...qdrantResult, latencyMs: Date.now() - start };
      } catch (err: any) {
        checks.qdrant = { ok: false, error: err.message };
      }

      // MinIO
      try {
        const start = Date.now();
        const minioResult = await this.tools.minioService.healthCheck();
        checks.minio = { ...minioResult, latencyMs: Date.now() - start };
      } catch (err: any) {
        checks.minio = { ok: false, error: err.message };
      }

      // DB pool stats (synchronous, no network call)
      try {
        const poolStats = this.services.db.getPoolStats();
        checks.db_pool = { ok: true, ...poolStats } as any;
      } catch (err: any) {
        checks.db_pool = { ok: false, error: err.message };
      }

      // OpenAI API availability (non-blocking — degraded if down, not a hard failure)
      try {
        const openaiManager = getOpenAIManager();
        if (!openaiManager.isAvailable()) {
          checks.openai = { ok: false, error: 'no API keys configured' };
        } else {
          const start = Date.now();
          const ac = new AbortController();
          const timeout = setTimeout(() => ac.abort(), 2000);
          try {
            await openaiManager.getClient().models.list({ signal: ac.signal as any });
            checks.openai = { ok: true, latencyMs: Date.now() - start };
          } finally {
            clearTimeout(timeout);
          }
        }
      } catch (err: any) {
        // Report as degraded, not a hard failure — OpenAI outages should not kill the health check
        checks.openai = { ok: false, error: err.name === 'AbortError' ? 'timeout (2s)' : err.message };
      }

      // Payout reconciliation (non-blocking)
      try {
        const recon = await this.app_.consultationPaymentService.getPayoutReconciliation();
        checks.payout_reconciliation = {
          ok: recon.ok,
          ...(recon.ok ? {} : { error: `Mismatch: ${recon.mismatch.toFixed(2)} UAH (released: ${recon.releasedTotal}, payouts: ${recon.payoutsTotal})` }),
        };
      } catch (err: any) {
        checks.payout_reconciliation = { ok: false, error: err.message };
      }

      const allOk = Object.values(checks).every(c => c.ok);

      // Always 200 — Docker healthcheck must not kill container during slow init
      res.json({
        status: allOk ? 'ok' : 'degraded',
        initialized: (this as any)._initialized === true,
        service: 'secondlayer-mcp-http',
        uptime: Math.round(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        checks,
      });
    };

    // Lightweight readiness probe for Docker healthcheck — no infra details exposed
    this.app.get('/health/ready', (_req: any, res: any) => {
      res.json({
        status: 'ok',
        initialized: (this as any)._initialized === true,
        service: 'secondlayer-mcp-http',
        uptime: Math.round(process.uptime()),
      });
    });
    // Public health check — minimal info only (no infra details)
    this.app.get('/health', healthCheckRateLimit as any, (_req: any, res: any) => {
      res.json({
        status: 'ok',
        initialized: (this as any)._initialized === true,
        service: 'secondlayer-mcp-http',
        uptime: Math.round(process.uptime()),
      });
    });
    // Detailed health check — admin only (exposes dependency statuses)
    this.app.get('/api/admin/health', requireJWT as any, healthHandler);

    // MCP SSE routes (SSE endpoints, OAuth discovery, redirects)
    this.app.use(createMCPSSERoutes({
      mcpSSEServer: this.app_.mcpSSEServer,
      db: this.services.db,
      toolRegistry: this.tools.toolRegistry,
      chatService: this.app_.chatService,
      oauthService: this.app_.oauthService,
      apiKeyService: this.billing.apiKeyService,
      costTracker: this.billing.costTracker,
      creditService: this.billing.creditService,
      billingService: this.billing.billingService,
      mcpSseSessions: this.mcpSseSessions,
    }));

    // Authentication routes (public - OAuth endpoints, optional JWT for /auth/me etc.)
    this.app.use('/auth', optionalJWT as any, authRouter);

    // OAuth 2.0 routes for ChatGPT integration (public)
    this.app.use('/oauth', createOAuthRouter(this.app_.oauthService));
    logger.info('OAuth 2.0 routes registered at /oauth');

    // Global API rate limiter — baseline protection for all /api/ routes (120 req/min per IP).
    // More specific per-endpoint limiters (auth, chat, upload, etc.) still apply additionally.
    // Principle 7 of the Find Case Law licence: licence holders must not index the
    // contents of judgments on search engines, and must consider how they prevent
    // third parties crawling the records or the data extracted from them. Every /api
    // route needs a bearer token, so a crawler is already turned away — this header
    // says so explicitly rather than relying on the 401, and covers anything that
    // proxies or mirrors a response.
    this.app.use('/api', (_req, res, next) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      next();
    });

    this.app.use('/api', globalApiRateLimit as any);

    // Document classification routes - must come before /api/documents generic REST route
    this.app.use('/api/documents/classify', requireJWT as any, createClassificationRoutes(this.app_.classificationService));

    // Misc document routes (stats, folders, preview, move) - must come before generic /:id REST route
    this.app.use('/api', createMiscInlineRoutes({
      db: this.services.db,
      classificationService: this.app_.classificationService,
      vaultTools: this.tools.vaultTools,
      minioService: this.tools.minioService,
      legislationTools: this.services.legislationTools,
    }));

    // REST API for admin panel (CRUD operations) - require JWT (user login)
    this.app.use('/api/documents', requireJWT as any, createRestAPIRouter(this.services.db));
    this.app.use('/api/patterns', requireJWT as any, createRestAPIRouter(this.services.db));
    this.app.use('/api/queries', requireJWT as any, createRestAPIRouter(this.services.db));

    // User profile endpoint - require JWT
    this.app.use('/api/auth', requireJWT as any, authRouter);

    // Phase 2 Billing: API key management - require JWT (user login)
    this.app.use('/api/keys', requireJWT as any, createApiKeyRouter(this.billing.apiKeyService, this.billing.creditService));
    logger.info('API key management routes registered at /api/keys');

    // Geo detection endpoint (public, no auth required)
    // Returns country/language/currency defaults based on Cloudflare headers
    this.app.get('/api/geo', (async (req: Request, res: Response) => {
      try {
        // Cloudflare adds CF-IPCountry header automatically for proxied domains
        const cfCountry = (req.headers['cf-ipcountry'] as string || '').toUpperCase();
        const acceptLang = req.headers['accept-language'] || '';

        // Determine country
        const country = cfCountry && cfCountry !== 'XX' && cfCountry !== 'T1'
          ? cfCountry
          : 'OTHER';

        // Determine language from country or Accept-Language
        let language = 'en';
        if (country === 'UA' || acceptLang.startsWith('uk')) {
          language = 'uk';
        }

        // Determine currency from country
        let currency = 'USD';
        if (country === 'UA') {
          currency = 'UAH';
        } else if (['DE', 'FR', 'NL', 'EE', 'AT', 'BE', 'ES', 'IT', 'PT', 'FI', 'IE', 'LU', 'SK', 'SI', 'LV', 'LT', 'MT', 'CY', 'GR', 'HR'].includes(country)) {
          currency = 'EUR';
        }

        res.json({ country, language, currency });
      } catch (error: any) {
        logger.error('[GeoAPI] Failed to detect geo', { error: error.message });
        res.json({ country: 'OTHER', language: 'uk', currency: 'UAH' });
      }
    }) as any);

    // Currency exchange rate endpoint (public, no auth required)
    this.app.get('/api/currency/rate', (async (_req: Request, res: Response) => {
      try {
        const rateInfo = await this.billing.currencyService.getUsdToUahRate();
        res.json(rateInfo);
      } catch (error: any) {
        logger.error('[CurrencyAPI] Failed to get exchange rate', { error: error.message });
        res.status(500).json({ error: 'Не вдалося отримати курс валют' });
      }
    }) as any);

    // Public donation endpoint — no auth, no balance credit.
    // Creates a Monobank invoice with DONATION- reference. Money lands in the
    // merchant Monobank account; webhook gracefully ignores (payment_intent
    // lookup returns empty, handler returns {received:true}).
    this.app.post('/api/donations/create', (async (req: Request, res: Response) => {
      try {
        const { amount_usd, amount_uah, email } = req.body || {};

        let amountUah: number;
        if (typeof amount_uah === 'number' && amount_uah >= 1) {
          amountUah = amount_uah;
        } else if (typeof amount_usd === 'number' && amount_usd >= 1) {
          const converted = await this.billing.currencyService.convertUsdToUah(amount_usd);
          amountUah = Math.round(converted.amountUah);
        } else {
          return res.status(400).json({
            error: 'Invalid request',
            message: 'amount_usd (≥1) or amount_uah (≥1) is required',
          });
        }

        if (amountUah > 200000) {
          return res.status(400).json({
            error: 'Invalid request',
            message: 'Максимальна сума донату — 200 000 ₴',
          });
        }

        const safeEmail = typeof email === 'string' && email.length < 256 ? email : undefined;
        const result = await this.billing.monobankService.createDonationInvoice(amountUah, safeEmail);
        res.json({ ...result, amountUah });
      } catch (error: any) {
        logger.error('[DonationAPI] Failed to create donation invoice', { error: error.message });
        res.status(500).json({
          error: 'Не вдалося створити рахунок для донату',
        });
      }
    }) as any);

    // Billing inline routes (balance, history, topup, settings, statistics, invoices)
    this.app.use('/api/billing', requireJWT as any, createBillingInlineRoutes({
      billingService: this.billing.billingService,
      costTracker: this.billing.costTracker,
      invoiceService: this.billing.invoiceService,
      currencyService: this.billing.currencyService,
      db: this.services.db,
    }));

    // Payment routes - require JWT (user login)
    // POST /api/billing/payment/monobank/create - Create Monobank invoice
    // POST /api/billing/payment/nowpayments/create - Create NOWPayments invoice
    // GET /api/billing/payment/monobank/:invoiceId/status - Check Monobank status
    // GET /api/billing/payment/:provider/:paymentId/status - Check payment status
    this.app.use('/api/billing/payment', requireJWT as any, createPaymentRouter(this.billing.monobankService, this.billing.metamaskService, this.billing.binancePayService, this.billing.nowpaymentsService, this.services.db));

    // Test email route - require JWT (user login)
    // POST /api/billing/test-email - Send test email
    this.app.use('/api/billing/test-email', requireJWT as any, createTestEmailRoute(this.billing.emailService));

    // Additional billing routes (supplements billing-inline-routes above, no overlapping paths):
    // GET /api/billing/pricing-info - Pricing tier info
    // GET|PUT /api/billing/billing-info - Company details for invoicing
    // GET|DELETE|PUT /api/billing/payment-methods[/:id[/primary]] - Saved payment methods
    // GET|PUT /api/billing/preferences - User request preferences
    // POST /api/billing/preferences/preset - Apply preset configuration
    // GET /api/billing/presets - All available presets
    // POST /api/billing/estimate-costs - Estimate costs for different presets
    // GET /api/billing/full-settings - Combined billing and preferences
    // POST /api/billing/estimate-price - Estimate price with user's tier
    this.app.use('/api/billing', requireJWT as any, createBillingRoutes(this.billing.billingService, this.billing.userPreferencesService, this.billing.pricingService));

    // B2B Invoice routes - bank transfer invoicing for legal entities
    this.app.use('/api/b2b-invoices', requireJWT as any, createB2BInvoiceRoutes(this.billing.b2bInvoiceService, this.billing.billingService, this.billing.subscriptionService, this.services.db));

    // Team management routes
    // GET /api/team/members - Get team members
    // POST /api/team/invite - Invite new member
    // PUT /api/team/members/:memberId - Update member role
    // DELETE /api/team/members/:memberId - Remove member
    // POST /api/team/members/:memberId/resend-invite - Resend invitation
    // GET /api/team/stats - Get team statistics
    const teamService = createTeamService(this.services.db);
    this.app.use('/api/team', requireJWT as any, createTeamRoutes(teamService));

    // Conversation routes - server-side chat persistence
    this.app.use('/api/conversations', requireJWT as any, createConversationRouter(this.app_.conversationService));
    this.app.use('/api/conversations', requireJWT as any, createEvidenceRoutes(this.app_.evidenceService));
    logger.info('Conversation and evidence routes registered at /api/conversations');

    // Share routes - shareable read-only chat links among platform users
    this.app.use('/api/shares', requireJWT as any, createShareRouter(this.app_.shareService));
    logger.info('Share routes registered at /api/shares');

    // EDRSR direct access routes
    this.app.use('/api/edrsr', requireJWT as any, createEdsrRoutes(this.services.db));
    logger.info('EDRSR routes registered at /api/edrsr');

    // Blog comments - GET is public, POST/DELETE require JWT (checked inside handler)
    this.app.use('/api/blog', optionalJWT as any, createBlogCommentsRouter(this.services.db.getPool()));
    logger.info('Blog comments routes registered at /api/blog/comments');

    // GDPR routes - data export and deletion
    this.app.use('/api/gdpr', requireJWT as any, createGdprRouter(this.app_.gdprService));
    logger.info('GDPR routes registered at /api/gdpr');

    // Upload routes - chunked file upload with MinIO storage
    // POST /api/upload/init - Create upload session
    // POST /api/upload/:uploadId/chunk - Upload chunk
    // POST /api/upload/:uploadId/complete - Assemble and process
    // GET /api/upload/:uploadId/status - Check status
    // DELETE /api/upload/:uploadId - Cancel
    // GET /api/upload/active - List active sessions
    this.app.use(
      '/api/upload',
      requireJWT as any,
      requireEmailVerified as any,
      createAccessGate(this.services.db, { feature: 'upload' }) as any,
      createUploadRouter(
        this.tools.uploadService,
        this.tools.minioService,
        this.tools.vaultTools,
        this.services.db,
        this.app_.uploadQueueService,
        this.services.documentService
      )
    );
    logger.info('Upload routes registered at /api/upload');

    // Client-Matter segregation routes (matters, clients, legal holds, audit)
    this.app.use('/api/matters', requireJWT as any, createMatterRoutes(
      this.app_.matterService, this.app_.conflictCheckService, this.app_.legalHoldService, this.app_.auditService,
      this.services.db, this.app_.llmAdapter
    ));
    logger.info('Matter routes registered at /api/matters');

    // Contract acceptance routes
    this.app.use('/api/contracts', requireJWT as any, createContractRoutes(this.app_.contractService));
    logger.info('Contract routes registered at /api/contracts');

    // Referral system routes
    this.app.use('/api/referral', createReferralRoutes(this.billing.referralService));
    logger.info('Referral routes registered at /api/referral');

    // Support widget (FAB) — feedback / question submissions
    this.app.use('/api/support', createSupportRoutes(this.billing.emailService, this.services.db));
    logger.info('Support widget routes registered at /api/support');

    // Abuse report — public form, no auth required
    this.app.use('/api/abuse-report', createAbuseRoutes(this.services.db, this.billing.emailService));
    logger.info('Abuse report routes registered at /api/abuse-report');

    // Legislation monitoring routes - subscriptions, changes, notifications
    this.app.use('/api/legislation/monitoring', requireJWT as any, createLegislationMonitoringRoutes(this.app_.legislationMonitoringService));
    logger.info('Legislation monitoring routes registered at /api/legislation/monitoring');

    // Judges routes - search judges from VKKS data
    const judgesService = new JudgesService(this.services.db, this.services.zoAdapter);
    this.app.use('/api/judges', requireJWT as any, createJudgesRoutes(judgesService));

    // Judge analytics routes - pre-computed metrics from EDRSR
    const judgeAnalyticsService = new JudgeAnalyticsService(this.services.db);
    this.app.use('/api/judge-analytics', requireJWT as any, createJudgeAnalyticsRoutes(judgeAnalyticsService));
    logger.info('Judge analytics routes registered at /api/judge-analytics');

    // Decisions routes - download court decision full texts from reyestr.court.gov.ua
    this.app.use('/api/decisions', requireJWT as any, createDecisionsRoutes(this.services.reyestrDownloadService));
    logger.info('Decisions routes registered at /api/decisions');

    // News article routes - fetch KMU articles with AI analysis
    const newsArticleService = new NewsArticleService(this.services.db);
    this.app.use('/api/news', requireJWT as any, createNewsRoutes(newsArticleService));
    logger.info('News article routes registered at /api/news');

    // ERAU proxy - Ukrainian Bar Registry (public, no auth required)
    const erauCacheService = new ERAUCacheService(this.services.db);
    this.app.use('/api/erau', publicSearchRateLimit as any, optionalJWT as any, createERAUProxyRoutes(erauCacheService, this.services.db));
    logger.info('ERAU proxy routes registered at /api/erau');

    // Worker heartbeat (uses dualAuth so EC2 workers can auth with SECONDARY_LAYER_KEYS)
    // MUST be before the catch-all /api workflow routes
    this.app.use('/api/workers', dualAuth as any, createWorkerHeartbeatRoute());
    logger.info('Worker heartbeat routes registered at /api/workers');

    // Grounded legal substrate — the REST contract customers integrate against
    // and the shape the Finnish graph is meant to be served through. dualAuth so
    // an API key works: this surface is sold to builders, not to browser users.
    this.app.use('/api/v1/substrate', dualAuth as any, createSubstrateRoutes(this.services.db));
    logger.info('Substrate API registered at /api/v1/substrate');

    // Workflow routes - workflow sets, workflow execution, cancellation
    // IMPORTANT: Use specific prefixes, NOT '/api' — a catch-all '/api' prefix with requireJWT
    // would block API key auth for all /api/* routes (including /api/tools with dualAuth)
    this.app.use('/api/workflow-sets', requireJWT as any, createWorkflowSetRoutes(this.app_.workflowService));
    this.app.use('/api/workflows', requireJWT as any, createWorkflowRoutes(this.app_.workflowService, this.app_.workflowExecutorService));
    logger.info('Workflow routes registered at /api/workflow-sets, /api/workflows');

    // Time tracking and billing routes
    this.app.use('/api/time', requireJWT as any, createTimeEntryRoutes(this.app_.timeEntryService));
    logger.info('Time tracking routes registered at /api/time');

    this.app.use('/api/invoicing', requireJWT as any, createInvoiceRoutes(this.app_.matterInvoiceService));
    logger.info('Invoicing routes registered at /api/invoicing');

    // Usage analytics routes - aggregated API usage for authenticated user
    this.app.use('/api/usage', requireJWT as any, createUsageRoutes(this.services.db));
    logger.info('Usage analytics routes registered at /api/usage');

    // Attorney routes - search is public (optionalJWT), profile management requires JWT
    this.app.use('/api/attorneys', publicSearchRateLimit as any, optionalJWT as any, createAttorneyRoutes(this.app_.attorneyProfileService));
    logger.info('Attorney routes registered at /api/attorneys');

    // E2EE encryption key management routes - all require JWT
    this.app.use('/api/encryption', requireJWT as any, createEncryptionRoutes(this.billing.encryptionKeyService, this.services.db));
    logger.info('Encryption routes registered at /api/encryption');

    // Consultation routes - all require JWT
    // SSE endpoints use query param token (EventSource API doesn't support custom headers)
    this.app.use('/api/consultations', ((req: any, _res: any, next: any) => {
      if (!req.headers.authorization && req.query.token) {
        req.headers.authorization = `Bearer ${req.query.token}`;
      }
      next();
    }) as any, requireJWT as any, consultationRateLimit as any, createConsultationRoutes(
      this.app_.consultationService,
      this.app_.consultationPaymentService,
      this.app_.attorneyPayoutService,
      this.services.db,
      (type, delta) => {
        this.app_.metricsService.sseActiveConnections.inc({ type }, delta);
      },
      this.tools.minioService,
      this.app_.consultationE2eeService
    ));
    logger.info('Consultation routes registered at /api/consultations');

    // Video call routes (nested under consultations)
    const videoCallService = new VideoCallService(this.services.db, getConsultationMessageBus());
    this.app.use('/api/consultations/:consultationId/call', requireJWT as any, createVideoCallRoutes(videoCallService));
    logger.info('Video call routes registered at /api/consultations/:consultationId/call');

    // Admin routes - require JWT + admin privileges
    // GET /api/admin/stats/overview - Dashboard statistics
    // GET /api/admin/stats/revenue-chart - Revenue chart data
    // GET /api/admin/stats/tier-distribution - User tier distribution
    // GET /api/admin/users - List all users
    // GET /api/admin/users/:userId - Get user details
    // PUT /api/admin/users/:userId/tier - Update user tier
    // POST /api/admin/users/:userId/adjust-balance - Adjust user balance
    // PUT /api/admin/users/:userId/limits - Update user limits
    // GET /api/admin/transactions - List all transactions
    // POST /api/admin/transactions/:transactionId/refund - Refund transaction
    // GET /api/admin/analytics/cohorts - Cohort analysis
    // GET /api/admin/analytics/usage - Usage analytics
    // GET /api/admin/api-keys - List API keys
    // GET /api/admin/settings - Get system settings
    this.app.use('/api/admin', requireJWT as any, createAdminRoutes(this.services.db, this.billing.billingService, this.billing.userPreferencesService, this.billing.prometheusService, this.billing.pricingService, this.billing.subscriptionService, this.app_.configService, this.app_.auditService, this.billing.emailService));

    // ECHR HUDOC sync admin routes
    this.app.use('/api/admin', createEchrSyncRouter(this.services.echrHudocSyncService));

    // Session replay: rrweb recording + admin playback
    const sessionReplayService = new SessionReplayService(this.services.db, this.tools.minioService);
    this.app.use('/api/session-replay', requireJWT as any, createSessionReplayRoutes(sessionReplayService));
    this.app.use('/api/admin/session-replay', requireJWT as any, createAdminSessionReplayRoutes(sessionReplayService));
    logger.info('Session replay routes registered');

    // Server-side request logging middleware (correlates with session replay)
    this.app.use('/api', ((req: DualAuthRequest, res: express.Response, next: any) => {
      const sessionId = req.headers['x-session-id'] as string;
      if (sessionId && req.user?.id) {
        const start = Date.now();
        res.on('finish', () => {
          sessionReplayService.logServerEvent(sessionId, req.user!.id, 'api_call', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: Date.now() - start,
          }).catch(() => {}); // fire-and-forget
        });
      }
      next();
    }) as any);

    // Upload metrics endpoint (admin)
    this.app.get('/api/admin/upload-metrics', requireJWT as any, (async (_req: DualAuthRequest, res: express.Response) => {
      try {
        const queueMetrics = await this.app_.uploadQueueService.getMetrics();
        const processingMetrics = getUploadProcessingMetrics();
        res.json({
          queue: queueMetrics,
          processing: processingMetrics,
        });
      } catch (error: any) {
        logger.error('[Admin] Upload metrics failed', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    }) as any);

    // EDRSR vectorization status endpoint (admin)
    this.app.get('/api/admin/edrsr-vectorization-status', requireJWT as any, (async (_req: DualAuthRequest, res: express.Response) => {
      try {
        const preVectorizer = (this as any)._preVectorizer;
        if (!preVectorizer) {
          return res.json({ status: 'not_configured', message: 'Pre-vectorizer not running (VOYAGEAI_API_KEY missing or Redis unavailable)' });
        }
        const workerStatus = await preVectorizer.getStatus();

        // Also get Qdrant collection stats
        let qdrantStats = null;
        if (this.tools.edsrVectorizer) {
          qdrantStats = await this.tools.edsrVectorizer.getVectorizationStats();
        }

        res.json({ worker: workerStatus, qdrant: qdrantStats });
      } catch (error: any) {
        logger.error('[Admin] EDRSR vectorization status failed', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    }) as any);

    // Template system routes - Dynamic template classification, matching, generation, and analytics
    // POST /api/templates/classify-question - Classify question intent
    // GET /api/templates/classify-question/stats - Classification statistics
    // GET /api/templates/match - Match question against existing templates
    // POST /api/templates/match/batch - Batch match multiple questions
    // POST /api/templates/generate - Generate new template from unmatched question
    // GET /api/templates/generation/:id/status - Check generation status
    // PUT /api/templates/generation/:id/approve - Approve generated template (admin)
    // PUT /api/templates/generation/:id/reject - Reject generated template (admin)
    // GET /api/templates/list - List all templates
    // GET /api/templates/:id - Get template details
    // PUT /api/templates/:id - Update template (admin)
    // DELETE /api/templates/:id - Deprecate template (admin)
    // GET /api/templates/recommendations/for-me - Personalized recommendations
    // GET /api/templates/trending - Trending templates
    // POST /api/templates/:id/feedback - Submit feedback
    // POST /api/templates/:id/rate - Rate template
    // GET /api/templates/:id/metrics - Get template metrics
    // GET /api/templates/analytics/dashboard - Analytics dashboard
    // POST /api/templates/metrics/aggregate - Aggregate metrics (admin)
    this.app.use('/api/templates', requireJWT as any, createTemplateRoutes(this.services.db));


    // ============ KMU RSS Proxy ============
    // GET /api/proxy/kmu-rss - Proxy KMU government news RSS feed via headless browser (bypasses Radware bot protection)
    this.app.get('/api/proxy/kmu-rss', requireJWT as any, (async (_req: DualAuthRequest, res: Response) => {
      const KMU_RSS_URL = 'https://www.kmu.gov.ua/api/rss';
      const CACHE_KEY = 'kmu_rss_cache';
      const CACHE_TTL = 1800; // 30 minutes
      try {
        // Try Redis cache first
        const redis = await getRedisClient();
        if (!redis) {
          return res.status(503).json({ error: 'Redis unavailable' });
        }
        const cached = await redis.get(CACHE_KEY);
        if (cached) {
          logger.info('[KMU RSS Proxy] Serving from cache');
          res.set('Content-Type', 'application/xml; charset=utf-8');
          res.set('Cache-Control', 'public, max-age=600');
          res.set('X-Cache', 'HIT');
          return res.send(cached);
        }

        // Fetch via headless browser to bypass bot protection
        logger.info('[KMU RSS Proxy] Cache miss, fetching via headless browser');
        const { chromium } = await import('playwright');
        const browser = await chromium.launch({
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        try {
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true,
          });
          const page = await context.newPage();

          // Use waitForResponse to properly await the RSS response body before closing
          const [rssResponse] = await Promise.all([
            page.waitForResponse(resp => resp.url().includes('/api/rss') && resp.status() === 200, { timeout: 30000 }),
            page.goto(KMU_RSS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }),
          ]);

          let rawXml = '';
          try {
            rawXml = await rssResponse.text();
          } catch { /* ignore */ }

          await context.close();

          if (!rawXml || (!rawXml.includes('<rss') && !rawXml.includes('<channel>'))) {
            logger.warn('[KMU RSS Proxy] Response does not look like RSS', { bodySnippet: (rawXml || '').substring(0, 200) });
            return res.status(502).json({ error: 'KMU RSS returned non-RSS content' });
          }

          const xml = rawXml;

          // Cache in Redis
          await redis.setEx(CACHE_KEY, CACHE_TTL, xml);
          logger.info('[KMU RSS Proxy] Fetched and cached successfully');

          res.set('Content-Type', 'application/xml; charset=utf-8');
          res.set('Cache-Control', 'public, max-age=600');
          res.set('X-Cache', 'MISS');
          res.send(xml);
        } finally {
          await browser.close();
        }
      } catch (error: any) {
        logger.error('[KMU RSS Proxy] Error', { error: error.message });
        res.status(502).json({ error: 'Failed to fetch KMU RSS feed' });
      }
    }) as any);
    logger.info('KMU RSS Proxy endpoint registered at GET /api/proxy/kmu-rss');

    // AUP consent — records user acceptance of Acceptable Use Policy before file uploads
    this.app.post('/api/user/aup-consent', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const aupVersion = typeof req.body?.aup_version === 'string'
          ? req.body.aup_version.slice(0, 20)
          : '1.0';

        const ip = req.headers['cf-connecting-ip'] as string
          || req.headers['x-forwarded-for'] as string
          || req.ip
          || null;

        await this.services.db.query(
          `INSERT INTO user_aup_consents (user_id, aup_version, ip_address)
           VALUES ($1, $2, $3::inet)`,
          [userId, aupVersion, ip]
        );

        res.json({ ok: true });
      } catch (err: any) {
        logger.error('[AUP] Failed to record consent', { error: err.message });
        res.json({ ok: true });
      }
    }) as any);
    logger.info('AUP consent route registered at POST /api/user/aup-consent');

    // Access status — frontend uses this to render the beta-restricted modal proactively
    this.app.use('/api/access', requireJWT as any, createAccessRoutes(this.services.db));
    logger.info('Access status routes registered at /api/access');

    // Chat routes (plan review + AI chat with SSE streaming)
    this.app.use(
      '/api/chat',
      requireJWT as any,
      createAccessGate(this.services.db, { feature: 'chat' }) as any,
      createChatInlineRoutes({
        chatService: this.app_.chatService,
        billingService: this.billing.billingService,
        costTracker: this.billing.costTracker,
        db: this.services.db,
      })
    );
    logger.info('Chat routes registered at /api/chat');



    // MCP tool endpoints - versioned API (v1)
    // Mount at /api/v1/tools (canonical) and /api/tools (backward compat alias)
    const toolRouter = createToolExecutionRoutes({
      toolRegistry: this.tools.toolRegistry,
      db: this.services.db,
      serviceProxy: this.tools.serviceProxy,
      billingService: this.billing.billingService,
      costTracker: this.billing.costTracker,
      creditService: this.billing.creditService,
      batchDocumentTools: this.tools.batchDocumentTools,
    });
    // Applying for and deciding access to the UK judgment corpus. The gate that
    // uses these records lives in services/uk-judgment-access.ts.
    this.app.use('/api/uk-judgments', createUKJudgmentAccessRoutes({
      db: this.services.db,
      dualAuth: dualAuth as any,
    }));

    this.app.use('/api/v1/tools', toolRouter);
    this.app.use('/api/tools', toolRouter);
    logger.info('Tool routes registered at /api/v1/tools and /api/tools (backward compat)');



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
      await this.services.db.connect();
      await this.services.embeddingService.initialize();
      await this.tools.documentParser.initialize();

      // Initialize Redis-backed consultation message bus (falls back to in-memory)
      const { createConsultationMessageBus, getConsultationMessageBus } = await import('./services/consultation-message-bus.js');
      await createConsultationMessageBus();

      // Wire message bus metrics
      const bus = getConsultationMessageBus();
      if (bus.setMetricsCallback) {
        bus.setMetricsCallback((channel) => {
          this.app_.metricsService.consultationBusMessages.inc({ channel });
        });
      }

      // Initialize Redis cache for services (optional)
      const redis = await getRedisClient();
      if (redis) {
        const cache = new CacheAdapter(redis);
        this.services.legislationTools.setRedisClient(cache);
        this.services.zoAdapter.setCachePort(cache);
        this.services.zoPracticeAdapter.setCachePort(cache);
        this.services.zoSessionsAdapter.setCachePort(cache);
        this.services.zoLegalActsAdapter.setCachePort(cache);
        this.services.zoECHRAdapter.setCachePort(cache);
        this.services.shepardizationService.setCachePort(cache);
        this.app_.chatSearchCache.setCachePort(cache);
        this.app_.evidenceService.setCachePort(cache);
        setAuthCache(cache);
        setOidcCache(cache);
        setRateLimitCache(cache);
        setUploadRateLimitCache(cache);
        // EDRSR cache service (fulltext, metadata, FTS results)
        const { EdsrCacheService } = await import('./services/edrsr-cache-service.js');
        const edsrCache = new EdsrCacheService(cache);
        edsrCache.setMetricsCallback((operation, result) => {
          this.app_.metricsService.edsrCacheOps.inc({ operation, result });
        });
        if (this.tools.edsrFtsService) {
          this.tools.edsrFtsService.setEdsrCache(edsrCache);
        }

        // EDRSR pre-vectorization disabled — vectorization happens on-demand only
        // (background worker was too expensive for 110M+ documents)

        logger.info('Redis connected - caching enabled for all services');
      } else {
        logger.info('Redis not available - services will work without caching');
      }

      // Cleanup expired upload sessions every hour
      setInterval(() => {
        this.tools.uploadService.cleanupExpired().catch((err) => {
          logger.error('Upload cleanup failed', { error: err.message });
        });
      }, 60 * 60 * 1000);

      // Cleanup stale pending/uploading sessions every 5 minutes
      setInterval(() => {
        this.tools.uploadService.cleanupStale(30).catch((err) => {
          logger.error('Upload stale cleanup failed', { error: err.message });
        });
      }, 5 * 60 * 1000);
      // Run once on startup too
      // Upload maintenance (stale cleanup + recovery loop) — scheduler instance only, so N
      // web replicas don't each run recovery/cleanup (LEXAI-1802).
      if (process.env.RUN_SCHEDULER !== 'false') {
        this.tools.uploadService.cleanupStale(30).catch((err) => {
          logger.error('Upload stale cleanup on startup failed', { error: err.message });
        });

        // Start upload recovery service (30s delay, then every 5 min)
        this.app_.uploadRecoveryService.start();
        logger.info('Upload recovery service started');
      }

      (this as any)._initialized = true;
      logger.info('HTTP MCP Server services initialized');
    } catch (error) {
      logger.error('Failed to initialize server:', error);
      throw error;
    }
  }

  async start() {
    const port = parseInt(process.env.HTTP_PORT || '3000', 10);
    const host = process.env.HTTP_HOST || '0.0.0.0';

    const httpServer = createServer(this.app);

    // Attach admin terminal WebSocket
    attachTerminalWebSocket(httpServer, this.services.db);

    // Attach video call signaling WebSocket
    const messageBus = getConsultationMessageBus();
    const videoCallSvc = new VideoCallService(this.services.db, messageBus);
    const sttSvc = new SttService(videoCallSvc);
    attachVideoCallSignaling(httpServer, this.services.db, videoCallSvc, messageBus, sttSvc);

    // Listen BEFORE initialize so healthcheck responds during slow startup
    await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
    logger.info(`HTTP server listening on http://${host}:${port} (initializing services...)`);

    this.initialize()
      .then(() => logger.info(`HTTP MCP Server fully initialized on http://${host}:${port}`))
      .catch((error) => logger.error('Failed to initialize services:', error));
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});

// Start server
const server = new HTTPMCPServer();
server.start().catch((error) => {
  logger.error('Failed to start HTTP server:', error);
  process.exit(1);
});
