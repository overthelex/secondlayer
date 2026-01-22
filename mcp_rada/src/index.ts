/**
 * RADA MCP Server - stdio entry point
 * Provides parliament data analysis via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { Database } from './database/database';
import { RadaAPIAdapter } from './adapters/rada-api-adapter';
import { ZakonRadaAdapter } from './adapters/zakon-rada-adapter';
import { DeputyService } from './services/deputy-service';
import { BillService } from './services/bill-service';
import { LegislationService } from './services/legislation-service';
import { VotingService } from './services/voting-service';
import { CrossReferenceService } from './services/cross-reference-service';
import { CostTracker } from './services/cost-tracker';
import { MCPRadaAPI } from './api/mcp-rada-api';
import { getLLMManager } from './utils/llm-client-manager';

dotenv.config();

class RadaMCPServer {
  private server: Server;
  private db: Database;
  private radaAdapter: RadaAPIAdapter;
  private zakonAdapter: ZakonRadaAdapter;
  private deputyService: DeputyService;
  private billService: BillService;
  private legislationService: LegislationService;
  private votingService: VotingService;
  private crossRefService: CrossReferenceService;
  private costTracker: CostTracker;
  private mcpAPI: MCPRadaAPI;

  constructor() {
    this.server = new Server(
      {
        name: 'rada-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize database and adapters
    this.db = new Database();
    this.radaAdapter = new RadaAPIAdapter();
    this.zakonAdapter = new ZakonRadaAdapter();

    // Initialize cost tracker
    this.costTracker = new CostTracker(this.db);

    // Set cost tracker on LLM manager
    const llmManager = getLLMManager();
    llmManager.setCostTracker(this.costTracker);

    // Initialize services
    this.deputyService = new DeputyService(this.db, this.radaAdapter);
    this.billService = new BillService(this.db, this.radaAdapter);
    this.legislationService = new LegislationService(this.db, this.zakonAdapter);
    this.votingService = new VotingService(this.db, this.radaAdapter);
    this.crossRefService = new CrossReferenceService(this.db);

    // Set cost tracker on adapters
    this.radaAdapter.setCostTracker(this.costTracker);
    this.zakonAdapter.setCostTracker(this.costTracker);

    // Initialize MCP API
    this.mcpAPI = new MCPRadaAPI(
      this.deputyService,
      this.billService,
      this.legislationService,
      this.votingService,
      this.crossRefService,
      this.costTracker
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.mcpAPI.getTools(),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
  }

  async initialize() {
    try {
      await this.db.connect();
      logger.info('RADA MCP Server initialized');
    } catch (error) {
      logger.error('Failed to initialize server:', error);
      throw error;
    }
  }

  async start() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('RADA MCP Server started (stdio mode)');
  }
}

// Start server
const server = new RadaMCPServer();
server.start().catch((error) => {
  logger.error('Failed to start RADA MCP server:', error);
  process.exit(1);
});
