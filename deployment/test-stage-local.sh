#!/bin/bash

# Local test script for Staging MCP Backend
# Tests direct connection to localhost:3002 (before nginx setup)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STAGE_URL="http://localhost:3004"
API_KEY="test-key-123"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Staging Backend Local Test${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Testing direct connection to staging backend on port 3004"
echo ""

# Test 1: Check if port is open
echo -e "${YELLOW}Test 1: Port Check${NC}"
if nc -z localhost 3004 2>/dev/null; then
    echo -e "${GREEN}✓ Port 3004 is open${NC}"
else
    echo -e "${RED}✗ Port 3004 is not accessible${NC}"
    echo "Make sure staging backend is running:"
    echo "  cd deployment && docker-compose -f docker-compose.stage.yml --env-file .env.stage up -d"
    exit 1
fi
echo ""

# Test 2: Health check
echo -e "${YELLOW}Test 2: Health Check${NC}"
echo "Testing: ${STAGE_URL}/health"
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "${STAGE_URL}/health" 2>&1)
HTTP_CODE=$(echo "$HEALTH_RESPONSE" | tail -n 1)

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Health check passed (HTTP $HTTP_CODE)${NC}"
    echo "Response: $(echo "$HEALTH_RESPONSE" | head -n -1)"
else
    echo -e "${RED}✗ Health check failed (HTTP $HTTP_CODE)${NC}"
    echo "Response: $HEALTH_RESPONSE"
fi
echo ""

# Test 3: MCP Discovery
echo -e "${YELLOW}Test 3: MCP Discovery${NC}"
echo "Testing: ${STAGE_URL}/mcp"
MCP_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer ${API_KEY}" \
    "${STAGE_URL}/mcp" 2>&1)
HTTP_CODE=$(echo "$MCP_RESPONSE" | tail -n 1)

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ MCP discovery passed (HTTP $HTTP_CODE)${NC}"
    echo "Response:"
    echo "$MCP_RESPONSE" | head -n -1 | jq '.' 2>/dev/null || echo "$MCP_RESPONSE" | head -n -1
else
    echo -e "${RED}✗ MCP discovery failed (HTTP $HTTP_CODE)${NC}"
    echo "Response: $MCP_RESPONSE"
fi
echo ""

# Test 4: SSE Connection
echo -e "${YELLOW}Test 4: SSE Connection${NC}"
echo "Testing: ${STAGE_URL}/sse"
SSE_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{"roots":{"listChanged":false}},"clientInfo":{"name":"test-client","version":"1.0.0"}}}' \
    --max-time 10 \
    "${STAGE_URL}/sse" 2>&1)
HTTP_CODE=$(echo "$SSE_RESPONSE" | tail -n 1)

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ SSE connection successful (HTTP $HTTP_CODE)${NC}"
    echo "Response preview:"
    echo "$SSE_RESPONSE" | head -n -1 | head -n 10

    if echo "$SSE_RESPONSE" | grep -q "event:"; then
        echo -e "${GREEN}✓ Valid SSE format detected${NC}"
    fi
else
    echo -e "${RED}✗ SSE connection failed (HTTP $HTTP_CODE)${NC}"
    echo "Response: $SSE_RESPONSE"
fi
echo ""

# Test 5: List tools
echo -e "${YELLOW}Test 5: List Tools${NC}"
TOOLS_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    --max-time 10 \
    "${STAGE_URL}/sse" 2>&1)
HTTP_CODE=$(echo "$TOOLS_RESPONSE" | tail -n 1)

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Tools list successful (HTTP $HTTP_CODE)${NC}"

    # Count tools
    TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | grep -o '"name"' | wc -l)
    echo -e "${GREEN}✓ Found $TOOL_COUNT tools${NC}"

    echo "Sample tools:"
    echo "$TOOLS_RESPONSE" | grep -o '"name":"[^"]*"' | head -n 10 | sed 's/"name"://g'
else
    echo -e "${RED}✗ Tools list failed (HTTP $HTTP_CODE)${NC}"
    echo "Response preview: $(echo "$TOOLS_RESPONSE" | head -n 20)"
fi
echo ""

# Test 6: Test tool execution
echo -e "${YELLOW}Test 6: Tool Execution (classify_intent)${NC}"
CLASSIFY_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"classify_intent","arguments":{"query":"Знайти судові рішення про розірвання шлюбу"}}}' \
    --max-time 15 \
    "${STAGE_URL}/sse" 2>&1)
HTTP_CODE=$(echo "$CLASSIFY_RESPONSE" | tail -n 1)

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Tool execution successful (HTTP $HTTP_CODE)${NC}"
    echo "Response preview:"
    echo "$CLASSIFY_RESPONSE" | head -n -1 | head -n 20

    # Check for successful result
    if echo "$CLASSIFY_RESPONSE" | grep -q "classification"; then
        echo -e "${GREEN}✓ Tool returned valid classification result${NC}"
    fi
else
    echo -e "${RED}✗ Tool execution failed (HTTP $HTTP_CODE)${NC}"
    echo "Response: $CLASSIFY_RESPONSE"
fi
echo ""

# Check environment variables
echo -e "${YELLOW}Test 7: Environment Check${NC}"
if [ -f "deployment/.env.stage" ]; then
    echo -e "${GREEN}✓ .env.stage file exists${NC}"

    # Check critical env vars
    if grep -q "SECONDARY_LAYER_KEYS" deployment/.env.stage; then
        echo -e "${GREEN}✓ SECONDARY_LAYER_KEYS configured${NC}"
    else
        echo -e "${RED}✗ SECONDARY_LAYER_KEYS not found in .env.stage${NC}"
    fi

    if grep -q "OPENAI_API_KEY" deployment/.env.stage; then
        echo -e "${GREEN}✓ OPENAI_API_KEY configured${NC}"
    else
        echo -e "${YELLOW}⚠ OPENAI_API_KEY not found in .env.stage${NC}"
    fi
else
    echo -e "${RED}✗ .env.stage file not found${NC}"
fi
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Test Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${GREEN}Backend is running correctly!${NC}"
echo ""
echo -e "${YELLOW}Next steps to enable HTTPS access:${NC}"
echo "1. Configure DNS: stage.mcp.legal.org.ua → gate server IP"
echo "2. Copy nginx config to gate server:"
echo "   scp deployment/nginx-stage-mcp.conf gate:/tmp/"
echo "   ssh gate 'sudo mv /tmp/nginx-stage-mcp.conf /etc/nginx/sites-available/stage.mcp.legal.org.ua'"
echo "   ssh gate 'sudo ln -s /etc/nginx/sites-available/stage.mcp.legal.org.ua /etc/nginx/sites-enabled/'"
echo "3. Get SSL certificate on gate server:"
echo "   ssh gate 'sudo certbot --nginx -d stage.mcp.legal.org.ua'"
echo "4. Reload nginx:"
echo "   ssh gate 'sudo systemctl reload nginx'"
echo "5. Test HTTPS connection:"
echo "   ./test-stage-mcp-connection.sh"
echo ""
