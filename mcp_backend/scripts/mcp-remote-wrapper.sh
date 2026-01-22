#!/bin/bash

# SecondLayer MCP Remote Wrapper
# Connects to remote SSE MCP server via local stdio

# Configuration
REMOTE_URL="https://mcp.legal.org.ua/v1/sse"
JWT_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbGF1ZGUtZGVza3RvcCIsImlhdCI6MTc2ODc2NDIxOSwiZXhwIjoxODAwMzAwMjE5LCJpc3MiOiJzZWNvbmRsYXllci1tY3AifQ.r8VbMPM6bLxQjnLIlqUMW8sTIs-Zw_K-KqAgI8WQvEw"

# Use npx to run the MCP client proxy
# This requires @modelcontextprotocol/sdk to be installed
exec npx -y @modelcontextprotocol/sdk sse-client "$REMOTE_URL" --header "Authorization: Bearer $JWT_TOKEN"
