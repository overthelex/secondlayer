#!/bin/bash

# Test document parsing on staging environment
# Tests Google Vision OCR integration with PDF, HTML, and DOCX files

set -e

STAGE_URL="https://stage.legal.org.ua"
API_KEY="${SECONDARY_LAYER_KEYS}"
TEST_DATA_DIR="/home/vovkes/SecondLayer/test_data"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Document Parsing Tests - STAGE Environment"
echo "=========================================="
echo "Stage URL: ${STAGE_URL}"
echo "Test files: ${TEST_DATA_DIR}"
echo ""

# Function to test document parsing
test_parse_document() {
    local file_path="$1"
    local mime_type="$2"
    local filename=$(basename "$file_path")

    echo -e "${YELLOW}Testing: ${filename}${NC}"
    echo "  MIME type: ${mime_type}"
    echo "  File size: $(du -h "$file_path" | cut -f1)"

    # Encode file to base64
    local file_base64=$(base64 -w 0 "$file_path")

    # Call parse_document API
    local start_time=$(date +%s%3N)

    local response=$(curl -s -X POST "${STAGE_URL}/api/tools/parse_document" \
        -H "Authorization: Bearer ${API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{
            \"fileBase64\": \"${file_base64}\",
            \"mimeType\": \"${mime_type}\",
            \"filename\": \"${filename}\"
        }")

    local end_time=$(date +%s%3N)
    local duration=$((end_time - start_time))

    # Check if successful
    local success=$(echo "$response" | jq -r '.success // false')

    if [ "$success" = "true" ]; then
        local text=$(echo "$response" | jq -r '.result.text // ""')
        local text_length=${#text}
        local word_count=$(echo "$text" | wc -w)

        echo -e "  ${GREEN}✓ SUCCESS${NC}"
        echo "  Duration: ${duration}ms"
        echo "  Text length: ${text_length} characters"
        echo "  Word count: ${word_count} words"

        # Show first 200 characters
        if [ ${text_length} -gt 0 ]; then
            echo "  Preview: ${text:0:200}..."
        fi

        # Check OCR info if available
        local ocr_used=$(echo "$response" | jq -r '.result.metadata.ocr_used // false')
        if [ "$ocr_used" = "true" ]; then
            echo -e "  ${YELLOW}📷 OCR used (Google Vision API)${NC}"
            local ocr_confidence=$(echo "$response" | jq -r '.result.metadata.ocr_confidence // "N/A"')
            echo "  OCR confidence: ${ocr_confidence}"
        fi

        return 0
    else
        local error=$(echo "$response" | jq -r '.error // "Unknown error"')
        echo -e "  ${RED}✗ FAILED${NC}"
        echo "  Error: ${error}"
        echo "  Duration: ${duration}ms"
        return 1
    fi
}

# Test counters
total_tests=0
passed_tests=0
failed_tests=0

echo "=========================================="
echo "TEST 1: HTML Document (Court Decision)"
echo "=========================================="
total_tests=$((total_tests + 1))
if test_parse_document \
    "${TEST_DATA_DIR}/1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.html" \
    "text/html"; then
    passed_tests=$((passed_tests + 1))
else
    failed_tests=$((failed_tests + 1))
fi
echo ""

echo "=========================================="
echo "TEST 2: PDF Document with OCR (Power of Attorney)"
echo "=========================================="
total_tests=$((total_tests + 1))
if test_parse_document \
    "${TEST_DATA_DIR}/2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.PDF" \
    "application/pdf"; then
    passed_tests=$((passed_tests + 1))
else
    failed_tests=$((failed_tests + 1))
fi
echo ""

echo "=========================================="
echo "TEST 3: DOCX Document (Official Letter)"
echo "=========================================="
total_tests=$((total_tests + 1))
if test_parse_document \
    "${TEST_DATA_DIR}/zo6NAJrqmQjM2qn3.docx" \
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; then
    passed_tests=$((passed_tests + 1))
else
    failed_tests=$((failed_tests + 1))
fi
echo ""

# Summary
echo "=========================================="
echo "TEST SUMMARY"
echo "=========================================="
echo "Total tests: ${total_tests}"
echo -e "Passed: ${GREEN}${passed_tests}${NC}"
echo -e "Failed: ${RED}${failed_tests}${NC}"
echo ""

if [ ${failed_tests} -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
