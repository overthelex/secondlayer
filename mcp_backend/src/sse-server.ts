import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './utils/logger.js';
import { createBackendCoreServices, BackendCoreServices } from './factories/core-services.js';
import { authenticateJWT } from './middleware/jwt-auth.js';
import { getRedisClient } from './utils/redis-client.js';

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
class SSEServer {
  private app: express.Application;
  private services: BackendCoreServices;

  constructor() {
    this.app = express();

    // Initialize core services via factory
    this.services = createBackendCoreServices();

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
        tools: this.services.mcpAPI.getTools().length,
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
            tools: [
              ...this.services.mcpAPI.getTools(),
              ...this.services.legislationTools.getToolDefinitions(),
            ],
          };
        });

        mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
          try {
            const toolName = request.params.name;
            const args = request.params.arguments || {};

            if (toolName.startsWith('get_legislation_') || toolName === 'search_legislation') {
              let result;
              switch (toolName) {
                case 'get_legislation_article':
                  result = await this.services.legislationTools.getLegislationArticle(args as any);
                  break;
                case 'get_legislation_section':
                  result = await this.services.legislationTools.getLegislationSection(args as any);
                  break;
                case 'get_legislation_articles':
                  result = await this.services.legislationTools.getLegislationArticles(args as any);
                  break;
                case 'search_legislation':
                  result = await this.services.legislationTools.searchLegislation(args as any);
                  break;
                case 'get_legislation_structure':
                  result = await this.services.legislationTools.getLegislationStructure(args as any);
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

            return await this.services.mcpAPI.handleToolCall(toolName, args);
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
      await this.services.db.connect();
      await this.services.embeddingService.initialize();

      // Initialize Redis for AI-powered legislation classification (optional)
      const redis = await getRedisClient();
      if (redis) {
        this.services.legislationTools.setRedisClient(redis);
        logger.info('Redis connected - AI legislation classification with caching enabled');
      } else {
        logger.info('Redis not available - AI legislation classification will work without caching');
      }

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

    const server = this.app.listen(port, host, () => {
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

    void server;
  }
}

// Start server
const server = new SSEServer();
server.start().catch((error: any) => {
  logger.error('Failed to start SSE MCP server:', error);
  process.exit(1);
});
