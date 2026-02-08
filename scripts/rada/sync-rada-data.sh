#!/bin/bash

# Script to sync RADA data for a specific date
# Usage: ./sync-rada-data.sh [YYYY-MM-DD]
# Default date: 2024-10-01 (known date with data)
# Uses RADA MCP API to fetch and store data

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
RADA_API_URL="http://localhost:3001"
RADA_API_KEY="test-key-123"

# Allow date parameter (default to a date with known data: Oct 1, 2024)
TARGET_DATE="${1:-2024-10-01}"
TARGET_DATE_FROM=$(date -d "$TARGET_DATE - 1 day" +%Y-%m-%d 2>/dev/null || echo "2024-09-30")

echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}    RADA Data Synchronization - ${TARGET_DATE}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}\n"

# Check if API is accessible
echo -e "${BLUE}Checking RADA MCP API...${NC}"
if ! curl -s -f "${RADA_API_URL}/health" > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: RADA MCP API is not accessible at ${RADA_API_URL}${NC}"
    echo -e "${YELLOW}Make sure rada-mcp-app container is running:${NC}"
    echo -e "  docker ps | grep rada-mcp"
    exit 1
fi

echo -e "${GREEN}✓ RADA MCP API is accessible${NC}\n"

# Function to call RADA MCP tool
call_tool() {
    local tool_name="$1"
    local args="$2"
    local description="$3"

    echo -e "${YELLOW}📡 Calling tool: ${tool_name}${NC}"
    [ -n "$description" ] && echo -e "   ${description}"

    local response=$(curl -s -X POST "${RADA_API_URL}/api/tools/${tool_name}" \
        -H "Authorization: Bearer ${RADA_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "${args}")

    # Check if request was successful
    if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
        local success=$(echo "$response" | jq -r '.success')
        if [ "$success" == "true" ]; then
            echo -e "${GREEN}✓ Success${NC}"
            echo "$response"
            return 0
        else
            echo -e "${RED}✗ Tool returned error${NC}"
            echo "$response" | jq -r '.result.content[0].text // .error // "Unknown error"'
            return 1
        fi
    else
        echo -e "${RED}✗ Failed${NC}"
        echo "$response" | jq -r '.error // .message // "Unknown error"'
        return 1
    fi
}

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}1️⃣  SYNCING PARLIAMENT BILLS (Законопроекти)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Search bills registered around the target date
echo -e "${CYAN}Searching bills registered on ${TARGET_DATE}...${NC}\n"

BILLS_RESPONSE=$(call_tool "search_parliament_bills" \
    "{\"query\": \"*\", \"date_from\": \"${TARGET_DATE}\", \"date_to\": \"${TARGET_DATE}\", \"limit\": 50}" \
    "Bills registered on ${TARGET_DATE}")

if [ $? -eq 0 ]; then
    BILLS_COUNT=$(echo "$BILLS_RESPONSE" | jq -r '.result.content[0].text' | jq -r '.total_found // 0' 2>/dev/null || echo "0")
    echo -e "${GREEN}Found ${BILLS_COUNT} bills registered on ${TARGET_DATE}${NC}\n"
else
    echo -e "${YELLOW}No bills found or error occurred${NC}\n"
fi

# Search recent bills (last 30 days)
echo -e "${CYAN}Searching recent bills (last 30 days for context)...${NC}\n"

RECENT_BILLS=$(call_tool "search_parliament_bills" \
    "{\"query\": \"*\", \"date_from\": \"2026-01-01\", \"limit\": 100}" \
    "Recent bills in January 2026")

echo -e "\n"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}2️⃣  SYNCING DEPUTY INFORMATION (Депутати)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Get info for several key deputies to populate the cache
DEPUTIES=("Стефанчук" "Шмигаль" "Федоров" "Арахамія" "Корнієнко")

for deputy in "${DEPUTIES[@]}"; do
    echo -e "${CYAN}Fetching deputy: ${deputy}...${NC}"

    DEPUTY_RESPONSE=$(call_tool "get_deputy_info" \
        "{\"name\": \"${deputy}\", \"include_assistants\": true, \"include_voting_record\": false}" \
        "Deputy info for ${deputy}")

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Deputy ${deputy} synced${NC}\n"
    else
        echo -e "${YELLOW}⚠ Could not fetch ${deputy}${NC}\n"
    fi

    # Small delay to avoid rate limiting
    sleep 1
done

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}3️⃣  SYNCING LEGISLATION (Законодавство)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Sync key legislation
LAWS=("constitution" "цпк" "кпк" "цивільний кодекс" "кримінальний кодекс")

for law in "${LAWS[@]}"; do
    echo -e "${CYAN}Fetching legislation: ${law}...${NC}"

    LAW_RESPONSE=$(call_tool "search_legislation_text" \
        "{\"law_identifier\": \"${law}\"}" \
        "Legislation: ${law}")

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Legislation ${law} synced${NC}\n"
    else
        echo -e "${YELLOW}⚠ Could not fetch ${law}${NC}\n"
    fi

    sleep 1
done

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}4️⃣  SYNCING VOTING RECORDS (Голосування)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Try to analyze voting records for key deputies
echo -e "${CYAN}Analyzing voting records for deputies on ${TARGET_DATE}...${NC}\n"

for deputy in "${DEPUTIES[@]}"; do
    echo -e "${CYAN}Voting analysis for: ${deputy}...${NC}"

    VOTING_RESPONSE=$(call_tool "analyze_voting_record" \
        "{\"deputy_name\": \"${deputy}\", \"date_from\": \"${TARGET_DATE}\", \"date_to\": \"${TARGET_DATE}\"}" \
        "Voting record for ${deputy} on ${TARGET_DATE}")

    if [ $? -eq 0 ]; then
        VOTES_COUNT=$(echo "$VOTING_RESPONSE" | jq -r '.result.content[0].text' | jq -r '.total_votes // 0' 2>/dev/null || echo "0")
        echo -e "${GREEN}✓ Found ${VOTES_COUNT} votes for ${deputy}${NC}\n"
    else
        echo -e "${YELLOW}⚠ No voting data for ${deputy} on ${TARGET_DATE}${NC}\n"
    fi

    sleep 1
done

# Summary
echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📊 SYNCHRONIZATION SUMMARY${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Check database for synchronized data
echo -e "${CYAN}Checking database records...${NC}\n"

docker exec rada-postgres psql -U rada_mcp -d rada_db -c "
SELECT
  'Deputies' as entity,
  COUNT(*) as total,
  COUNT(CASE WHEN DATE(last_synced) = '${TARGET_DATE}' THEN 1 END) as synced_today
FROM deputies
UNION ALL
SELECT
  'Bills',
  COUNT(*),
  COUNT(CASE WHEN DATE(cached_at) = '${TARGET_DATE}' THEN 1 END)
FROM bills
UNION ALL
SELECT
  'Legislation',
  COUNT(*),
  COUNT(CASE WHEN DATE(cached_at) = '${TARGET_DATE}' THEN 1 END)
FROM legislation
UNION ALL
SELECT
  'Voting Records',
  COUNT(*),
  COUNT(CASE WHEN DATE(created_at) = '${TARGET_DATE}' THEN 1 END)
FROM voting_records
UNION ALL
SELECT
  'Cost Tracking',
  COUNT(*),
  COUNT(CASE WHEN DATE(created_at) = '${TARGET_DATE}' THEN 1 END)
FROM cost_tracking
ORDER BY entity;
"

echo -e "\n${GREEN}✓ Data synchronization completed!${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}\n"

echo -e "${YELLOW}💡 Next steps:${NC}"
echo -e "   Run the changes report script:"
echo -e "   ${GREEN}./check-rada-changes.sh${NC}\n"
