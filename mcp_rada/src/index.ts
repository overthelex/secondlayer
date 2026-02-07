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
import { createRadaCoreServices, RadaCoreServices } from './factories/rada-services';

dotenv.config();

class RadaMCPServer {
  private server: Server;
  private services: RadaCoreServices;

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

    this.services = createRadaCoreServices();
    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.services.mcpAPI.getTools(),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const result = await this.services.mcpAPI.handleToolCall(
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
      await this.services.db.connect();
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
