#!/bin/bash
# Test script to verify MCP tool logging

set -e

echo "Testing MCP Tool Logging..."
echo "================================"

# Get API key from .env
API_KEY=$(grep SECONDARY_LAYER_KEYS .env | cut -d'=' -f2 | cut -d',' -f1)

if [ -z "$API_KEY" ]; then
  echo "ERROR: Could not find SECONDARY_LAYER_KEYS in .env"
  exit 1
fi

echo "Using API key: ${API_KEY:0:10}..."
echo ""

# Test 1: classify_intent
echo "Test 1: classify_intent"
echo "------------------------"
curl -s -X POST http://localhost:3003/api/tools/classify_intent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"query":"Чи можна оскаржити рішення суду?","budget":"standard"}' | jq -r '.content[0].text' | head -5

echo ""
echo "Checking logs for [MCP Tool] classify_intent..."
docker logs secondlayer-app-dev 2>&1 | grep "\[MCP Tool\] classify_intent" | tail -2
echo ""

# Test 2: search_legislation
echo "Test 2: search_legislation"
echo "------------------------"
curl -s -X POST http://localhost:3003/api/tools/search_legislation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"query":"позовна давність","limit":3}' | jq -r '.total_found // "No results"'

echo ""
echo "Checking logs for [MCP Tool] search_legislation..."
docker logs secondlayer-app-dev 2>&1 | grep "\[MCP Tool\] search_legislation" | tail -2
echo ""

# Test 3: Check general MCP tool execution logs
echo "Test 3: General MCP tool execution logs"
echo "----------------------------------------"
echo "All MCP tool calls in last 5 minutes:"
docker logs --since 5m secondlayer-app-dev 2>&1 | grep "\[MCP\]" | tail -10

echo ""
echo "================================"
echo "Logging test complete!"
echo ""
echo "To monitor logs in real-time:"
echo "  docker logs -f secondlayer-app-dev | grep '\[MCP'"
