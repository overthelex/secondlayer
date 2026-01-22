#!/usr/bin/env node

/**
 * SecondLayer MCP Stdio Proxy
 *
 * Acts as a local stdio MCP server that proxies requests to remote HTTPS API
 * This allows Claude Desktop to connect to the remote server using the standard command-based config
 */

const axios = require('axios');
const readline = require('readline');

// Configuration
const REMOTE_URL = process.env.MCP_REMOTE_URL || 'https://mcp.legal.org.ua';
const JWT_TOKEN = process.env.MCP_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbGF1ZGUtZGVza3RvcCIsImlhdCI6MTc2ODc2NDIxOSwiZXhwIjoxODAwMzAwMjE5LCJpc3MiOiJzZWNvbmRsYXllci1tY3AifQ.r8VbMPM6bLxQjnLIlqUMW8sTIs-Zw_K-KqAgI8WQvEw';

const api = axios.create({
  baseURL: REMOTE_URL,
  headers: {
    'Authorization': `Bearer ${JWT_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 60000,
});

// Create readline interface for JSON-RPC over stdio
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Log to stderr so it doesn't interfere with stdio
function log(message) {
  console.error(`[MCP Proxy] ${message}`);
}

// Send JSON-RPC response to stdout
function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

// Handle JSON-RPC request
async function handleRequest(request) {
  try {
    const { method, params, id } = request;

    log(`Request: ${method}`);

    if (method === 'tools/list') {
      // Get list of tools from remote server
      const response = await api.get('/api/tools');
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          tools: response.data.tools,
        },
      });
    } else if (method === 'tools/call') {
      // Call a tool on remote server
      const { name, arguments: args } = params;
      const response = await api.post(`/api/tools/${name}`, {
        arguments: args,
      });

      sendResponse({
        jsonrpc: '2.0',
        id,
        result: response.data.result,
      });
    } else if (method === 'initialize') {
      // Handle initialization
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'secondlayer-mcp-proxy',
            version: '1.0.0',
          },
        },
      });
    } else {
      // Unknown method
      sendResponse({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      });
    }
  } catch (error) {
    log(`Error: ${error.message}`);
    sendResponse({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: error.message,
      },
    });
  }
}

// Main
log('Starting SecondLayer MCP Stdio Proxy');
log(`Remote URL: ${REMOTE_URL}`);

// Process each line of input as a JSON-RPC request
rl.on('line', async (line) => {
  try {
    const request = JSON.parse(line);
    await handleRequest(request);
  } catch (error) {
    log(`Parse error: ${error.message}`);
  }
});

// Handle errors
rl.on('error', (error) => {
  log(`Readline error: ${error.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  log('Shutting down...');
  process.exit(0);
});

log('Ready to accept requests');
