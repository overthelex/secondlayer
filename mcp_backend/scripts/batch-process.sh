#!/bin/bash

# Batch processing script for existing documents
# Processes documents via HTTP API in batches

API_URL="http://localhost:3000/api"
API_KEY="test-key-123"
BATCH_SIZE=50
MAX_DOCS=1000

echo "🚀 Starting batch processing..."
echo ""

# Get documents without sections
DOCS=$(docker exec secondlayer-postgres psql -U secondlayer -d secondlayer_db -t -c "
  SELECT array_agg(zakononline_id)
  FROM (
    SELECT d.zakononline_id, MAX(d.created_at) as created_at
    FROM documents d
    LEFT JOIN document_sections ds ON d.id = ds.document_id
    WHERE d.full_text IS NOT NULL
      AND LENGTH(d.full_text) > 100
    GROUP BY d.zakononline_id
    HAVING COUNT(ds.id) = 0
    ORDER BY MAX(d.created_at) DESC
    LIMIT $MAX_DOCS
  ) sub
")

# Remove postgres array syntax
DOCS=$(echo "$DOCS" | sed 's/{//g' | sed 's/}//g' | tr -d ' ')

if [ -z "$DOCS" ] || [ "$DOCS" = "" ]; then
  echo "✅ All documents already processed!"
  exit 0
fi

# Convert to array
IFS=',' read -ra DOC_ARRAY <<< "$DOCS"
TOTAL=${#DOC_ARRAY[@]}

echo "📊 Found $TOTAL documents to process"
echo ""

PROCESSED=0
FAILED=0
SECTIONS=0
START_TIME=$(date +%s)

# Process in batches
for ((i=0; i<$TOTAL; i+=$BATCH_SIZE)); do
  BATCH=("${DOC_ARRAY[@]:i:$BATCH_SIZE}")
  BATCH_NUM=$((i/$BATCH_SIZE + 1))
  TOTAL_BATCHES=$(( ($TOTAL + $BATCH_SIZE - 1) / $BATCH_SIZE ))

  echo "📦 Batch $BATCH_NUM/$TOTAL_BATCHES (${#BATCH[@]} documents)"

  # Build JSON array
  DOC_IDS="["
  for doc in "${BATCH[@]}"; do
    DOC_IDS+="$doc,"
  done
  DOC_IDS="${DOC_IDS%,}]"  # Remove trailing comma

  # Load documents (this will auto-extract sections)
  RESPONSE=$(curl -s -X POST "$API_URL/tools/load_full_texts" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"doc_ids\": $DOC_IDS}")

  SUCCESS=$(echo "$RESPONSE" | jq -r '.success // false')

  if [ "$SUCCESS" = "true" ]; then
    PROCESSED_IN_BATCH=$(echo "$RESPONSE" | jq -r '.result.content[0].text | fromjson | .processed_docs // 0')
    PROCESSED=$((PROCESSED + PROCESSED_IN_BATCH))

    # Count sections for these docs
    for doc in "${BATCH[@]}"; do
      SECTIONS_COUNT=$(docker exec secondlayer-postgres psql -U secondlayer -d secondlayer_db -t -c "
        SELECT COUNT(*) FROM document_sections ds
        JOIN documents d ON ds.document_id = d.id
        WHERE d.zakononline_id = '$doc'
      " | tr -d ' ')

      if [ "$SECTIONS_COUNT" -gt 0 ]; then
        SECTIONS=$((SECTIONS + SECTIONS_COUNT))
        echo "   ✅ $doc: $SECTIONS_COUNT sections"
      else
        echo "   ⚠️  $doc: no sections"
      fi
    done
  else
    FAILED=$((FAILED + ${#BATCH[@]}))
    ERROR=$(echo "$RESPONSE" | jq -r '.result.content[0].text // "Unknown error"')
    echo "   ❌ Batch failed: $ERROR"
  fi

  # Progress
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))
  RATE=$(echo "scale=2; $PROCESSED / $ELAPSED" | bc)
  REMAINING=$((TOTAL - PROCESSED - FAILED))
  ETA=$(echo "scale=0; $REMAINING / $RATE" | bc)
  PROGRESS=$(echo "scale=0; 100 * ($PROCESSED + $FAILED) / $TOTAL" | bc)

  echo "   📈 Progress: $PROGRESS% | $PROCESSED/$TOTAL | $SECTIONS sections | ETA: ${ETA}s"
  echo ""

  # Small delay between batches
  sleep 2
done

# Final statistics
TOTAL_TIME=$(($(date +%s) - START_TIME))

echo ""
echo "✅ Processing complete!"
echo ""
echo "📊 Final Statistics:"
echo "   Processed: $PROCESSED"
echo "   Failed: $FAILED"
echo "   Sections created: $SECTIONS"
echo "   Total time: ${TOTAL_TIME}s"
echo "   Rate: $(echo "scale=2; $PROCESSED / $TOTAL_TIME" | bc) docs/sec"
echo ""
