#!/bin/bash

# Test improved get_case_documents_chain with case 922/989/18

API_URL="http://localhost:3000"
API_KEY="${SECONDARY_LAYER_KEYS:-test-key-123}"

CASE_NUMBER="922/989/18"

echo "=== Testing improved get_case_documents_chain ==="
echo "Case number: ${CASE_NUMBER}"
echo "API URL: ${API_URL}"
echo ""

# Test the tool
curl -s -X POST "${API_URL}/api/tools/get_case_documents_chain" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"case_number\": \"${CASE_NUMBER}\",
    \"include_full_text\": false,
    \"max_docs\": 50,
    \"group_by_instance\": true
  }" | jq '
  {
    case_number: .result.case_number,
    total_documents: .result.total_documents,
    search_strategy: .result.search_strategy,
    summary: .result.summary,
    grouped_documents: (.result.grouped_documents | to_entries | map({
      instance: .key,
      count: (.value | length),
      documents: (.value | map({doc_id, date, document_type, court: (.court // "N/A")}))
    }))
  }
'

echo ""
echo "=== Test completed ==="
