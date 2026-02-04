#!/bin/bash

# Test script for Staging MCP Server SSE connection
# Tests connection to https://stage.mcp.legal.org.ua/sse

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STAGE_URL="https://stage.mcp.legal.org.ua"
# Use the token from .env.stage
API_KEY="test-key-123"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Staging MCP Server Connection Test${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Test 1: Health check
echo -e "${YELLOW}Test 1: Health Check${NC}"
echo "Testing: ${STAGE_URL}/health"
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "${STAGE_URL}/health" 2>&1 || echo "connection_failed")

if echo "$HEALTH_RESPONSE" | grep -q "200"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo "Response: $(echo "$HEALTH_RESPONSE" | head -n -1)"
else
    echo -e "${RED}✗ Health check failed${NC}"
    echo "Response: $HEALTH_RESPONSE"
fi
echo ""

# Test 2: MCP Discovery
echo -e "${YELLOW}Test 2: MCP Discovery Endpoint${NC}"
echo "Testing: ${STAGE_URL}/mcp"
MCP_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer ${API_KEY}" \
    "${STAGE_URL}/mcp" 2>&1 || echo "connection_failed")

if echo "$MCP_RESPONSE" | grep -q "200"; then
    echo -e "${GREEN}✓ MCP discovery passed${NC}"
    echo "Response: $(echo "$MCP_RESPONSE" | head -n -1 | jq '.' 2>/dev/null || echo "$MCP_RESPONSE" | head -n -1)"
else
    echo -e "${RED}✗ MCP discovery failed${NC}"
    echo "Response: $MCP_RESPONSE"
fi
echo ""

# Test 3: SSE Connection (initialize)
echo -e "${YELLOW}Test 3: SSE Connection (POST /sse)${NC}"
echo "Testing: ${STAGE_URL}/sse"
echo "Sending initialization request..."

SSE_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{"roots":{"listChanged":false}},"clientInfo":{"name":"test-client","version":"1.0.0"}}}' \
    --max-time 10 \
    "${STAGE_URL}/sse" 2>&1 || echo "connection_failed")

if echo "$SSE_RESPONSE" | grep -q "200"; then
    echo -e "${GREEN}✓ SSE connection successful${NC}"
    echo "Response preview:"
    echo "$SSE_RESPONSE" | head -n -1 | head -n 20

    # Check if it's valid SSE format
    if echo "$SSE_RESPONSE" | grep -q "event:"; then
        echo -e "${GREEN}✓ Valid SSE format detected${NC}"
    fi
else
    echo -e "${RED}✗ SSE connection failed${NC}"
    echo "Response: $SSE_RESPONSE"
fi
echo ""

# Test 4: List tools via SSE
echo -e "${YELLOW}Test 4: List MCP Tools${NC}"
echo "Testing tools/list call..."

TOOLS_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    --max-time 10 \
    "${STAGE_URL}/sse" 2>&1 || echo "connection_failed")

if echo "$TOOLS_RESPONSE" | grep -q "200"; then
    echo -e "${GREEN}✓ Tools list request successful${NC}"
    echo "Response preview:"
    echo "$TOOLS_RESPONSE" | head -n -1 | head -n 30

    # Try to count tools
    TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | grep -o '"name"' | wc -l)
    if [ "$TOOL_COUNT" -gt 0 ]; then
        echo -e "${GREEN}✓ Found $TOOL_COUNT tools${NC}"
    fi
else
    echo -e "${RED}✗ Tools list request failed${NC}"
    echo "Response: $TOOLS_RESPONSE"
fi
echo ""

# Test 5: Simple query (classify_intent)
echo -e "${YELLOW}Test 5: Test Tool Call (classify_intent)${NC}"
echo "Testing actual tool execution..."

QUERY_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"classify_intent","arguments":{"query":"Знайти судові рішення про розірвання шлюбу"}}}' \
    --max-time 15 \
    "${STAGE_URL}/sse" 2>&1 || echo "connection_failed")

if echo "$QUERY_RESPONSE" | grep -q "200"; then
    echo -e "${GREEN}✓ Tool call successful${NC}"
    echo "Response preview:"
    echo "$QUERY_RESPONSE" | head -n -1 | head -n 40
else
    echo -e "${RED}✗ Tool call failed${NC}"
    echo "Response: $QUERY_RESPONSE"
fi
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Test Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "Staging MCP URL: ${STAGE_URL}"
echo -e "API Key used: ${API_KEY}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Configure DNS to point stage.mcp.legal.org.ua to your server"
echo "2. Copy nginx config to server:"
echo "   sudo cp deployment/nginx-stage-mcp.conf /etc/nginx/sites-available/stage.mcp.legal.org.ua"
echo "   sudo ln -s /etc/nginx/sites-available/stage.mcp.legal.org.ua /etc/nginx/sites-enabled/"
echo "3. Get SSL certificate:"
echo "   sudo certbot --nginx -d stage.mcp.legal.org.ua"
echo "4. Reload nginx:"
echo "   sudo systemctl reload nginx"
echo "5. Run this test script again to verify"
echo ""
echo -e "${GREEN}For Claude Desktop integration, use this URL:${NC}"
echo -e "  https://stage.mcp.legal.org.ua/sse"
echo ""
