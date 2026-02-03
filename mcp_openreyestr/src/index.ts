#!/usr/bin/env node
/**
 * OpenReyestr MCP Server - stdio entry point
 * Provides Ukrainian State Register access via Model Context Protocol (stdio)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { OpenReyestrTools } from './api/openreyestr-tools.js';
import { MCPOpenReyestrAPI } from './api/mcp-openreyestr-api.js';
import { Database } from './database/database.js';
import { CostTracker } from './services/cost-tracker.js';
import { logger } from './utils/logger.js';

dotenv.config();

// Initialize database and services
const db = new Database();
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5435'),
  user: process.env.POSTGRES_USER || 'openreyestr',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'openreyestr',
});

const costTracker = new CostTracker(db);
const tools = new OpenReyestrTools(pool);
const mcpAPI = new MCPOpenReyestrAPI(tools, costTracker);

const server = new Server(
  {
    name: 'openreyestr-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools - delegate to MCPOpenReyestrAPI
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: mcpAPI.getTools(),
  };
});

// Handle tool execution - delegate to MCPOpenReyestrAPI
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    return await mcpAPI.handleToolCall(name, args);
  } catch (error) {
    logger.error('Tool execution error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OPENREYESTR MCP Server running on stdio');
}

runServer().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
