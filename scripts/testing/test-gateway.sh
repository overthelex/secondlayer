#!/bin/bash

# Unified Gateway Test Script
# Tests the unified MCP gateway with all 44 tools

set -e

# Configuration
BASE_URL="${BASE_URL:-http://localhost:3004}"
API_KEY="${API_KEY:-REDACTED_SL_KEY_STAGE}"

echo "=========================================="
echo "Unified Gateway Test Script"
echo "=========================================="
echo "Base URL: $BASE_URL"
echo "API Key: ${API_KEY:0:20}..."
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: List all tools
echo -e "${YELLOW}Test 1: List all tools${NC}"
TOOLS_RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/tools")
TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | jq -r '.count // 0')
GATEWAY_ENABLED=$(echo "$TOOLS_RESPONSE" | jq -r '.gateway.enabled // false')

echo "Tool count: $TOOL_COUNT"
echo "Gateway enabled: $GATEWAY_ENABLED"

if [ "$TOOL_COUNT" -eq 45 ] && [ "$GATEWAY_ENABLED" = "true" ]; then
  echo -e "${GREEN}✓ Test 1 PASSED${NC} - All 45 tools available"
else
  echo -e "${RED}✗ Test 1 FAILED${NC} - Expected 45 tools with gateway enabled, got $TOOL_COUNT"
fi
echo ""

# Test 2: Execute backend tool (local)
echo -e "${YELLOW}Test 2: Execute backend tool (local)${NC}"
BACKEND_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  "$BASE_URL/api/tools/classify_intent" \
  -d '{"arguments": {"query": "знайти судові рішення про відшкодування шкоди"}}')

BACKEND_SUCCESS=$(echo "$BACKEND_RESPONSE" | jq -r '.success // false')
BACKEND_SERVICE=$(echo "$BACKEND_RESPONSE" | jq -r '.service // "unknown"')

echo "Success: $BACKEND_SUCCESS"
echo "Service: $BACKEND_SERVICE"

if [ "$BACKEND_SUCCESS" = "true" ] && [ "$BACKEND_SERVICE" = "backend" ]; then
  echo -e "${GREEN}✓ Test 2 PASSED${NC} - Backend tool executed locally"
else
  echo -e "${RED}✗ Test 2 FAILED${NC}"
  echo "Response: $BACKEND_RESPONSE" | jq '.'
fi
echo ""

# Test 3: Execute RADA tool (proxied) - only if RADA service is available
echo -e "${YELLOW}Test 3: Execute RADA tool (proxied)${NC}"
RADA_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  "$BASE_URL/api/tools/rada_get_deputy_info" \
  -d '{"arguments": {"name": "Зеленський"}}' 2>&1)

RADA_SUCCESS=$(echo "$RADA_RESPONSE" | jq -r '.success // false' 2>/dev/null || echo "false")
RADA_SERVICE=$(echo "$RADA_RESPONSE" | jq -r '.service // "unknown"' 2>/dev/null || echo "unknown")

echo "Success: $RADA_SUCCESS"
echo "Service: $RADA_SERVICE"

if [ "$RADA_SUCCESS" = "true" ] && [ "$RADA_SERVICE" = "rada" ]; then
  echo -e "${GREEN}✓ Test 3 PASSED${NC} - RADA tool proxied successfully"
elif echo "$RADA_RESPONSE" | grep -q "not configured"; then
  echo -e "${YELLOW}⊘ Test 3 SKIPPED${NC} - RADA service not configured"
else
  echo -e "${RED}✗ Test 3 FAILED${NC}"
  echo "Response: $RADA_RESPONSE" | head -20
fi
echo ""

# Test 4: Execute OpenReyestr tool (proxied) - only if service is available
echo -e "${YELLOW}Test 4: Execute OpenReyestr tool (proxied)${NC}"
OR_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  "$BASE_URL/api/tools/openreyestr_get_statistics" \
  -d '{"arguments": {}}' 2>&1)

OR_SUCCESS=$(echo "$OR_RESPONSE" | jq -r '.success // false' 2>/dev/null || echo "false")
OR_SERVICE=$(echo "$OR_RESPONSE" | jq -r '.service // "unknown"' 2>/dev/null || echo "unknown")

echo "Success: $OR_SUCCESS"
echo "Service: $OR_SERVICE"

if [ "$OR_SUCCESS" = "true" ] && [ "$OR_SERVICE" = "openreyestr" ]; then
  echo -e "${GREEN}✓ Test 4 PASSED${NC} - OpenReyestr tool proxied successfully"
elif echo "$OR_RESPONSE" | grep -q "not configured"; then
  echo -e "${YELLOW}⊘ Test 4 SKIPPED${NC} - OpenReyestr service not configured"
else
  echo -e "${RED}✗ Test 4 FAILED${NC}"
  echo "Response: $OR_RESPONSE" | head -20
fi
echo ""

# Test 5: Check gateway service counts
echo -e "${YELLOW}Test 5: Check service counts${NC}"
BACKEND_COUNT=$(echo "$TOOLS_RESPONSE" | jq -r '.gateway.services.backend // 0')
RADA_COUNT=$(echo "$TOOLS_RESPONSE" | jq -r '.gateway.services.rada // 0')
OR_COUNT=$(echo "$TOOLS_RESPONSE" | jq -r '.gateway.services.openreyestr // 0')

echo "Backend tools: $BACKEND_COUNT"
echo "RADA tools: $RADA_COUNT"
echo "OpenReyestr tools: $OR_COUNT"

if [ "$BACKEND_COUNT" -eq 36 ] && [ "$RADA_COUNT" -eq 4 ] && [ "$OR_COUNT" -eq 5 ]; then
  echo -e "${GREEN}✓ Test 5 PASSED${NC} - Service counts correct (36 + 4 + 5 = 45)"
else
  echo -e "${RED}✗ Test 5 FAILED${NC} - Expected 36/4/5, got $BACKEND_COUNT/$RADA_COUNT/$OR_COUNT"
fi
echo ""

# Summary
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo "Total tests: 5"
echo "Gateway URL: $BASE_URL"
echo ""
echo "Documentation: /home/vovkes/SecondLayer/docs/UNIFIED_GATEWAY_IMPLEMENTATION.md"
