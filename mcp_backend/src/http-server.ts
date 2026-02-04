import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './utils/logger.js';
import { dualAuth, requireJWT, initializeDualAuth, AuthenticatedRequest as DualAuthRequest } from './middleware/dual-auth.js';
import { configurePassport } from './config/passport.js';
import authRouter from './routes/auth.js';
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
import { DocumentAnalysisTools } from './api/document-analysis-tools.js';
import { DocumentParser } from './services/document-parser.js';
import { createRestAPIRouter } from './routes/rest-api.js';
import path from 'path';
// import { createEULARouter } from './routes/eula.js'; // REMOVED: EULA not needed
import { CostTracker } from './services/cost-tracker.js';
import { BillingService } from './services/billing-service.js';
import { StripeService } from './services/stripe-service.js';
import { FondyService } from './services/fondy-service.js';
import { EmailService } from './services/email-service.js';
import { MockStripeService } from './services/__mocks__/stripe-service-mock.js';
import { MockFondyService } from './services/__mocks__/fondy-service-mock.js';
import { createBalanceCheckMiddleware } from './middleware/balance-check.js';
import { createPaymentRouter, createWebhookRouter } from './routes/payment-routes.js';
import { createBillingRoutes } from './routes/billing-routes.js';
import { createAdminRoutes } from './routes/admin-routes.js';
import { createTestEmailRoute } from './routes/test-email-route.js';
import { requestContext } from './utils/openai-client.js';
import { getOpenAIManager } from './utils/openai-client.js';
import passport from 'passport';
import { MCPSSEServer } from './api/mcp-sse-server.js';
import { ApiKeyService } from './services/api-key-service.js';
import { CreditService } from './services/credit-service.js';
import { createApiKeyRouter } from './routes/api-key-routes.js';

dotenv.config();

class HTTPMCPServer {
  private app: express.Application;
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
  private documentParser: DocumentParser;
  private documentAnalysisTools: DocumentAnalysisTools;
  private costTracker: CostTracker;
  private billingService: BillingService;
  private stripeService: StripeService | MockStripeService;
  private fondyService: FondyService | MockFondyService;
  private emailService: EmailService;
  private mcpSSEServer: MCPSSEServer;
  private apiKeyService: ApiKeyService;
  private creditService: CreditService;

  constructor() {
    this.app = express();

    // Initialize services FIRST
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

    // Initialize document parser with Vision API credentials
    const visionKeyPath = path.resolve(process.cwd(), '../vision-ocr-credentials.json');
    this.documentParser = new DocumentParser(visionKeyPath);
    this.documentAnalysisTools = new DocumentAnalysisTools(
      this.documentParser,
      this.sectionizer,
      this.patternStore,
      this.citationValidator,
      this.embeddingService,
      this.documentService
    );

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

    // Initialize cost tracker and billing service
    this.costTracker = new CostTracker(this.db);
    this.billingService = new BillingService(this.db);
    this.costTracker.setBillingService(this.billingService);

    // Initialize Phase 2 billing services (API keys & credits)
    this.apiKeyService = new ApiKeyService(this.db.getPool());
    this.creditService = new CreditService(this.db.getPool());
    logger.info('Phase 2 billing services initialized (API keys & credits)');

    // Initialize payment services
    this.emailService = new EmailService();

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

    logger.info('Payment services initialized', {
      mockPayments: mockPaymentsEnabled,
      stripeMode: useMockStripe ? 'MOCK' : 'REAL',
      fondyMode: useMockFondy ? 'MOCK' : 'REAL',
    });

    const openaiManager = getOpenAIManager();
    openaiManager.setCostTracker(this.costTracker);
    this.zoAdapter.setCostTracker(this.costTracker);
    this.zoPracticeAdapter.setCostTracker(this.costTracker);
    logger.info('Cost tracking and billing initialized');

    // Initialize MCP SSE Server for ChatGPT integration
    this.mcpSSEServer = new MCPSSEServer(
      this.mcpAPI,
      this.legislationTools,
      this.documentAnalysisTools,
      this.costTracker,
      this.creditService
    );
    logger.info('MCP SSE Server initialized with Phase 2 billing support');

    // Initialize authentication
    configurePassport(this.db);
    initializeDualAuth(this.db);
    logger.info('Authentication configured (Google OAuth2 + dual auth)');

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

    // IMPORTANT: Stripe webhooks need raw body BEFORE json parsing
    // Mount webhook routes with raw body parser
    this.app.use(
      '/webhooks/stripe',
      express.raw({ type: 'application/json', limit: '10mb' }),
      createWebhookRouter(this.stripeService, this.fondyService)
    );

    // JSON parsing with UTF-8 support (for all other routes)
    this.app.use(express.json({
      limit: '10mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    }));

    // Initialize Passport middleware
    this.app.use(passport.initialize());

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
        service: 'secondlayer-mcp-http',
        version: '1.0.0',
      });
    });

    // MCP SSE endpoint for ChatGPT web integration (optional auth)
    // Endpoint: POST /sse
    // This implements the Model Context Protocol over Server-Sent Events
    // Reference: https://platform.openai.com/docs/mcp
    this.app.post('/sse', (async (req: DualAuthRequest, res: Response) => {
      try {
        // CRITICAL: Set SSE headers BEFORE any other processing
        // This must be done here to override express.json() middleware
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        // Extract user ID from optional auth header
        let userId: string | undefined;
        let clientKey: string | undefined;

        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.replace('Bearer ', '');

          // Try to authenticate (JWT or API key)
          try {
            if (token.includes('.')) {
              // JWT token - verify and extract userId
              const jwt = await import('jsonwebtoken');
              const decoded = jwt.verify(token, process.env.JWT_SECRET || 'change-this-secret-in-production') as any;
              userId = decoded.userId;
              logger.debug('[MCP SSE] Authenticated with JWT', { userId });
            } else {
              // API key - validate and get user info (Phase 2 Billing)
              clientKey = token;
              const keyInfo = await this.apiKeyService.validateApiKey(token);

              if (keyInfo) {
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
              } else {
                // Invalid API key - continue as anonymous for backward compatibility
                logger.debug('[MCP SSE] Invalid API key, continuing as anonymous', {
                  keyPrefix: token.substring(0, 12) + '...',
                });
                clientKey = undefined;
              }
            }
          } catch (error) {
            // Auth failed, but continue without userId (for backward compatibility)
            logger.debug('[MCP SSE] Auth failed, continuing without userId', { error: (error as Error).message });
          }
        }

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

    // MCP discovery endpoint (public - lists available tools)
    // GET /mcp - Returns MCP server info and capabilities
    this.app.get('/mcp', (_req: Request, res: Response) => {
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
          http: '/api/tools',
        },
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
        })),
      });
    });

    // Authentication routes (public - OAuth endpoints)
    this.app.use('/auth', authRouter);

    // REST API for admin panel (CRUD operations) - require JWT (user login)
    this.app.use('/api/documents', requireJWT as any, createRestAPIRouter(this.db));
    this.app.use('/api/patterns', requireJWT as any, createRestAPIRouter(this.db));
    this.app.use('/api/queries', requireJWT as any, createRestAPIRouter(this.db));

    // User profile endpoint - require JWT
    this.app.use('/api/auth', requireJWT as any, authRouter);

    // Phase 2 Billing: API key management - require JWT (user login)
    this.app.use('/api/keys', requireJWT as any, createApiKeyRouter(this.db.getPool()));
    logger.info('API key management routes registered at /api/keys');

    // EULA endpoints - REMOVED: not needed
    // this.app.use('/api/eula', createEULARouter(this.db.getPool()));

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
          success: true,
          billing: {
            balance_usd: summary.balance_usd,
            balance_uah: summary.balance_uah,
            total_spent_usd: summary.total_spent_usd,
            total_requests: summary.total_requests,
            limits: {
              daily_usd: summary.daily_limit_usd,
              monthly_usd: summary.monthly_limit_usd,
            },
            usage: {
              today_usd: summary.today_spent_usd,
              month_usd: summary.month_spent_usd,
            },
            last_request_at: summary.last_request_at,
          },
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

        res.json({
          success: true,
          message: 'Balance topped up successfully',
          transaction,
        });
      } catch (error: any) {
        logger.error('Failed to top up balance', { error: error.message });
        res.status(500).json({
          error: 'Failed to top up balance',
          message: error.message,
        });
      }
    }) as any);

    // PUT /api/billing/settings - Update billing settings
    this.app.put('/api/billing/settings', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
      try {
        const userId = req.user!.id;
        const { daily_limit_usd, monthly_limit_usd } = req.body;

        const settings: any = {};
        if (daily_limit_usd !== undefined) settings.dailyLimitUsd = daily_limit_usd;
        if (monthly_limit_usd !== undefined) settings.monthlyLimitUsd = monthly_limit_usd;

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

    // Payment routes - require JWT (user login)
    // POST /api/billing/payment/stripe/create - Create Stripe PaymentIntent
    // POST /api/billing/payment/fondy/create - Create Fondy payment
    // GET /api/billing/payment/:provider/:paymentId/status - Check payment status
    this.app.use('/api/billing/payment', requireJWT as any, createPaymentRouter(this.stripeService, this.fondyService));

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
    this.app.use('/api/billing', requireJWT as any, createBillingRoutes(this.db));

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
    this.app.use('/api/admin', requireJWT as any, createAdminRoutes(this.db));

    // Webhook routes - public (signature verified by services)
    // POST /webhooks/stripe - already mounted in setupMiddleware() with raw body
    // POST /webhooks/fondy - mount here with JSON body
    this.app.post('/webhooks/fondy', (async (req: Request, res: Response) => {
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
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

        // Get user's query history from cost_tracking
        const result = await this.db.query(
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
          WHERE status IN ('completed', 'failed')
            AND user_query IS NOT NULL
            AND user_query != ''
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
          [limit, offset]
        );

        // Get total count
        const countResult = await this.db.query(
          `SELECT COUNT(*)
          FROM cost_tracking
          WHERE status IN ('completed', 'failed')
            AND user_query IS NOT NULL
            AND user_query != ''`
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
    // List available tools
    this.app.get('/api/tools', dualAuth as any, ((_req: DualAuthRequest, res: Response) => {
      try {
        const tools = [
          ...this.mcpAPI.getTools(),
          ...this.legislationTools.getToolDefinitions(),
          ...this.documentAnalysisTools.getToolDefinitions(),
        ];
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

        // 1. Create tracking record (pending)
        await this.costTracker.createTrackingRecord({
          requestId,
          toolName,
          clientKey: req.clientKey,
          userId: req.user?.id,
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
            // Route legislation tools
            if (toolName.startsWith('get_legislation_') || toolName === 'search_legislation') {
              let routed;
              switch (toolName) {
                case 'get_legislation_article':
                  routed = await this.legislationTools.getLegislationArticle(args as any);
                  break;
                case 'get_legislation_section':
                  routed = await this.legislationTools.getLegislationSection(args as any);
                  break;
                case 'get_legislation_articles':
                  routed = await this.legislationTools.getLegislationArticles(args as any);
                  break;
                case 'search_legislation':
                  routed = await this.legislationTools.searchLegislation(args as any);
                  break;
                case 'get_legislation_structure':
                  routed = await this.legislationTools.getLegislationStructure(args as any);
                  break;
                default:
                  throw new Error(`Unknown legislation tool: ${toolName}`);
              }
              return {
                content: [{ type: 'text', text: JSON.stringify(routed, null, 2) }],
              };
            }

            // Route document analysis tools
            if (['parse_document', 'extract_key_clauses', 'summarize_document', 'compare_documents'].includes(toolName)) {
              let routed;
              switch (toolName) {
                case 'parse_document':
                  routed = await this.documentAnalysisTools.parseDocument(args as any);
                  break;
                case 'extract_key_clauses':
                  routed = await this.documentAnalysisTools.extractKeyClauses(args as any);
                  break;
                case 'summarize_document':
                  routed = await this.documentAnalysisTools.summarizeDocument(args as any);
                  break;
                case 'compare_documents':
                  routed = await this.documentAnalysisTools.compareDocuments(args as any);
                  break;
                default:
                  throw new Error(`Unknown document analysis tool: ${toolName}`);
              }
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(routed, null, 2),
                  },
                ],
              };
            }

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
      await this.embeddingService.initialize();
      await this.documentParser.initialize();
      logger.info('HTTP MCP Server services initialized');
    } catch (error) {
      logger.error('Failed to initialize server:', error);
      throw error;
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
