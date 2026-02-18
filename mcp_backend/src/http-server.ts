import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './utils/logger.js';
import { dualAuth, requireJWT, optionalJWT, initializeDualAuth, initializeWebAuthn, AuthenticatedRequest as DualAuthRequest } from './middleware/dual-auth.js';
import { configurePassport } from './config/passport.js';
import authRouter from './routes/auth.js';
import { createBackendCoreServices, BackendCoreServices } from './factories/core-services.js';
import { DocumentAnalysisTools } from './api/document-analysis-tools.js';
import { BatchDocumentTools } from './api/batch-document-tools.js';
import { DocumentParser } from './services/document-parser.js';
import { createRestAPIRouter } from './routes/rest-api.js';
import { MetadataExtractor } from './services/metadata-extractor.js';
import path from 'path';
// import { createEULARouter } from './routes/eula.js'; // REMOVED: EULA not needed
import { CostTracker } from './services/cost-tracker.js';
import { BillingService } from './services/billing-service.js';
import { StripeService } from './services/stripe-service.js';
import { FondyService } from './services/fondy-service.js';
import { MetaMaskService } from './services/metamask-service.js';
import { BinancePayService } from './services/binance-pay-service.js';
import { EmailService } from './services/email-service.js';
import { MockStripeService } from './services/__mocks__/stripe-service-mock.js';
import { MockFondyService } from './services/__mocks__/fondy-service-mock.js';
import { MockMetaMaskService } from './services/__mocks__/metamask-service-mock.js';
import { MockBinancePayService } from './services/__mocks__/binance-pay-service-mock.js';
import { initializeCryptoTagMiddleware } from './middleware/crypto-tag-required.js';
import { createBalanceCheckMiddleware } from './middleware/balance-check.js';
import { InvoiceService } from './services/invoice-service.js';
import { createPaymentRouter, createWebhookRouter } from './routes/payment-routes.js';
import { createBillingRoutes } from './routes/billing-routes.js';
import { createAdminRoutes } from './routes/admin-routes.js';
import { createTeamRoutes } from './routes/team-routes.js';
import { createTeamService } from './services/team-service.js';
import { createTestEmailRoute } from './routes/test-email-route.js';
import { requestContext } from './utils/openai-client.js';
import { getOpenAIManager } from './utils/openai-client.js';
import passport from 'passport';
import { MCPSSEServer } from './api/mcp-sse-server.js';
import { ApiKeyService } from './services/api-key-service.js';
import { CreditService } from './services/credit-service.js';
import { createApiKeyRouter } from './routes/api-key-routes.js';
import { getRedisClient } from './utils/redis-client.js';
import { createTemplateRoutes } from './routes/template-routes.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createOAuthRouter } from './routes/oauth-routes.js';
import { OAuthService } from './services/oauth-service.js';
import { createHybridAuthMiddleware } from './middleware/oauth-auth.js';
import { mcpDiscoveryRateLimit, healthCheckRateLimit, webhookRateLimit, chatRateLimit } from './middleware/rate-limit.js';
import { ToolRegistry } from './api/tool-registry.js';
import { BusinessRegistryTools } from './api/tools/business-registry-tools.js';
import { CourtDecisionTools } from './api/tools/court-decision-tools.js';
import { ProceduralTools } from './api/tools/procedural-tools.js';
import { LegalAdviceTools } from './api/tools/legal-advice-tools.js';
import { DueDiligenceTools } from './api/due-diligence-tools.js';
import { DueDiligenceService } from './services/due-diligence-service.js';
import { CourtSessionTools } from './api/tools/court-session-tools.js';
import { LegalActsTools } from './api/tools/legal-acts-tools.js';
import { ECHRPracticeTools } from './api/tools/echr-practice-tools.js';
import { ServiceProxy } from './services/service-proxy.js';
import { ServiceType } from './types/gateway.js';
import { UploadService } from './services/upload-service.js';
import { MinioService } from './services/minio-service.js';
import { createUploadRouter } from './routes/upload-routes.js';
import { VaultTools } from './api/vault-tools.js';
import { ConversationService } from './services/conversation-service.js';
import { GdprService } from './services/gdpr-service.js';
import { createConversationRouter } from './routes/conversation-routes.js';
import { createGdprRouter } from './routes/gdpr-routes.js';
import { AuditService } from './services/audit-service.js';
import { MatterService } from './services/matter-service.js';
import { ConflictCheckService } from './services/conflict-check-service.js';
import { LegalHoldService } from './services/legal-hold-service.js';
import { initializeMatterAccess } from './middleware/matter-access.js';
import { createMatterRoutes } from './routes/matter-routes.js';
import { UploadRecoveryService } from './services/upload-recovery-service.js';
import { UploadQueueService } from './services/upload-queue-service.js';
import { getUploadProcessingMetrics } from './routes/upload-routes.js';
import { MetricsService } from './services/metrics-service.js';
import { TimeEntryService } from './services/time-entry-service.js';
import { MatterInvoiceService } from './services/matter-invoice-service.js';
import { createTimeEntryRoutes } from './routes/time-entry-routes.js';
import { createInvoiceRoutes } from './routes/invoice-routes.js';
import { ChatService, ChatEvent } from './services/chat-service.js';
import { getLLMManager } from './utils/llm-client-manager.js';
import { ChatSearchCacheService } from './services/chat-search-cache-service.js';
import { PricingService } from './services/pricing-service.js';
import { SubscriptionService } from './services/subscription-service.js';

dotenv.config();

class HTTPMCPServer {
  private app: express.Application;
  private services: BackendCoreServices;
  private documentParser: DocumentParser;
  private documentAnalysisTools: DocumentAnalysisTools;
  private batchDocumentTools: BatchDocumentTools;
  private costTracker: CostTracker;
  private billingService: BillingService;
  private stripeService: StripeService | MockStripeService;
  private fondyService: FondyService | MockFondyService;
  private metamaskService: MetaMaskService | MockMetaMaskService;
  private binancePayService: BinancePayService | MockBinancePayService;
  private emailService: EmailService;
  private invoiceService: InvoiceService;
  private mcpSSEServer: MCPSSEServer;
  private apiKeyService: ApiKeyService;
  private creditService: CreditService;
  private oauthService: OAuthService;
  private toolRegistry: ToolRegistry;
  private serviceProxy: ServiceProxy;
  private uploadService: UploadService;
  private minioService: MinioService;
  private vaultTools: VaultTools;
  private conversationService: ConversationService;
  private gdprService: GdprService;
  private auditService: AuditService;
  private matterService: MatterService;
  private conflictCheckService: ConflictCheckService;
  private legalHoldService: LegalHoldService;
  private uploadRecoveryService: UploadRecoveryService;
  private uploadQueueService: UploadQueueService;
  private metricsService: MetricsService;
  private timeEntryService: TimeEntryService;
  private matterInvoiceService: MatterInvoiceService;
  private chatService: ChatService;

  constructor() {
    this.app = express();

    // Initialize core services via factory
    this.services = createBackendCoreServices();

    // Initialize document parser with Vision API credentials
    // Use env var if set (for Docker), otherwise fallback to local path
    const visionKeyPath = process.env.VISION_CREDENTIALS_PATH ||
                         process.env.GOOGLE_APPLICATION_CREDENTIALS ||
                         path.resolve(process.cwd(), '../vision-ocr-credentials.json');
    this.documentParser = new DocumentParser(visionKeyPath);
    this.documentAnalysisTools = new DocumentAnalysisTools(
      this.documentParser,
      this.services.sectionizer,
      this.services.patternStore,
      this.services.citationValidator,
      this.services.embeddingService,
      this.services.documentService
    );

    // Initialize batch document tools
    this.batchDocumentTools = new BatchDocumentTools(
      this.documentParser,
      this.documentAnalysisTools
    );
    logger.info('Batch document processing tools initialized');

    // Initialize cost tracker and billing service
    this.costTracker = new CostTracker(this.services.db);
    this.billingService = new BillingService(this.services.db);
    this.invoiceService = new InvoiceService();
    this.costTracker.setBillingService(this.billingService);

    // Initialize Phase 2 billing services (API keys & credits)
    this.apiKeyService = new ApiKeyService(this.services.db.getPool());
    this.creditService = new CreditService(this.services.db.getPool());
    logger.info('Phase 2 billing services initialized (API keys & credits)');

    // Initialize OAuth 2.0 service for ChatGPT integration
    this.oauthService = new OAuthService(this.services.db);
    logger.info('OAuth 2.0 service initialized');

    // Initialize Unified Gateway components
    this.toolRegistry = new ToolRegistry();
    this.serviceProxy = new ServiceProxy(this.costTracker);
    logger.info('Unified Gateway initialized (Tool Registry + Service Proxy)');

    // Register all tool handlers with the central registry
    this.toolRegistry.registerHandler(this.services.legislationTools);
    this.toolRegistry.registerHandler(this.documentAnalysisTools);
    this.toolRegistry.registerHandler(this.batchDocumentTools);
    this.toolRegistry.registerHandler(new BusinessRegistryTools());
    const ddService = new DueDiligenceService(
      this.services.sectionizer,
      this.services.patternStore,
      this.services.citationValidator,
      this.services.documentService
    );
    this.toolRegistry.registerHandler(new DueDiligenceTools(ddService));
    this.toolRegistry.registerHandler(this.services.mcpAPI);
    this.toolRegistry.registerHandler(new CourtDecisionTools(
      this.services.zoAdapter,
      this.services.zoPracticeAdapter,
      this.services.sectionizer,
      this.services.embeddingService,
      this.services.patternStore
    ));
    this.toolRegistry.registerHandler(new ProceduralTools(
      this.services.zoAdapter,
      this.services.zoPracticeAdapter,
      this.services.sectionizer,
      this.services.embeddingService,
      this.services.patternStore
    ));
    this.toolRegistry.registerHandler(new LegalAdviceTools(
      this.services.queryPlanner,
      this.services.zoAdapter,
      this.services.zoPracticeAdapter,
      this.services.sectionizer,
      this.services.embeddingService,
      this.services.patternStore,
      this.services.citationValidator
    ));
    this.toolRegistry.registerHandler(new CourtSessionTools(
      this.services.zoSessionsAdapter,
      this.services.db
    ));
    this.toolRegistry.registerHandler(new LegalActsTools(this.services.zoLegalActsAdapter));
    this.toolRegistry.registerHandler(new ECHRPracticeTools(this.services.zoECHRAdapter));
    logger.info('Core tool handlers registered with ToolRegistry');

    // Initialize upload and storage services
    this.uploadService = new UploadService(this.services.db.getPool());
    this.minioService = new MinioService();
    const metadataExtractor = new MetadataExtractor();
    this.vaultTools = new VaultTools(
      this.documentParser,
      this.services.sectionizer,
      this.services.patternStore,
      this.services.embeddingService,
      this.services.documentService,
      metadataExtractor
    );
    this.toolRegistry.registerHandler(this.vaultTools);
    this.conversationService = new ConversationService(this.services.db);
    this.gdprService = new GdprService(this.services.db, this.minioService, this.services.embeddingService);
    logger.info('Upload and MinIO services initialized');
    logger.info('Conversation and GDPR services initialized');

    // Initialize Client-Matter segregation services
    this.auditService = new AuditService(this.services.db);
    this.matterService = new MatterService(this.services.db, this.auditService);
    this.conflictCheckService = new ConflictCheckService(this.services.db, this.auditService);
    this.legalHoldService = new LegalHoldService(this.services.db, this.auditService);
    initializeMatterAccess(this.matterService);
    logger.info('Client-Matter segregation and legal hold services initialized');

    // Initialize Time Tracking and Billing services
    this.timeEntryService = new TimeEntryService(this.services.db, this.auditService);
    this.matterInvoiceService = new MatterInvoiceService(this.services.db, this.auditService);
    logger.info('Time tracking and billing services initialized');

    // Initialize ChatService (agentic LLM loop) with search cache
    const chatSearchCache = new ChatSearchCacheService(
      this.services.zoAdapter,
      this.services.documentService
    );
    this.chatService = new ChatService(
      this.toolRegistry,
      this.services.queryPlanner,
      this.costTracker,
      chatSearchCache,
      this.conversationService,
      this.services.shepardizationService,
      this.services.embeddingService
    );
    logger.info('ChatService initialized with search cache, conversation persistence, shepardization, and embedding');

    // Initialize BullMQ upload queue service
    this.uploadQueueService = new UploadQueueService(
      this.uploadService,
      this.minioService,
      this.vaultTools,
      this.services.db.getPool()
    );
    this.uploadQueueService.startWorker();
    logger.info('BullMQ upload queue service initialized');

    // Initialize Prometheus metrics service
    this.metricsService = new MetricsService();

    // Bind PG pool metrics collector
    this.services.db.setMetricsCollector((stats) => this.metricsService.updatePgPool(stats));

    // Bind upload queue metrics collector (every 10s)
    this.uploadQueueService.setMetricsCollector((metrics) => this.metricsService.updateUploadQueue(metrics));

    // Bind per-job processing duration to Prometheus histogram
    this.uploadQueueService.setProcessingDurationCallback((durationSeconds, status) => {
      this.metricsService.uploadProcessingDuration.observe({ status }, durationSeconds);
    });

    // Wire cost tracker to Prometheus counter
    this.costTracker.setMetricsCallback((toolName, costUsd) => {
      this.metricsService.costTrackingTotalUsd.inc({ tool_name: toolName }, costUsd);
    });

    // Bind CPU adaptive concurrency metrics collector
    const cpuAdaptiveManager = this.uploadQueueService.getCpuAdaptiveManager();
    if (cpuAdaptiveManager) {
      cpuAdaptiveManager.setMetricsCallback((metrics) => this.metricsService.updateCpuAdaptive(metrics));
    }

    // Bind external API metrics collectors
    const externalApiMetricsCallback = (service: string, status: string, durationSec: number) => {
      this.metricsService.externalApiCallsTotal.inc({ service, status });
      if (durationSec > 0) {
        this.metricsService.externalApiDuration.observe({ service }, durationSec);
      }
    };
    this.services.zoAdapter.setExternalApiMetrics(externalApiMetricsCallback);
    this.services.zoPracticeAdapter.setExternalApiMetrics(externalApiMetricsCallback);
    this.services.zoSessionsAdapter.setExternalApiMetrics(externalApiMetricsCallback);
    this.serviceProxy.setExternalApiMetrics(externalApiMetricsCallback);
    getLLMManager().setExternalApiMetrics(externalApiMetricsCallback);
    this.services.legislationTools.getLegislationService().getAdapter().setExternalApiMetrics(externalApiMetricsCallback);

    logger.info('Prometheus metrics service initialized');

    // Initialize upload recovery service (uses BullMQ for re-enqueuing)
    this.uploadRecoveryService = new UploadRecoveryService(
      this.uploadService,
      this.minioService,
      this.vaultTools,
      this.services.db.getPool()
    );
    this.uploadRecoveryService.setQueueService(this.uploadQueueService);

    // Initialize payment services
    this.emailService = new EmailService();
    this.emailService.setPreferenceFetcher((userId: string) =>
      this.billingService.getEmailPreferences(userId)
    );

    // Use mock services if MOCK_PAYMENTS=true or keys not configured
    const mockPaymentsEnabled = process.env.MOCK_PAYMENTS === 'true';
    const useMockStripe = mockPaymentsEnabled ||
                          !process.env.STRIPE_SECRET_KEY ||
                          process.env.STRIPE_SECRET_KEY.includes('mock') ||
                          process.env.STRIPE_SECRET_KEY.includes('test');
    const useMockFondy = mockPaymentsEnabled ||
                         !process.env.FONDY_SECRET_KEY ||
                         process.env.FONDY_SECRET_KEY.includes('mock') ||
                         process.env.FONDY_SECRET_KEY.includes('test');

    if (useMockStripe) {
      this.stripeService = new MockStripeService(this.billingService, this.emailService);
      logger.warn('🧪 Using MOCK Stripe service (no real payments will be processed)');
    } else {
      this.stripeService = new StripeService(this.billingService, this.emailService);
      logger.info('💳 Using REAL Stripe service');
    }

    if (useMockFondy) {
      this.fondyService = new MockFondyService(this.billingService, this.emailService);
      logger.warn('🧪 Using MOCK Fondy service (no real payments will be processed)');
    } else {
      this.fondyService = new FondyService(this.billingService, this.emailService);
      logger.info('💳 Using REAL Fondy service');
    }

    const useMockMetaMask = mockPaymentsEnabled || !process.env.CRYPTO_RECEIVING_WALLET || !process.env.ETHEREUM_RPC_URL;
    if (useMockMetaMask) {
      this.metamaskService = new MockMetaMaskService(this.billingService, this.emailService);
      logger.warn('Using MOCK MetaMask service');
    } else {
      this.metamaskService = new MetaMaskService(this.billingService, this.emailService, this.services.db);
      logger.info('Using REAL MetaMask service');
    }

    const useMockBinancePay = mockPaymentsEnabled || !process.env.BINANCE_PAY_API_KEY || !process.env.BINANCE_PAY_SECRET_KEY;
    if (useMockBinancePay) {
      this.binancePayService = new MockBinancePayService(this.billingService, this.emailService);
      logger.warn('Using MOCK Binance Pay service');
    } else {
      this.binancePayService = new BinancePayService(this.billingService, this.emailService, this.services.db);
      logger.info('Using REAL Binance Pay service');
    }

    initializeCryptoTagMiddleware(this.services.db);

    logger.info('Payment services initialized', {
      mockPayments: mockPaymentsEnabled,
      stripeMode: useMockStripe ? 'MOCK' : 'REAL',
      fondyMode: useMockFondy ? 'MOCK' : 'REAL',
      metamaskMode: useMockMetaMask ? 'MOCK' : 'REAL',
      binancePayMode: useMockBinancePay ? 'MOCK' : 'REAL',
    });

    const openaiManager = getOpenAIManager();
    openaiManager.setCostTracker(this.costTracker);
    this.services.zoAdapter.setCostTracker(this.costTracker);
    this.services.zoPracticeAdapter.setCostTracker(this.costTracker);

    // Wire cost metrics to Prometheus (callback set after metricsService init below)
    logger.info('Cost tracking and billing initialized');

    // Initialize MCP SSE Server for ChatGPT integration
    this.mcpSSEServer = new MCPSSEServer(
      this.toolRegistry,
      this.costTracker,
      this.creditService
    );
    logger.info('MCP SSE Server initialized with Phase 2 billing support');

    // Initialize authentication
    configurePassport(this.services.db);
    initializeDualAuth(this.services.db, this.apiKeyService);
    initializeWebAuthn(this.services.db);
    logger.info('Authentication configured (Google OAuth2 + dual auth + WebAuthn)');

    // Setup middleware and routes AFTER services are initialized
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    // CORS - разрешаем запросы от клиентов
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      credentials: true,
      exposedHeaders: ['X-Upload-Queue-Depth', 'X-Upload-Throttle', 'Retry-After', 'X-Total-Count'],
    }));

    // IMPORTANT: Stripe webhooks need raw body BEFORE json parsing
    // Mount webhook routes with raw body parser and rate limiting
    this.app.use(
      '/webhooks/stripe',
      webhookRateLimit as any,
      express.raw({ type: 'application/json', limit: '10mb' }),
      createWebhookRouter(this.stripeService, this.fondyService, this.binancePayService)
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

    // Liveness probe — process is alive (always 200)
    this.app.get('/health/live', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // Readiness probe — DB is accessible (200/503)
    this.app.get('/health/ready', healthCheckRateLimit as any, async (_req, res) => {
      try {
        await this.services.db.query('SELECT 1');
        res.json({ status: 'ok' });
      } catch (err: any) {
        res.status(503).json({ status: 'unavailable', error: err.message });
      }
    });

    // Full health check with dependency status (public - no auth, rate limited)
    this.app.get('/health', healthCheckRateLimit as any, async (_req, res) => {
      const checks: Record<string, { ok: boolean; error?: string }> = {};
      let degraded = false;

      // PostgreSQL
      try {
        await this.services.db.query('SELECT 1');
        checks.postgres = { ok: true };
      } catch (err: any) {
        checks.postgres = { ok: false, error: err.message };
        degraded = true;
      }

      // Redis
      try {
        const redis = await getRedisClient();
        if (redis) {
          await redis.ping();
          checks.redis = { ok: true };
        } else {
          checks.redis = { ok: false, error: 'not connected' };
          degraded = true;
        }
      } catch (err: any) {
        checks.redis = { ok: false, error: err.message };
        degraded = true;
      }

      // Qdrant
      const qdrantResult = await this.services.embeddingService.healthCheck();
      checks.qdrant = qdrantResult;
      if (!qdrantResult.ok) degraded = true;

      // MinIO
      const minioResult = await this.minioService.healthCheck();
      checks.minio = minioResult;
      if (!minioResult.ok) degraded = true;

      const status = degraded ? 'degraded' : 'ok';
      res.status(degraded ? 503 : 200).json({
        status,
        service: 'secondlayer-mcp-http',
        version: '1.0.0',
        checks,
      });
    });

    // OPTIONS handler for /sse - returns OAuth configuration
    // This allows ChatGPT to discover OAuth endpoints
    this.app.options('/sse', (req: Request, res: Response) => {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const baseUrl = process.env.PUBLIC_URL || `${proto}://${host}`;

      res.setHeader('MCP-Auth-Type', 'oauth2');
      res.setHeader('MCP-Auth-Authorization-Endpoint', `${baseUrl}/oauth/authorize`);
      res.setHeader('MCP-Auth-Token-Endpoint', `${baseUrl}/oauth/token`);
      res.setHeader('MCP-Auth-Scopes', 'mcp');
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      res.status(200).send();
    });

    // GET handler for /sse - returns OAuth configuration as JSON
    // ChatGPT may use this for discovery
    this.app.get('/sse', (req: Request, res: Response) => {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const baseUrl = process.env.PUBLIC_URL || `${proto}://${host}`;

      res.json({
        protocol: 'mcp',
        version: '1.0',
        auth: {
          type: 'oauth2',
          authorization_endpoint: `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          scopes: ['mcp'],
        },
        capabilities: {
          tools: true,
        },
      });
    });

    // OAuth 2.0 Authorization Server Metadata (RFC 8414)
    // ChatGPT checks this for OAuth discovery
    this.app.get('/sse/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const baseUrl = process.env.PUBLIC_URL || `${proto}://${host}`;

      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        revocation_endpoint: `${baseUrl}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['mcp', 'claudeai'],
        code_challenge_methods_supported: ['S256', 'plain'],
      });
    });

    // OpenID Connect Discovery (for compatibility)
    this.app.get('/sse/.well-known/openid-configuration', (req: Request, res: Response) => {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const baseUrl = process.env.PUBLIC_URL || `${proto}://${host}`;

      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        revocation_endpoint: `${baseUrl}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['mcp', 'claudeai'],
        code_challenge_methods_supported: ['S256', 'plain'],
      });
    });

    // MCP SSE endpoint for ChatGPT web integration (REQUIRED auth)
    // Endpoint: POST /sse
    // This implements the Model Context Protocol over Server-Sent Events
    // Reference: https://platform.openai.com/docs/mcp
    this.app.post('/sse', (async (req: DualAuthRequest, res: Response) => {
      try {
        // CRITICAL: Authentication is REQUIRED for usage tracking
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          logger.warn('[MCP SSE] Missing or invalid Authorization header');
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authorization header with Bearer token is required',
            code: 'MISSING_AUTH',
          });
        }

        const token = authHeader.replace('Bearer ', '');
        let userId: string | undefined;
        let clientKey: string | undefined;

        // Authenticate (JWT, OAuth, or API key)
        try {
          if (token.includes('.')) {
            // JWT token - verify and extract userId
            const jwt = await import('jsonwebtoken');
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'change-this-secret-in-production') as any;
            userId = decoded.userId;
            logger.debug('[MCP SSE] Authenticated with JWT', { userId });
          } else if (token.startsWith('mcp_token_')) {
            // OAuth 2.0 access token - verify with OAuth service
            const tokenData = await this.oauthService.verifyAccessToken(token);

            if (!tokenData) {
              logger.warn('[MCP SSE] Invalid OAuth token', {
                tokenPrefix: token.substring(0, 15) + '...',
              });
              return res.status(401).json({
                error: 'Unauthorized',
                message: 'Invalid or expired OAuth access token',
                code: 'INVALID_OAUTH_TOKEN',
              });
            }

            userId = tokenData.userId;
            clientKey = tokenData.clientId;
            logger.debug('[MCP SSE] Authenticated with OAuth token', {
              userId,
              clientId: tokenData.clientId,
              scope: tokenData.scope,
            });
          } else {
            // API key - validate and get user info
            clientKey = token;
            const keyInfo = await this.apiKeyService.validateApiKey(token);

            if (!keyInfo) {
              logger.warn('[MCP SSE] Invalid API key', {
                keyPrefix: token.substring(0, 12) + '...',
              });
              return res.status(401).json({
                error: 'Unauthorized',
                message: 'Invalid API key',
                code: 'INVALID_API_KEY',
              });
            }

            // Valid API key - check rate limits
            const rateLimit = await this.apiKeyService.checkRateLimit(token);

            if (!rateLimit.allowed) {
              logger.warn('[MCP SSE] Rate limit exceeded', {
                keyId: keyInfo.id,
                reason: rateLimit.reason,
              });
              return res.status(429).json({
                error: 'Rate limit exceeded',
                code: 'RATE_LIMIT_EXCEEDED',
                reason: rateLimit.reason,
                requestsToday: rateLimit.requestsToday,
                rateLimitPerDay: rateLimit.rateLimitPerDay,
              });
            }

            // Get userId from API key
            userId = keyInfo.userId;
            logger.debug('[MCP SSE] Authenticated with API key', {
              userId,
              keyId: keyInfo.id,
              userEmail: keyInfo.userEmail,
            });

            // Update API key usage (async, don't wait)
            this.apiKeyService.updateUsage(token).catch((err) => {
              logger.error('[MCP SSE] Failed to update API key usage', { error: err.message });
            });
          }
        } catch (error) {
          // Auth failed - return 401
          logger.warn('[MCP SSE] Authentication failed', { error: (error as Error).message });
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authentication failed: ' + (error as Error).message,
            code: 'AUTH_FAILED',
          });
        }

        // Authentication successful - set SSE headers and handle connection
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        // Pass userId and clientKey to SSE handler
        await this.mcpSSEServer.handleSSEConnection(req, res, userId, clientKey);
      } catch (error: any) {
        logger.error('[MCP SSE] Connection error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'MCP SSE connection failed',
            message: error.message,
          });
        }
      }
    }) as any);

    // Standard MCP SSE endpoint for MCP clients (Claude Desktop, Jan chat, etc.)
    // Endpoint: ALL /v1/sse (handles both GET for SSE stream and POST for client messages)
    // This implements the standard Model Context Protocol over SSE Transport
    // Reference: https://spec.modelcontextprotocol.io/specification/transports/#server-sent-events
    this.app.all('/v1/sse', (async (req: DualAuthRequest, res: Response) => {
      try {
        logger.info('[MCP v1/sse] New standard MCP SSE connection');

        // REQUIRED authentication for usage tracking
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          logger.warn('[MCP v1/sse] Missing or invalid Authorization header');
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authorization header with Bearer token is required',
            code: 'MISSING_AUTH',
          });
        }

        const token = authHeader.replace('Bearer ', '');
        let userId: string | undefined;
        let clientKey: string | undefined;

        // Authenticate (JWT or API key)
        try {
          if (token.includes('.')) {
            // JWT token
            const jwt = await import('jsonwebtoken');
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'change-this-secret-in-production') as any;
            userId = decoded.userId;
            logger.debug('[MCP v1/sse] Authenticated with JWT', { userId });
          } else {
            // API key
            clientKey = token;
            const keyInfo = await this.apiKeyService.validateApiKey(token);

            if (!keyInfo) {
              logger.warn('[MCP v1/sse] Invalid API key', {
                keyPrefix: token.substring(0, 12) + '...',
              });
              return res.status(401).json({
                error: 'Unauthorized',
                message: 'Invalid API key',
                code: 'INVALID_API_KEY',
              });
            }

            // Check rate limits
            const rateLimit = await this.apiKeyService.checkRateLimit(token);

            if (!rateLimit.allowed) {
              logger.warn('[MCP v1/sse] Rate limit exceeded', {
                keyId: keyInfo.id,
                reason: rateLimit.reason,
              });
              return res.status(429).json({
                error: 'Rate limit exceeded',
                code: 'RATE_LIMIT_EXCEEDED',
                reason: rateLimit.reason,
              });
            }

            userId = keyInfo.userId;
            logger.debug('[MCP v1/sse] Authenticated with API key', {
              userId,
              keyId: keyInfo.id,
            });

            // Update API key usage
            this.apiKeyService.updateUsage(token).catch((err) => {
              logger.error('[MCP v1/sse] Failed to update API key usage', { error: err.message });
            });
          }
        } catch (error) {
          // Auth failed - return 401
          logger.warn('[MCP v1/sse] Authentication failed', { error: (error as Error).message });
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authentication failed: ' + (error as Error).message,
            code: 'AUTH_FAILED',
          });
        }

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

        // Setup tools/list handler
        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
          return {
            tools: this.toolRegistry.getLocalToolDefinitions(),
          };
        });

        // Setup tools/call handler with billing integration
        mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
          const toolName = request.params.name;
          const args = request.params.arguments || {};
          const requestId = `mcp-v1-${uuidv4()}`;
          const startTime = Date.now();

          try {
            logger.info('[MCP v1/sse] Tool call', {
              tool: toolName,
              userId: userId || 'anonymous',
            });

            // Phase 2 Billing: Check credits BEFORE execution
            if (userId && this.creditService) {
              const creditsRequired = await this.creditService.calculateCreditsForTool(toolName, userId);

              if (creditsRequired > 0) {
                const balance = await this.creditService.checkBalance(userId, creditsRequired);

                if (!balance.hasCredits) {
                  logger.warn('[MCP v1/sse] Insufficient credits', {
                    userId,
                    tool: toolName,
                    creditsRequired,
                  });

                  return {
                    content: [
                      {
                        type: 'text',
                        text: `Error: Insufficient credits. Required: ${creditsRequired}, Current balance: ${balance.currentBalance}`,
                      },
                    ],
                    isError: true,
                  };
                }
              }
            }

            // Create cost tracking record
            await this.costTracker.createTrackingRecord({
              requestId,
              toolName,
              clientKey,
              userId,
              userQuery: String(args.query || JSON.stringify(args)),
              queryParams: args,
            });

            // Execute tool in request context
            const result = await requestContext.run(
              { requestId, task: toolName },
              async () => {
                // Route to appropriate tool handler via centralized registry
                // Special case: list_documents needs userId injection
                const toolArgs = toolName === 'list_documents' ? { ...args, userId } : args;
                const registryResult = await this.toolRegistry.executeTool(toolName, toolArgs);
                if (registryResult) {
                  return registryResult;
                }
                throw new Error(`Unknown tool: ${toolName}`);
              }
            );

            // Complete cost tracking
            const executionTime = Date.now() - startTime;
            await this.costTracker.completeTrackingRecord({
              requestId,
              executionTimeMs: executionTime,
              status: 'completed',
            });

            // Phase 2 Billing: Deduct credits after successful execution
            if (userId && this.creditService) {
              const creditsRequired = await this.creditService.calculateCreditsForTool(toolName, userId);

              if (creditsRequired > 0) {
                const deduction = await this.creditService.deductCredits(
                  userId,
                  creditsRequired,
                  toolName,
                  requestId,
                  `Tool execution: ${toolName}`
                );

                if (deduction.success) {
                  logger.info('[MCP v1/sse] Credits deducted', {
                    userId,
                    tool: toolName,
                    creditsDeducted: creditsRequired,
                    newBalance: deduction.newBalance,
                  });
                }
              }
            }

            // Return result in MCP format
            return {
              content: result.content || [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };

          } catch (error: any) {
            logger.error('[MCP v1/sse] Tool execution error', {
              tool: toolName,
              error: error.message,
            });

            // Record failure
            const executionTime = Date.now() - startTime;
            await this.costTracker.completeTrackingRecord({
              requestId,
              executionTimeMs: executionTime,
              status: 'failed',
              errorMessage: error.message,
            });

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

        logger.info('[MCP v1/sse] Connection established');

        // Handle client disconnect
        req.on('close', () => {
          logger.info('[MCP v1/sse] Client disconnected');
          mcpServer.close();
        });

      } catch (error: any) {
        logger.error('[MCP v1/sse] Connection error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Failed to establish MCP SSE connection',
            message: error.message,
          });
        }
      }
    }) as any);

    // MCP discovery endpoint (public - lists available tools, rate limited)
    // GET /mcp - Returns MCP server info and capabilities
    this.app.get('/mcp', mcpDiscoveryRateLimit as any, (_req: Request, res: Response) => {
      const tools = this.mcpSSEServer.getAllTools();
      res.json({
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'SecondLayer Legal MCP Server',
          version: '1.0.0',
          description: 'Ukrainian legal research and document analysis platform',
        },
        capabilities: {
          tools: {
            count: tools.length,
            listChanged: false,
          },
          prompts: {},
          resources: {},
        },
        endpoints: {
          sse: '/sse',
          'sse-standard': '/v1/sse',
          http: '/api/tools',
        },
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
        })),
      });
    });

    // Authentication routes (public - OAuth endpoints, optional JWT for /auth/me etc.)
    this.app.use('/auth', optionalJWT as any, authRouter);

    // Redirect /authorize to /oauth/authorize (for Claude.ai compatibility)
    this.app.get('/authorize', (req: Request, res: Response) => {
      const queryString = new URLSearchParams(req.query as any).toString();
      res.redirect(301, `/oauth/authorize?${queryString}`);
    });

    this.app.post('/authorize', (req: Request, res: Response) => {
      res.redirect(307, '/oauth/authorize');
    });

    // Redirect /token to /oauth/token (for Claude.ai compatibility)
    this.app.post('/token', (req: Request, res: Response) => {
      res.redirect(307, '/oauth/token');
    });

    // Root-level .well-known endpoints for OAuth discovery (Claude.ai compatibility)
    this.app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const baseUrl = process.env.PUBLIC_URL || `${proto}://${host}`;
      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        revocation_endpoint: `${baseUrl}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['mcp', 'claudeai'],
        code_challenge_methods_supported: ['S256', 'plain'],
      });
    });

    this.app.get('/.well-known/openid-configuration', (req: Request, res: Response) => {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const baseUrl = process.env.PUBLIC_URL || `${proto}://${host}`;
      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        revocation_endpoint: `${baseUrl}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['mcp', 'claudeai'],
        code_challenge_methods_supported: ['S256', 'plain'],
      });
    });

    // OAuth 2.0 routes for ChatGPT integration (public)
    this.app.use('/oauth', createOAuthRouter(this.services.db));
    logger.info('OAuth 2.0 routes registered at /oauth');

    // Document folders endpoint - must come before /api/documents generic REST route
    this.app.get('/api/documents/folders', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const prefix = (req.query.prefix as string) || '';
        const result = await this.vaultTools.listFolders({ prefix, userId });
        res.json(result);
      } catch (error: any) {
        logger.error('Failed to list folders', { error: error.message });
        res.status(500).json({ error: 'Failed to list folders', message: error.message });
      }
    }) as any);

    // REST API for admin panel (CRUD operations) - require JWT (user login)
    this.app.use('/api/documents', requireJWT as any, createRestAPIRouter(this.services.db));
    this.app.use('/api/patterns', requireJWT as any, createRestAPIRouter(this.services.db));
    this.app.use('/api/queries', requireJWT as any, createRestAPIRouter(this.services.db));

    // User profile endpoint - require JWT
    this.app.use('/api/auth', requireJWT as any, authRouter);

    // Phase 2 Billing: API key management - require JWT (user login)
    this.app.use('/api/keys', requireJWT as any, createApiKeyRouter(this.services.db.getPool()));
    logger.info('API key management routes registered at /api/keys');

    // EULA endpoints - REMOVED: not needed
    // this.app.use('/api/eula', createEULARouter(this.services.db.getPool()));

    // Billing endpoints - require JWT (user login)
    // GET /api/billing/balance - Get current balance and limits
    this.app.get('/api/billing/balance', requireJWT as any, (async (req: DualAuthRequest, res: Response): Promise<any> => {
      try {
        const userId = req.user!.id;
        const summary = await this.billingService.getBillingSummary(userId);

        if (!summary) {
          return res.status(404).json({
            error: 'Billing account not found',
          });
        }

        res.json({
          balance_usd: summary.balance_usd,
          balance_uah: summary.balance_uah,
          total_spent_usd: summary.total_spent_usd,
          total_requests: summary.total_requests,
          daily_limit_usd: summary.daily_limit_usd,
          monthly_limit_usd: summary.monthly_limit_usd,
          today_spending_usd: summary.today_spent_usd,
          monthly_spending_usd: summary.month_spent_usd,
          last_request_at: summary.last_request_at,
          is_active: summary.is_active,
          pricing_tier: summary.pricing_tier,
        });
      } catch (error: any) {
        logger.error('Failed to get billing balance', { error: error.message });
        res.status(500).json({
          error: 'Failed to get billing balance',
          message: error.message,
        });
      }
    }) as any);

    // GET /api/billing/history - Get transaction history
    this.app.get('/api/billing/history', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;
        const type = req.query.type as string;

        const transactions = await this.billingService.getTransactionHistory(userId, {
          limit,
          offset,
          type,
        });

        res.json({
          success: true,
          transactions,
          pagination: {
            limit,
            offset,
            count: transactions.length,
          },
        });
      } catch (error: any) {
        logger.error('Failed to get billing history', { error: error.message });
        res.status(500).json({
          error: 'Failed to get billing history',
          message: error.message,
        });
      }
    }) as any);

    // POST /api/billing/topup - Top up balance (admin or payment integration)
    this.app.post('/api/billing/topup', requireJWT as any, (async (req: DualAuthRequest, res: Response): Promise<any> => {
      try {
        const userId = req.user!.id;
        const { amount_usd, amount_uah, description, payment_provider, payment_id } = req.body;

        if (!amount_usd || amount_usd <= 0) {
          return res.status(400).json({
            error: 'Invalid amount',
            message: 'amount_usd must be positive',
          });
        }

        const transaction = await this.billingService.topUpBalance({
          userId,
          amountUsd: amount_usd,
          amountUah: amount_uah || 0,
          description: description || `Top up $${amount_usd}`,
          paymentProvider: payment_provider,
          paymentId: payment_id,
        });

        // Generate invoice number for the transaction
        const invoiceNumber = this.invoiceService.generateInvoiceNumber(transaction.id);
        await this.billingService.setTransactionInvoiceNumber(transaction.id, invoiceNumber);

        res.json({
          success: true,
          message: 'Balance topped up successfully',
          transaction: { ...transaction, invoice_number: invoiceNumber },
        });
      } catch (error: any) {
        logger.error('Failed to top up balance', { error: error.message });
        res.status(500).json({
          error: 'Failed to top up balance',
          message: error.message,
        });
      }
    }) as any);

    // GET /api/billing/settings - Get billing settings
    this.app.get('/api/billing/settings', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const summary = await this.billingService.getBillingSummary(userId);
        const emailPrefs = await this.billingService.getEmailPreferences(userId);

        res.json({
          daily_limit_usd: summary?.daily_limit_usd ?? 50,
          monthly_limit_usd: summary?.monthly_limit_usd ?? 1000,
          email_notifications: emailPrefs?.email_notifications ?? true,
          notify_low_balance: emailPrefs?.notify_low_balance ?? true,
          notify_payment_success: emailPrefs?.notify_payment_success ?? true,
          notify_payment_failure: emailPrefs?.notify_payment_failure ?? false,
          notify_monthly_report: emailPrefs?.notify_monthly_report ?? true,
          low_balance_threshold_usd: emailPrefs?.low_balance_threshold_usd ?? 20,
        });
      } catch (error: any) {
        logger.error('Failed to get billing settings', { error: error.message });
        res.status(500).json({ error: 'Failed to get billing settings' });
      }
    }) as any);

    // GET /api/billing/statistics - Get billing statistics
    this.app.get('/api/billing/statistics', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const period = (req.query.period as string) || '30d';

        // Query cost_tracking for aggregated stats
        let intervalSql = '30 days';
        if (period === '7d') intervalSql = '7 days';
        else if (period === '90d') intervalSql = '90 days';
        else if (period === 'year') intervalSql = '365 days';

        const statsQuery = `
          SELECT
            COUNT(*) as total_requests,
            COALESCE(SUM(total_cost_usd), 0) as total_cost,
            COALESCE(SUM(openai_prompt_tokens + openai_completion_tokens), 0) as total_tokens,
            COALESCE(AVG(total_cost_usd), 0) as avg_cost_per_request
          FROM cost_tracking
          WHERE user_id = $1
            AND created_at >= NOW() - INTERVAL '${intervalSql}'
        `;
        const statsResult = await this.services.db.query(statsQuery, [userId]);
        const stats = statsResult.rows[0] || {};

        const dailyQuery = `
          SELECT
            TO_CHAR(created_at::date, 'Mon DD') as date,
            COUNT(*) as requests,
            COALESCE(SUM(total_cost_usd), 0) as cost
          FROM cost_tracking
          WHERE user_id = $1
            AND created_at >= NOW() - INTERVAL '${intervalSql}'
          GROUP BY created_at::date
          ORDER BY created_at::date
        `;
        const dailyResult = await this.services.db.query(dailyQuery, [userId]);

        const toolsQuery = `
          SELECT
            tool_name as name,
            COUNT(*) as count,
            COALESCE(SUM(total_cost_usd), 0) as cost
          FROM cost_tracking
          WHERE user_id = $1
            AND created_at >= NOW() - INTERVAL '${intervalSql}'
            AND tool_name IS NOT NULL
          GROUP BY tool_name
          ORDER BY count DESC
          LIMIT 10
        `;
        const toolsResult = await this.services.db.query(toolsQuery, [userId]);

        // Cost breakdown by tool
        const costByServiceQuery = `
          SELECT
            tool_name as name,
            COALESCE(SUM(total_cost_usd), 0) as value
          FROM cost_tracking
          WHERE user_id = $1
            AND created_at >= NOW() - INTERVAL '${intervalSql}'
            AND tool_name IS NOT NULL
          GROUP BY tool_name
          ORDER BY value DESC
          LIMIT 8
        `;
        const costByServiceResult = await this.services.db.query(costByServiceQuery, [userId]);

        // Previous period comparison
        const prevStatsQuery = `
          SELECT
            COUNT(*) as total_requests,
            COALESCE(SUM(total_cost_usd), 0) as total_cost
          FROM cost_tracking
          WHERE user_id = $1
            AND created_at >= NOW() - INTERVAL '${intervalSql}' * 2
            AND created_at < NOW() - INTERVAL '${intervalSql}'
        `;
        const prevStatsResult = await this.services.db.query(prevStatsQuery, [userId]);
        const prevStats = prevStatsResult.rows[0] || {};

        const totalReqs = parseInt(stats.total_requests) || 0;
        const prevTotalReqs = parseInt(prevStats.total_requests) || 0;
        const prevTotalCost = parseFloat(prevStats.total_cost) || 0;

        const topTools = toolsResult.rows.map((t: any) => ({
          name: t.name,
          count: parseInt(t.count),
          cost: parseFloat(t.cost) || 0,
          percentage: totalReqs > 0 ? Math.round((parseInt(t.count) / totalReqs) * 100) : 0,
        }));

        const serviceColors = ['#D97757', '#C66345', '#B55133', '#A43F21', '#932D0F', '#823C1E', '#6B2E15', '#54200C'];
        const costByService = costByServiceResult.rows.map((s: any, idx: number) => ({
          name: s.name,
          value: parseFloat(s.value) || 0,
          color: serviceColors[idx % serviceColors.length],
        }));

        res.json({
          period,
          totalRequests: totalReqs,
          totalCost: parseFloat(stats.total_cost) || 0,
          openaiTokens: parseInt(stats.total_tokens) || 0,
          avgCostPerRequest: parseFloat(stats.avg_cost_per_request) || 0,
          costByService,
          topTools,
          dailyData: dailyResult.rows.map((d: any) => ({
            date: d.date,
            requests: parseInt(d.requests),
            cost: parseFloat(d.cost) || 0,
          })),
          previousPeriod: {
            totalRequests: prevTotalReqs,
            totalCost: prevTotalCost,
            requestsChange: prevTotalReqs > 0 ? Math.round(((totalReqs - prevTotalReqs) / prevTotalReqs) * 100) : 0,
            costChange: prevTotalCost > 0 ? Math.round(((parseFloat(stats.total_cost) - prevTotalCost) / prevTotalCost) * 100) : 0,
          },
        });
      } catch (error: any) {
        logger.error('Failed to get billing statistics', { error: error.message });
        res.status(500).json({ error: 'Failed to get billing statistics' });
      }
    }) as any);

    // GET /api/billing/payment-methods - List saved payment methods (stub)
    this.app.get('/api/billing/payment-methods', requireJWT as any, (async (_req: DualAuthRequest, res: Response) => {
      // Payment methods storage not yet implemented — return empty list
      res.json({ paymentMethods: [] });
    }) as any);

    // PUT /api/billing/settings - Update billing settings
    this.app.put('/api/billing/settings', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const {
          daily_limit_usd,
          monthly_limit_usd,
          email_notifications,
          notify_low_balance,
          notify_payment_success,
          notify_payment_failure,
          notify_monthly_report,
          low_balance_threshold_usd,
        } = req.body;

        const settings: any = {};
        if (daily_limit_usd !== undefined) settings.dailyLimitUsd = daily_limit_usd;
        if (monthly_limit_usd !== undefined) settings.monthlyLimitUsd = monthly_limit_usd;
        if (email_notifications !== undefined) settings.email_notifications = email_notifications;
        if (notify_low_balance !== undefined) settings.notify_low_balance = notify_low_balance;
        if (notify_payment_success !== undefined) settings.notify_payment_success = notify_payment_success;
        if (notify_payment_failure !== undefined) settings.notify_payment_failure = notify_payment_failure;
        if (notify_monthly_report !== undefined) settings.notify_monthly_report = notify_monthly_report;
        if (low_balance_threshold_usd !== undefined) settings.low_balance_threshold_usd = low_balance_threshold_usd;

        await this.billingService.updateBillingSettings(userId, settings);

        res.json({
          success: true,
          message: 'Billing settings updated',
        });
      } catch (error: any) {
        logger.error('Failed to update billing settings', { error: error.message });
        res.status(500).json({
          error: 'Failed to update billing settings',
          message: error.message,
        });
      }
    }) as any);

    // GET /api/billing/email-preferences - Get email notification preferences
    this.app.get('/api/billing/email-preferences', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const preferences = await this.billingService.getEmailPreferences(userId);
        res.json(preferences);
      } catch (error: any) {
        logger.error('Failed to get email preferences', { error: error.message });
        res.status(500).json({
          error: 'Failed to get email preferences',
          message: error.message,
        });
      }
    }) as any);

    // GET /api/billing/invoices - Get invoice list for authenticated user
    this.app.get('/api/billing/invoices', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

        const query = `
          SELECT
            bt.id as transaction_id,
            bt.invoice_number,
            bt.created_at as date,
            bt.amount_usd,
            bt.amount_uah,
            bt.description,
            bt.payment_provider,
            bt.payment_id,
            bt.invoice_generated_at,
            u.name as user_name,
            u.email as user_email
          FROM billing_transactions bt
          JOIN users u ON bt.user_id = u.id
          WHERE bt.user_id = $1
            AND bt.type = 'topup'
            AND bt.invoice_number IS NOT NULL
          ORDER BY bt.created_at DESC
          LIMIT $2 OFFSET $3
        `;
        const result = await this.services.db.query(query, [userId, limit, offset]);

        const invoices = result.rows.map((row: any) => {
          const amount = parseFloat(row.amount_usd) || parseFloat(row.amount_uah) || 0;
          const currency = parseFloat(row.amount_usd) > 0 ? 'USD' : 'UAH';
          return {
            invoiceNumber: row.invoice_number,
            date: row.date,
            customerName: row.user_name || 'Customer',
            customerEmail: row.user_email || '',
            amount,
            currency,
            paymentMethod: row.payment_provider || 'Unknown',
            status: 'paid',
            transactionId: row.transaction_id,
            paymentId: row.payment_id,
          };
        });

        const countQuery = `
          SELECT COUNT(*) FROM billing_transactions
          WHERE user_id = $1 AND type = 'topup' AND invoice_number IS NOT NULL
        `;
        const countResult = await this.services.db.query(countQuery, [userId]);
        const total = parseInt(countResult.rows[0].count);

        res.json({
          invoices,
          total,
          hasMore: offset + result.rows.length < total,
        });
      } catch (error: any) {
        logger.error('Failed to get invoices', { error: error.message });
        res.status(500).json({ error: 'Failed to retrieve invoices' });
      }
    }) as any);

    // GET /api/billing/invoices/:invoiceNumber/pdf - Download invoice as PDF
    this.app.get('/api/billing/invoices/:invoiceNumber/pdf', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const { invoiceNumber } = req.params;

        const query = `
          SELECT
            bt.id,
            bt.amount_usd,
            bt.amount_uah,
            bt.payment_provider,
            bt.payment_id,
            bt.created_at,
            bt.invoice_number,
            u.name as user_name,
            u.email as user_email
          FROM billing_transactions bt
          JOIN users u ON bt.user_id = u.id
          WHERE bt.invoice_number = $1 AND bt.user_id = $2
        `;
        const result = await this.services.db.query(query, [invoiceNumber, userId]);

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Invoice not found' });
        }

        const tx = result.rows[0];
        const amount = parseFloat(tx.amount_usd) || parseFloat(tx.amount_uah) || 0;
        const currency: 'USD' | 'UAH' = parseFloat(tx.amount_usd) > 0 ? 'USD' : 'UAH';

        const invoiceData = this.invoiceService.createInvoiceFromTransaction(
          tx.id,
          tx.invoice_number,
          tx.user_name || 'Customer',
          tx.user_email || '',
          amount,
          currency,
          tx.payment_provider || 'Unknown',
          new Date(tx.created_at),
          tx.payment_id
        );

        const pdfBuffer = await this.invoiceService.generateInvoicePDF(invoiceData);

        // Update generation timestamp
        await this.services.db.query(
          `UPDATE billing_transactions SET invoice_generated_at = NOW() WHERE id = $1`,
          [tx.id]
        );

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${invoiceNumber}.pdf"`);
        res.send(pdfBuffer);

        logger.info('Invoice PDF generated', { invoiceNumber, userId });
      } catch (error: any) {
        logger.error('Failed to generate invoice PDF', { error: error.message });
        res.status(500).json({ error: 'Failed to generate invoice' });
      }
    }) as any);

    // Payment routes - require JWT (user login)
    // POST /api/billing/payment/stripe/create - Create Stripe PaymentIntent
    // POST /api/billing/payment/fondy/create - Create Fondy payment
    // GET /api/billing/payment/:provider/:paymentId/status - Check payment status
    this.app.use('/api/billing/payment', requireJWT as any, createPaymentRouter(this.stripeService, this.fondyService, this.metamaskService, this.binancePayService, this.services.db));

    // Test email route - require JWT (user login)
    // POST /api/billing/test-email - Send test email
    this.app.use('/api/billing/test-email', requireJWT as any, createTestEmailRoute(this.emailService));

    // Billing and user preferences routes
    // GET /api/billing/preferences - Get user request preferences
    // PUT /api/billing/preferences - Update user preferences
    // POST /api/billing/preferences/preset - Apply preset configuration
    // GET /api/billing/presets - Get all available presets
    // POST /api/billing/estimate-costs - Estimate costs for different presets
    // GET /api/billing/full-settings - Get combined billing and preferences
    // GET /api/billing/pricing-info - Get pricing tier information
    // POST /api/billing/estimate-price - Estimate price with user's tier
    this.app.use('/api/billing', requireJWT as any, createBillingRoutes(this.services.db));

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
    this.app.use('/api/conversations', requireJWT as any, createConversationRouter(this.conversationService));
    logger.info('Conversation routes registered at /api/conversations');

    // GDPR routes - data export and deletion
    this.app.use('/api/gdpr', requireJWT as any, createGdprRouter(this.gdprService));
    logger.info('GDPR routes registered at /api/gdpr');

    // Upload routes - chunked file upload with MinIO storage
    // POST /api/upload/init - Create upload session
    // POST /api/upload/:uploadId/chunk - Upload chunk
    // POST /api/upload/:uploadId/complete - Assemble and process
    // GET /api/upload/:uploadId/status - Check status
    // DELETE /api/upload/:uploadId - Cancel
    // GET /api/upload/active - List active sessions
    this.app.use('/api/upload', requireJWT as any, createUploadRouter(
      this.uploadService,
      this.minioService,
      this.vaultTools,
      this.services.db.getPool(),
      this.uploadQueueService
    ));
    logger.info('Upload routes registered at /api/upload');

    // Client-Matter segregation routes (matters, clients, legal holds, audit)
    this.app.use('/api/matters', requireJWT as any, createMatterRoutes(
      this.matterService, this.conflictCheckService, this.legalHoldService, this.auditService
    ));
    logger.info('Matter routes registered at /api/matters');

    // Time tracking and billing routes
    this.app.use('/api/time', requireJWT as any, createTimeEntryRoutes(this.timeEntryService));
    logger.info('Time tracking routes registered at /api/time');

    this.app.use('/api/invoicing', requireJWT as any, createInvoiceRoutes(this.matterInvoiceService));
    logger.info('Invoicing routes registered at /api/invoicing');

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
    const pricingService = new PricingService(this.services.db);
    const subscriptionService = new SubscriptionService(this.services.db);
    this.app.use('/api/admin', requireJWT as any, createAdminRoutes(this.services.db, process.env.PROMETHEUS_URL, pricingService, subscriptionService));

    // Upload metrics endpoint (admin)
    this.app.get('/api/admin/upload-metrics', requireJWT as any, (async (_req: DualAuthRequest, res: express.Response) => {
      try {
        const queueMetrics = await this.uploadQueueService.getMetrics();
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

    // ============ Legislation listing endpoint ============
    this.app.get('/api/legislation', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const search = (req.query.search as string) || undefined;

        const legislationService = this.services.legislationTools.getLegislationService();
        const result = await legislationService.listLegislation(limit, offset, search);

        res.json(result);
      } catch (error: any) {
        logger.error('Error listing legislation:', error.message);
        res.status(500).json({ error: 'Failed to list legislation' });
      }
    }) as any);

    this.app.get('/api/legislation/:radaId/structure', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const radaId = req.params.radaId as string;
        const legislationService = this.services.legislationTools.getLegislationService();
        const structure = await legislationService.getLegislationStructure(radaId);

        if (!structure) {
          return res.status(404).json({ error: 'Legislation not found' });
        }

        res.json(structure);
      } catch (error: any) {
        logger.error('Error getting legislation structure:', error.message);
        res.status(500).json({ error: 'Failed to get legislation structure' });
      }
    }) as any);

    this.app.get('/api/legislation/:radaId/article/:articleNumber', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const radaId = req.params.radaId as string;
        const articleNumber = req.params.articleNumber as string;
        const legislationService = this.services.legislationTools.getLegislationService();
        const article = await legislationService.getArticle(radaId, articleNumber);

        if (!article) {
          return res.status(404).json({ error: 'Article not found' });
        }

        res.json(article);
      } catch (error: any) {
        logger.error('Error getting legislation article:', error.message);
        res.status(500).json({ error: 'Failed to get article' });
      }
    }) as any);

    // ============ AI Chat endpoint (agentic LLM loop with SSE) ============
    // POST /api/chat - Streams thinking steps, tool results, and final answer
    this.app.post('/api/chat', chatRateLimit as any, requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      const CHAT_CREDITS = 3;
      const userId = req.user?.id;
      const requestId = `chat-${uuidv4()}`;

      try {
        const { query, history, budget, conversationId } = req.body;

        if (!query || typeof query !== 'string') {
          return res.status(400).json({ error: 'query is required' });
        }

        // Pre-flight credit check
        if (userId && this.creditService) {
          const balance = await this.creditService.checkBalance(userId, CHAT_CREDITS);
          if (!balance.hasCredits) {
            return res.status(402).json({
              error: 'Insufficient credits',
              required: CHAT_CREDITS,
              currentBalance: balance.currentBalance,
            });
          }
        }

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        // Abort controller for cancellation propagation
        const abortController = new AbortController();

        // SSE heartbeat to prevent proxy timeouts during long tool calls
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(': heartbeat\n\n');
        }, 15000);

        req.on('close', () => {
          clearInterval(heartbeat);
          abortController.abort();
        });

        let chatCompleted = false;
        try {
          for await (const event of this.chatService.chat({
            query,
            history,
            budget: budget || 'standard',
            conversationId,
            userId,
            requestId,
            signal: abortController.signal,
          })) {
            if (abortController.signal.aborted) break;

            if (event.type === 'complete') chatCompleted = true;

            res.write(`event: ${event.type}\n`);
            res.write(`data: ${JSON.stringify(event.data)}\n\n`);
          }
        } finally {
          clearInterval(heartbeat);
        }

        // Post-execution credit deduction (only if chat completed successfully)
        if (chatCompleted && userId && this.creditService) {
          try {
            const deduction = await this.creditService.deductCredits(
              userId,
              CHAT_CREDITS,
              'ai_chat',
              requestId,
              'AI chat conversation'
            );
            if (deduction.success) {
              logger.info('[ChatService] Credits deducted', {
                userId,
                creditsDeducted: CHAT_CREDITS,
                newBalance: deduction.newBalance,
                requestId,
              });

              // Emit cost_summary SSE event with credit and balance info
              if (!res.writableEnded) {
                let balanceUsd: number | undefined;
                try {
                  const billingBalance = await this.billingService.getOrCreateUserBilling(userId);
                  balanceUsd = billingBalance?.balance_usd;
                } catch (e: any) {
                  logger.warn('[ChatService] Failed to fetch billing balance for cost_summary', { error: e.message });
                }
                res.write(`event: cost_summary\n`);
                res.write(`data: ${JSON.stringify({
                  credits_deducted: CHAT_CREDITS,
                  new_balance_credits: deduction.newBalance,
                  balance_usd: balanceUsd ?? null,
                })}\n\n`);
              }
            }
          } catch (e: any) {
            logger.warn('[ChatService] Failed to deduct credits', { error: e.message, requestId });
          }
        }

        if (!res.writableEnded) {
          res.end();
        }
      } catch (error: any) {
        logger.error('[ChatService] Endpoint error', { error: error.message, requestId });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Chat failed', message: error.message });
        } else if (!res.writableEnded) {
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
          res.end();
        }
      }
    }) as any);
    logger.info('AI Chat endpoint registered at POST /api/chat');

    // Webhook routes - public (signature verified by services, rate limited)
    // POST /webhooks/stripe - already mounted in setupMiddleware() with raw body
    // POST /webhooks/fondy - mount here with JSON body
    this.app.post('/webhooks/fondy', webhookRateLimit as any, (async (req: Request, res: Response) => {
      try {
        await this.fondyService.handleCallback(req.body);
        res.json({ received: true });
      } catch (error: any) {
        logger.error('Fondy callback failed', { error: error.message });
        res.status(400).json({
          error: 'Callback processing failed',
          message: error.message,
        });
      }
    }) as any);

    // Query history endpoint - require JWT (user login)
    this.app.get('/api/history', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

        // Get user's query history from cost_tracking (filtered by user_id)
        const result = await this.services.db.query(
          `SELECT
            id,
            request_id,
            tool_name,
            user_query,
            query_params,
            status,
            created_at,
            completed_at,
            execution_time_ms,
            total_cost_usd
          FROM cost_tracking
          WHERE user_id = $1
            AND status IN ('completed', 'failed')
            AND user_query IS NOT NULL
            AND user_query != ''
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
          [userId, limit, offset]
        );

        // Get total count
        const countResult = await this.services.db.query(
          `SELECT COUNT(*)
          FROM cost_tracking
          WHERE user_id = $1
            AND status IN ('completed', 'failed')
            AND user_query IS NOT NULL
            AND user_query != ''`,
          [userId]
        );

        res.json({
          history: result.rows,
          total: parseInt(countResult.rows[0].count),
          limit,
          offset,
        });
      } catch (error: any) {
        logger.error('Error getting query history:', error);
        res.status(500).json({
          error: 'Failed to get query history',
          message: error.message,
        });
      }
    }) as any);

    // MCP tool endpoints - allow both JWT and API keys
    // List available tools (unified gateway - returns all 44 tools)
    this.app.get('/api/tools', dualAuth as any, ((async (_req: DualAuthRequest, res: Response) => {
      try {
        // Check if unified gateway is enabled
        const gatewayEnabled = process.env.ENABLE_UNIFIED_GATEWAY === 'true';

        if (gatewayEnabled) {
          // Unified gateway mode - fetch from all services
          const allTools = await this.toolRegistry.getAllTools(
            this.toolRegistry.getLocalToolDefinitions(),
            process.env.RADA_MCP_URL,
            process.env.RADA_API_KEY,
            process.env.OPENREYESTR_MCP_URL,
            process.env.OPENREYESTR_API_KEY
          );

          const counts = this.toolRegistry.getToolCounts();

          res.json({
            tools: allTools,
            count: allTools.length,
            gateway: {
              enabled: true,
              services: counts,
            },
          });
        } else {
          // Legacy mode - only backend tools
          const tools = this.toolRegistry.getLocalToolDefinitions();

          res.json({
            tools,
            count: tools.length,
            gateway: {
              enabled: false,
            },
          });
        }
      } catch (error: any) {
        logger.error('Error listing tools:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: error.message,
        });
      }
    }) as any) as any);

    // Call MCP tool (with SSE support and cost tracking)
    // Balance check middleware ensures user has sufficient funds before execution
    const balanceCheckMiddleware = createBalanceCheckMiddleware(this.billingService, this.costTracker);
    this.app.post('/api/tools/:toolName', dualAuth as any, balanceCheckMiddleware as any, (async (req: DualAuthRequest, res: Response) => {
      const requestId = uuidv4();
      const startTime = Date.now();

      try {
        const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
        if (!toolName) {
          return res.status(400).json({ error: 'Tool name is required' });
        }
        const args = req.body.arguments || req.body;
        const acceptHeader = req.headers.accept || '';

        logger.info('Tool call request', {
          requestId,
          tool: toolName,
          clientKey: req.clientKey?.substring(0, 8) + '...',
          streaming: acceptHeader.includes('text/event-stream'),
        });

        // 1. Check credits BEFORE execution (for API key users)
        if (req.authType === 'apikey' && req.user?.id) {
          try {
            const creditsRequired = await this.creditService.calculateCreditsForTool(toolName, req.user.id);

            if (creditsRequired > 0) {
              const balance = await this.creditService.checkBalance(req.user.id, creditsRequired);

              if (!balance.hasCredits) {
                logger.warn('[HTTP API] Insufficient credits, blocking request', {
                  userId: req.user.id,
                  tool: toolName,
                  creditsRequired,
                  currentBalance: balance.currentBalance,
                });

                return res.status(402).json({
                  error: 'Insufficient credits',
                  code: 'INSUFFICIENT_CREDITS',
                  currentBalance: balance.currentBalance,
                  creditsRequired,
                  message: 'Your credit balance is too low to perform this operation. Please purchase more credits.',
                });
              }

              logger.debug('[HTTP API] Credit check passed', {
                userId: req.user.id,
                tool: toolName,
                creditsRequired,
                currentBalance: balance.currentBalance,
              });
            }
          } catch (creditError: any) {
            logger.error('[HTTP API] Error checking credits', {
              userId: req.user.id,
              tool: toolName,
              error: creditError.message,
            });
            // On error, allow the request to proceed (fail open)
          }
        }

        // 2. Create tracking record (pending)
        await this.costTracker.createTrackingRecord({
          requestId,
          toolName,
          clientKey: req.clientKey,
          userId: req.user?.id,
          userQuery: args.query || JSON.stringify(args),
          queryParams: args,
        });

        // 3. Estimate cost BEFORE execution
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

        // 4. Route to appropriate service (GATEWAY LOGIC)
        const gatewayEnabled = process.env.ENABLE_UNIFIED_GATEWAY === 'true';
        const route = gatewayEnabled ? this.toolRegistry.getRoute(toolName) : null;

        let result: any;

        if (gatewayEnabled && route && !route.local) {
          // PROXIED EXECUTION - call remote service (RADA or OpenReyestr)
          logger.info('[Gateway] Proxying to remote service', {
            requestId,
            tool: toolName,
            service: route.service,
            serviceName: route.serviceName,
          });

          // Check if client wants SSE streaming
          if (acceptHeader.includes('text/event-stream')) {
            // Stream from remote service
            return await this.handleStreamingProxyCall(
              req,
              res,
              route.service,
              route.serviceName,
              args,
              requestId
            );
          }

          // Regular JSON request to remote service
          const remoteResult = await this.serviceProxy.callRemoteService({
            service: route.service,
            serviceName: route.serviceName,
            args,
            requestId,
          });

          // Extract result from remote service response
          result = remoteResult.result || remoteResult;

        } else {
          // LOCAL EXECUTION - backend tools
          logger.debug('[Gateway] Executing locally', {
            requestId,
            tool: toolName,
            gatewayEnabled,
            routeFound: !!route,
          });

          // Check if client wants SSE streaming
          if (acceptHeader.includes('text/event-stream')) {
            return this.handleStreamingToolCall(req, res, toolName, args);
          }

          // Execute in request context
          result = await requestContext.run(
            { requestId, task: toolName },
            async () => {
              // Route to appropriate tool handler via centralized registry
              // Special case: list_documents needs userId injection
              const httpToolArgs = toolName === 'list_documents' ? { ...args, userId: req.user?.id } : args;
              return await this.toolRegistry.executeTool(toolName, httpToolArgs);
            }
          );
        }

        // 4.5. Guard: if executeTool returned null, the tool doesn't exist
        if (result === null || result === undefined) {
          res.status(404).json({
            success: false,
            error: 'Tool not found',
            message: `No handler registered for tool: ${toolName}`,
          });
          return;
        }

        // 5. Complete tracking and get breakdown
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

        // 6. Deduct credits after successful execution (for API key users)
        if (req.authType === 'apikey' && req.user?.id) {
          try {
            const creditsRequired = await this.creditService.calculateCreditsForTool(toolName, req.user.id);

            if (creditsRequired > 0) {
              const deduction = await this.creditService.deductCredits(
                req.user.id,
                creditsRequired,
                toolName,
                requestId,
                `Tool execution: ${toolName}`
              );

              if (deduction.success) {
                logger.info('[HTTP API] Credits deducted', {
                  userId: req.user.id,
                  tool: toolName,
                  creditsDeducted: creditsRequired,
                  newBalance: deduction.newBalance,
                });
              } else {
                // This should not happen since we checked balance before execution
                logger.error('[HTTP API] Failed to deduct credits after execution', {
                  userId: req.user.id,
                  tool: toolName,
                  creditsRequired,
                  message: 'Balance was sufficient before execution but deduction failed',
                });
              }
            }
          } catch (creditError: any) {
            logger.error('[HTTP API] Error deducting credits', {
              userId: req.user.id,
              tool: toolName,
              error: creditError.message,
            });
          }
        }

        // 7. Return result with cost tracking info
        res.json({
          success: true,
          tool: toolName,
          service: route?.service || 'backend',
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

    // Dedicated SSE streaming endpoint (with balance check)
    this.app.post('/api/tools/:toolName/stream', dualAuth as any, balanceCheckMiddleware as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
        if (!toolName) {
          return res.status(400).json({ error: 'Tool name is required' });
        }
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

    // Batch tool calls (with balance check)
    this.app.post('/api/tools/batch', dualAuth as any, balanceCheckMiddleware as any, (async (req: DualAuthRequest, res: Response): Promise<void> => {
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
              const result = await this.toolRegistry.executeTool(
                call.name,
                call.arguments || {}
              );
              if (result === null || result === undefined) {
                return {
                  tool: call.name,
                  success: false,
                  error: `No handler registered for tool: ${call.name}`,
                };
              }
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
      await this.services.db.connect();
      await this.services.embeddingService.initialize();
      await this.documentParser.initialize();

      // Initialize Redis for AI-powered legislation classification (optional)
      const redis = await getRedisClient();
      if (redis) {
        this.services.legislationTools.setRedisClient(redis);
        logger.info('Redis connected - AI legislation classification with caching enabled');
      } else {
        logger.info('Redis not available - AI legislation classification will work without caching');
      }

      // Cleanup expired upload sessions every hour
      setInterval(() => {
        this.uploadService.cleanupExpired().catch((err) => {
          logger.error('Upload cleanup failed', { error: err.message });
        });
      }, 60 * 60 * 1000);

      // Cleanup stale pending/uploading sessions every 5 minutes
      setInterval(() => {
        this.uploadService.cleanupStale(30).catch((err) => {
          logger.error('Upload stale cleanup failed', { error: err.message });
        });
      }, 5 * 60 * 1000);
      // Run once on startup too
      this.uploadService.cleanupStale(30).catch((err) => {
        logger.error('Upload stale cleanup on startup failed', { error: err.message });
      });

      // Start upload recovery service (30s delay, then every 5 min)
      this.uploadRecoveryService.start();
      logger.info('Upload recovery service started');

      logger.info('HTTP MCP Server services initialized');
    } catch (error) {
      logger.error('Failed to initialize server:', error);
      throw error;
    }
  }

  private async handleStreamingProxyCall(
    _req: DualAuthRequest,
    res: Response,
    service: ServiceType,
    serviceName: string,
    args: any,
    requestId: string
  ): Promise<void> {
    // Validate service is not backend
    if (service === 'backend') {
      throw new Error('Cannot proxy backend service');
    }
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      logger.info('[Gateway SSE] Proxying stream from remote service', {
        requestId,
        service,
        tool: serviceName,
      });

      // Get remote service stream
      const stream = await this.serviceProxy.callRemoteService({
        service,
        serviceName,
        args,
        requestId,
        acceptHeader: 'text/event-stream',
      });

      // Forward SSE events from remote service to client
      stream.on('data', (chunk: Buffer) => {
        res.write(chunk);
      });

      stream.on('end', () => {
        logger.info('[Gateway SSE] Stream completed', { requestId, service });
        res.end();
      });

      stream.on('error', (error: Error) => {
        logger.error('[Gateway SSE] Stream error', {
          requestId,
          service,
          error: error.message,
        });
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
        res.end();
      });
    } catch (error: any) {
      logger.error('[Gateway SSE] Proxy failed', {
        requestId,
        service,
        error: error.message,
      });

      // Send error event
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
      res.end();
    }
  }

  private async handleStreamingToolCall(
    _req: DualAuthRequest,
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
      // Streaming support for different tools
      if (this.toolRegistry.supportsStreaming(toolName)) {
        await this.toolRegistry.executeToolStream(toolName, args, (event: any) => {
          this.sendSSEEvent(res, event);
        });
      } else if (toolName === 'batch_process_documents') {
        // Batch document processing with real-time progress
        await this.batchDocumentTools.processBatch(args, (event) => {
          this.sendSSEEvent(res, event);
        });
      } else {
        // For other tools, stream the regular result
        const result = await this.toolRegistry.executeTool(toolName, args);
        if (result === null || result === undefined) {
          this.sendSSEEvent(res, {
            type: 'error',
            data: { message: `No handler registered for tool: ${toolName}` },
            id: 'error',
          });
        } else {
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
      logger.info('  GET  /mcp - MCP server info and capabilities');
      logger.info('  POST /sse - MCP SSE endpoint for ChatGPT web');
      logger.info('  GET  /api/tools - List available tools');
      logger.info('  POST /api/tools/:toolName - Call a tool (JSON or SSE)');
      logger.info('  POST /api/tools/:toolName/stream - Stream tool execution (SSE)');
      logger.info('  POST /api/tools/batch - Batch tool calls');
      logger.info('');
      logger.info('ChatGPT Web Integration:');
      logger.info('  - MCP Server URL: https://mcp.legal.org.ua/sse');
      logger.info('  - Discovery: https://mcp.legal.org.ua/mcp');
      logger.info('  - Protocol: MCP over SSE (Model Context Protocol)');
      logger.info('');
      logger.info('SSE Streaming:');
      logger.info('  - Add Accept: text/event-stream header for streaming');
      logger.info('  - Or use /api/tools/:toolName/stream endpoint');
      logger.info('  - Tools with streaming support are auto-detected');
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
