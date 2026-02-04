#!/bin/bash
# Test script to verify MCP server can start in STDIO mode

echo "=== Testing MCP Server STDIO mode ===" >&2
echo "Working directory: $(pwd)" >&2
echo "Node location: $(which node)" >&2
echo "Node version: $(node --version)" >&2
echo "" >&2

# Set environment
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_USER=secondlayer
export POSTGRES_PASSWORD=local_dev_password
export POSTGRES_DB=secondlayer_local
export REDIS_HOST=localhost
export REDIS_PORT=6379
export QDRANT_URL=http://localhost:6333
export OPENAI_API_KEY=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
export ZAKONONLINE_API_TOKEN=E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B
export NODE_ENV=production
export LOG_LEVEL=info

echo "Starting MCP server..." >&2
exec /usr/bin/node /home/vovkes/SecondLayer/mcp_backend/dist/index.js
