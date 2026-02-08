#!/bin/bash

# Test script for document-service container
# Tests parsing of HTML, PDF, and DOCX files

API_URL="http://localhost:3001"
TEST_DIR="test_data"

echo "==================================================="
echo "Testing Document Service Container"
echo "==================================================="
echo ""

# Test 1: HTML file
echo "📄 Test 1: Parsing HTML file"
echo "---------------------------------------------------"
HTML_FILE="$TEST_DIR/1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.html"
if [ -f "$HTML_FILE" ]; then
    HTML_BASE64=$(base64 -i "$HTML_FILE")

    RESPONSE=$(curl -s -X POST "$API_URL/api/parse-document" \
        -H "Content-Type: application/json" \
        -d "{
            \"fileBase64\": \"$HTML_BASE64\",
            \"mimeType\": \"text/html\",
            \"filename\": \"court-decision.html\"
        }")

    echo "Response:"
    echo "$RESPONSE" | jq -r '.text' | head -c 500
    echo ""
    echo "..."
    echo ""
    echo "Metadata:"
    echo "$RESPONSE" | jq '.metadata'
    echo ""
else
    echo "❌ File not found: $HTML_FILE"
fi

echo ""

# Test 2: PDF file
echo "📄 Test 2: Parsing PDF file"
echo "---------------------------------------------------"
PDF_FILE="$TEST_DIR/2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.PDF"
if [ -f "$PDF_FILE" ]; then
    PDF_BASE64=$(base64 -i "$PDF_FILE")

    RESPONSE=$(curl -s -X POST "$API_URL/api/parse-document" \
        -H "Content-Type: application/json" \
        -d "{
            \"fileBase64\": \"$PDF_BASE64\",
            \"mimeType\": \"application/pdf\",
            \"filename\": \"court-decision.pdf\"
        }")

    echo "Response:"
    echo "$RESPONSE" | jq -r '.text' | head -c 500
    echo ""
    echo "..."
    echo ""
    echo "Metadata:"
    echo "$RESPONSE" | jq '.metadata'
    echo ""
else
    echo "❌ File not found: $PDF_FILE"
fi

echo ""

# Test 3: DOCX file
echo "📄 Test 3: Parsing DOCX file"
echo "---------------------------------------------------"
DOCX_FILE="$TEST_DIR/zo6NAJrqmQjM2qn3.docx"
if [ -f "$DOCX_FILE" ]; then
    DOCX_BASE64=$(base64 -i "$DOCX_FILE")

    RESPONSE=$(curl -s -X POST "$API_URL/api/parse-document" \
        -H "Content-Type: application/json" \
        -d "{
            \"fileBase64\": \"$DOCX_BASE64\",
            \"mimeType\": \"application/vnd.openxmlformats-officedocument.wordprocessingml.document\",
            \"filename\": \"document.docx\"
        }")

    echo "Response:"
    echo "$RESPONSE" | jq -r '.text' | head -c 500
    echo ""
    echo "..."
    echo ""
    echo "Metadata:"
    echo "$RESPONSE" | jq '.metadata'
    echo ""
else
    echo "❌ File not found: $DOCX_FILE"
fi

echo ""
echo "==================================================="
echo "✅ All tests completed!"
echo "==================================================="
