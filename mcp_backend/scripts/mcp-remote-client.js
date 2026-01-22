#!/usr/bin/env node

/**
 * SecondLayer MCP Remote Client
 *
 * Connects to remote SSE MCP server and proxies to stdio for Claude Desktop
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const REMOTE_URL = process.env.MCP_REMOTE_URL || 'https://mcp.legal.org.ua/v1/sse';
const JWT_TOKEN = process.env.MCP_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbGF1ZGUtZGVza3RvcCIsImlhdCI6MTc2ODc2NDIxOSwiZXhwIjoxODAwMzAwMjE5LCJpc3MiOiJzZWNvbmRsYXllci1tY3AifQ.r8VbMPM6bLxQjnLIlqUMW8sTIs-Zw_K-KqAgI8WQvEw';

async function main() {
  try {
    // Create MCP client
    const client = new Client({
      name: 'secondlayer-remote-client',
      version: '1.0.0',
    });

    // Create SSE transport with authentication
    const transport = new SSEClientTransport(
      new URL(REMOTE_URL),
      {
        headers: {
          'Authorization': `Bearer ${JWT_TOKEN}`,
        },
      }
    );

    // Connect to remote server
    await client.connect(transport);

    console.error('Connected to SecondLayer MCP at', REMOTE_URL);

    // Keep process alive
    process.on('SIGINT', async () => {
      console.error('Disconnecting...');
      await client.close();
      process.exit(0);
    });

    // Wait forever
    await new Promise(() => {});
  } catch (error) {
    console.error('Error connecting to remote MCP:', error.message);
    process.exit(1);
  }
}

main();
