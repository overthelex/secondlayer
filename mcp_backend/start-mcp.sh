#!/bin/bash
# MCP Server startup script for Jan Chat

# Get script directory (absolute path)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Change to script directory
cd "$SCRIPT_DIR"

# Load environment from .env file if exists
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Start MCP server in STDIO mode
exec node dist/index.js
