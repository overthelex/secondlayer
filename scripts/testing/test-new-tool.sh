#!/bin/bash

# Quick test script for get_case_documents_chain tool
# Make sure the HTTP server is running on port 3000

API_KEY="${SECONDARY_LAYER_KEYS:-test-key-123}"
BASE_URL="${TEST_BASE_URL:-http://localhost:3000}"

echo "Testing get_case_documents_chain tool..."
echo "Base URL: $BASE_URL"
echo ""

# Test 1: Get all documents for case 756/655/23
echo "=== Test 1: Get all documents for case 756/655/23 ==="
curl -s -X POST "$BASE_URL/api/tools/get_case_documents_chain" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "case_number": "756/655/23",
    "include_full_text": false,
    "max_docs": 20,
    "group_by_instance": true
  }' | jq -r '.result.content[0].text' | jq .

echo ""
echo "=== Test 2: Get documents without grouping ==="
curl -s -X POST "$BASE_URL/api/tools/get_case_documents_chain" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "case_number": "756/655/23",
    "include_full_text": false,
    "max_docs": 10,
    "group_by_instance": false
  }' | jq -r '.result.content[0].text' | jq '.total_documents, .summary'

echo ""
echo "=== Test 3: Test error handling (missing case_number) ==="
curl -s -X POST "$BASE_URL/api/tools/get_case_documents_chain" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .

echo ""
echo "=== Done ==="
