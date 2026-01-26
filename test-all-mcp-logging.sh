#!/bin/bash
# Comprehensive test for MCP tool logging

set -e

API_KEY=$(grep SECONDARY_LAYER_KEYS .env | cut -d'=' -f2 | cut -d',' -f1)

if [ -z "$API_KEY" ]; then
  echo "ERROR: Could not find SECONDARY_LAYER_KEYS in .env"
  exit 1
fi

echo "═══════════════════════════════════════════════════════════"
echo "  MCP Tool Logging Comprehensive Test"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Test 1: classify_intent
echo "Test 1: classify_intent"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s -X POST http://localhost:3003/api/tools/classify_intent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"query":"Як оскаржити рішення суду?","budget":"standard"}' > /dev/null

sleep 1
echo "Logs:"
docker logs --since 5s secondlayer-app-dev 2>&1 | grep "\[MCP" | tail -3
echo ""

# Test 2: get_court_decision
echo "Test 2: get_court_decision"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s -X POST http://localhost:3003/api/tools/get_court_decision \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"doc_id":"123456","depth":2,"reasoning_budget":"standard"}' > /dev/null

sleep 1
echo "Logs:"
docker logs --since 5s secondlayer-app-dev 2>&1 | grep "\[MCP" | tail -3
echo ""

# Test 3: search_supreme_court_practice
echo "Test 3: search_supreme_court_practice"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s -X POST http://localhost:3003/api/tools/search_supreme_court_practice \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"procedure_code":"cpc","query":"строк апеляції","limit":5,"court_level":"SC"}' > /dev/null

sleep 1
echo "Logs:"
docker logs --since 5s secondlayer-app-dev 2>&1 | grep "\[MCP" | tail -3
echo ""

# Test 4: Check cost tracking in database
echo "Test 4: Cost Tracking Database Records"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_db -c "
SELECT
  tool_name,
  status,
  duration_ms,
  openai_cost_usd,
  zakononline_calls,
  created_at
FROM cost_tracking
ORDER BY created_at DESC
LIMIT 5;
" 2>&1 | grep -v "rows)"
echo ""

# Summary
echo "═══════════════════════════════════════════════════════════"
echo "  Summary"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Log patterns to look for:"
echo "  - [MCP] Tool call initiated"
echo "  - [MCP Tool] <tool_name> started"
echo "  - [MCP] Tool call completed"
echo "  - [MCP] Tool call failed (if errors)"
echo ""
echo "All logs with timing information:"
docker logs --since 1m secondlayer-app-dev 2>&1 | grep "\[MCP.*duration" | tail -10
echo ""
echo "To monitor logs in real-time:"
echo "  docker logs -f secondlayer-app-dev | grep '\[MCP'"
