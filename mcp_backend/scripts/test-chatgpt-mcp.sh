#!/bin/bash

#
# Test script for ChatGPT MCP integration
# Usage: ./scripts/test-chatgpt-mcp.sh [base_url]
#

set -e

# Configuration
BASE_URL="${1:-https://mcp.legal.org.ua}"
BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BOLD}=== ChatGPT MCP Integration Test ===${NC}\n"
echo "Testing server: $BASE_URL"
echo ""

# Test 1: Health check
echo -e "${BOLD}1. Testing health endpoint...${NC}"
HEALTH=$(curl -s "$BASE_URL/health" || echo '{"status":"error"}')
if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo "  Response: $HEALTH"
else
    echo -e "${RED}✗ Health check failed${NC}"
    echo "  Response: $HEALTH"
    exit 1
fi
echo ""

# Test 2: MCP discovery
echo -e "${BOLD}2. Testing MCP discovery endpoint...${NC}"
MCP_INFO=$(curl -s "$BASE_URL/mcp" || echo '{}')
TOOL_COUNT=$(echo "$MCP_INFO" | jq -r '.capabilities.tools.count // 0')
if [ "$TOOL_COUNT" -gt "0" ]; then
    echo -e "${GREEN}✓ MCP discovery passed${NC}"
    echo "  Protocol version: $(echo "$MCP_INFO" | jq -r '.protocolVersion')"
    echo "  Server name: $(echo "$MCP_INFO" | jq -r '.serverInfo.name')"
    echo "  Tools available: $TOOL_COUNT"
else
    echo -e "${RED}✗ MCP discovery failed${NC}"
    echo "  Expected: 41 tools, Got: $TOOL_COUNT"
    echo "  Response: $MCP_INFO"
    exit 1
fi
echo ""

# Test 3: SSE initialize
echo -e "${BOLD}3. Testing SSE initialize...${NC}"
SSE_INIT=$(curl -s -X POST "$BASE_URL/sse" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    --max-time 10 \
    -d '{
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "clientInfo": {
                "name": "test-client",
                "version": "1.0.0"
            }
        }
    }' || echo '')

if echo "$SSE_INIT" | grep -q "server/initialized"; then
    echo -e "${GREEN}✓ SSE initialize passed${NC}"
    echo "  Received server/initialized event"
else
    echo -e "${YELLOW}⚠ SSE initialize may have issues${NC}"
    echo "  Response (first 500 chars): ${SSE_INIT:0:500}"
fi
echo ""

# Test 4: Tools list via SSE
echo -e "${BOLD}4. Testing tools/list via SSE...${NC}"
SSE_TOOLS=$(curl -s -X POST "$BASE_URL/sse" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    --max-time 10 \
    -d '{
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }' || echo '')

if echo "$SSE_TOOLS" | grep -q "tools"; then
    TOOLS_IN_SSE=$(echo "$SSE_TOOLS" | grep "data:" | head -1 | sed 's/data: //' | jq -r '.result.tools | length // 0' 2>/dev/null || echo 0)
    if [ "$TOOLS_IN_SSE" -gt "0" ]; then
        echo -e "${GREEN}✓ Tools list via SSE passed${NC}"
        echo "  Tools in SSE response: $TOOLS_IN_SSE"
    else
        echo -e "${YELLOW}⚠ Tools list may have issues${NC}"
        echo "  Response (first 500 chars): ${SSE_TOOLS:0:500}"
    fi
else
    echo -e "${YELLOW}⚠ Tools list may have issues${NC}"
    echo "  Response (first 500 chars): ${SSE_TOOLS:0:500}"
fi
echo ""

# Test 5: Tool execution via SSE
echo -e "${BOLD}5. Testing tool execution (classify_intent)...${NC}"
SSE_TOOL_CALL=$(curl -s -X POST "$BASE_URL/sse" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    --max-time 15 \
    -d '{
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "classify_intent",
            "arguments": {
                "query": "Які строки апеляційного оскарження?"
            }
        }
    }' || echo '')

if echo "$SSE_TOOL_CALL" | grep -q "result"; then
    echo -e "${GREEN}✓ Tool execution passed${NC}"
    echo "  Successfully executed classify_intent"
    # Extract result
    RESULT=$(echo "$SSE_TOOL_CALL" | grep "data:" | grep "result" | head -1 | sed 's/data: //' | jq -r '.result.content[0].text // "N/A"' 2>/dev/null || echo "N/A")
    echo "  Result preview: ${RESULT:0:200}..."
else
    echo -e "${YELLOW}⚠ Tool execution may have issues${NC}"
    echo "  Response (first 500 chars): ${SSE_TOOL_CALL:0:500}"
fi
echo ""

# Test 6: HTTP API (non-SSE)
echo -e "${BOLD}6. Testing HTTP API endpoint...${NC}"
HTTP_TOOLS=$(curl -s "$BASE_URL/api/tools" || echo '{}')
HTTP_TOOL_COUNT=$(echo "$HTTP_TOOLS" | jq -r '.count // 0')
if [ "$HTTP_TOOL_COUNT" -gt "0" ]; then
    echo -e "${GREEN}✓ HTTP API passed${NC}"
    echo "  Tools via HTTP: $HTTP_TOOL_COUNT"
else
    echo -e "${RED}✗ HTTP API failed${NC}"
    echo "  Response: $HTTP_TOOLS"
    exit 1
fi
echo ""

# Summary
echo -e "${BOLD}=== Test Summary ===${NC}"
echo ""
echo "Server: $BASE_URL"
echo "Health: $(echo "$HEALTH" | jq -r '.status')"
echo "MCP Protocol: $(echo "$MCP_INFO" | jq -r '.protocolVersion')"
echo "Tools Available: $TOOL_COUNT"
echo ""
echo -e "${GREEN}All tests completed!${NC}"
echo ""
echo "Next steps:"
echo "1. Add server to ChatGPT: $BASE_URL/sse"
echo "2. View full docs: docs/CHATGPT_INTEGRATION.md"
echo "3. Check logs: pm2 logs mcp-backend"
echo ""
echo "Configuration example for ChatGPT:"
echo "  Name: SecondLayer Legal Research"
echo "  URL: $BASE_URL/sse"
echo "  Auth: OAuth or Bearer Token"
echo ""
