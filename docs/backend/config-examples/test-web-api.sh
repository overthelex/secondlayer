#!/bin/bash

# SecondLayer MCP - Web API Test Script
# Використання: ./test-web-api.sh

BASE_URL="${API_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-test-key-123}"

echo "========================================="
echo "SecondLayer MCP - Web API Tests"
echo "========================================="
echo "Base URL: $BASE_URL"
echo "API Key: ${API_KEY:0:10}..."
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

function test_endpoint() {
    local name=$1
    local method=$2
    local endpoint=$3
    local data=$4

    echo -n "Testing: $name... "

    if [ "$method" == "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" \
            -H "Authorization: Bearer $API_KEY" \
            "$BASE_URL$endpoint")
    else
        response=$(curl -s -w "\n%{http_code}" \
            -X POST \
            -H "Authorization: Bearer $API_KEY" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$BASE_URL$endpoint")
    fi

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    if [ "$http_code" == "200" ]; then
        echo -e "${GREEN}✓ OK${NC} (HTTP $http_code)"
        return 0
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
        echo "Response: $body" | head -3
        return 1
    fi
}

# Test 1: Health check (no auth required)
echo "1. Health Check"
test_endpoint "Health endpoint" "GET" "/health"
echo ""

# Test 2: List tools
echo "2. MCP Tools"
test_endpoint "List tools" "GET" "/api/tools"
echo ""

# Test 3: Search precedents
echo "3. Search Legal Precedents"
test_endpoint "Search" "POST" "/api/tools/search_legal_precedents" \
    '{"query": "тестовий запит", "limit": 1}'
echo ""

# Test 4: Get similar reasoning
echo "4. Similar Reasoning"
test_endpoint "Similar reasoning" "POST" "/api/tools/get_similar_reasoning" \
    '{"reasoning_text": "суд вважає", "limit": 1}'
echo ""

# Test 5: Find law articles
echo "5. Law Articles"
test_endpoint "Find articles" "POST" "/api/tools/find_relevant_law_articles" \
    '{"topic": "мобілізація"}'
echo ""

# Summary
echo "========================================="
echo -e "${GREEN}All tests completed!${NC}"
echo ""
echo "Next steps:"
echo "1. Open web demo: open config-examples/web-client-demo.html"
echo "2. View API docs: curl $BASE_URL/api/tools | jq ."
echo "3. Check logs: tail -f logs/combined.log"
echo ""
