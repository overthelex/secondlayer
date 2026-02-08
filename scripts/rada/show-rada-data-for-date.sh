#!/bin/bash

# Script to show detailed RADA data for a specific date
# Usage: ./show-rada-data-for-date.sh [YYYY-MM-DD]
# Default date: 2026-01-26

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Configuration
RADA_CONTAINER="rada-postgres"
RADA_DB="rada_db"
RADA_USER="rada_mcp"
TARGET_DATE="${1:-2026-01-26}"

echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}    RADA Data Report for ${TARGET_DATE}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}\n"

# Check if container is running
if ! docker ps | grep -q "$RADA_CONTAINER"; then
    echo -e "${RED}❌ Error: $RADA_CONTAINER container is not running${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Container $RADA_CONTAINER is running${NC}\n"

# Function to execute SQL query
run_query() {
    local query="$1"
    docker exec "$RADA_CONTAINER" psql -U "$RADA_USER" -d "$RADA_DB" -c "$query"
}

# Function to count records
count_records() {
    local query="$1"
    docker exec "$RADA_CONTAINER" psql -U "$RADA_USER" -d "$RADA_DB" -t -A -c "$query" | head -1
}

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📊 DATABASE OVERVIEW${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Total records in each table
echo -e "${YELLOW}Total records in database:${NC}\n"
run_query "
SELECT
    'Deputies' as table_name,
    COUNT(*) as total,
    COUNT(CASE WHEN DATE(created_at) = '${TARGET_DATE}' THEN 1 END) as created_on_date,
    COUNT(CASE WHEN DATE(last_synced) = '${TARGET_DATE}' THEN 1 END) as synced_on_date
FROM deputies
UNION ALL
SELECT
    'Bills',
    COUNT(*),
    COUNT(CASE WHEN DATE(created_at) = '${TARGET_DATE}' THEN 1 END),
    COUNT(CASE WHEN DATE(registration_date) = '${TARGET_DATE}' THEN 1 END)
FROM bills
UNION ALL
SELECT
    'Legislation',
    COUNT(*),
    COUNT(CASE WHEN DATE(created_at) = '${TARGET_DATE}' THEN 1 END),
    COUNT(CASE WHEN DATE(cached_at) = '${TARGET_DATE}' THEN 1 END)
FROM legislation
UNION ALL
SELECT
    'Voting Records',
    COUNT(*),
    COUNT(CASE WHEN DATE(created_at) = '${TARGET_DATE}' THEN 1 END),
    COUNT(CASE WHEN session_date = '${TARGET_DATE}' THEN 1 END)
FROM voting_records
UNION ALL
SELECT
    'Committees',
    COUNT(*),
    COUNT(CASE WHEN DATE(created_at) = '${TARGET_DATE}' THEN 1 END),
    0
FROM committees
UNION ALL
SELECT
    'Factions',
    COUNT(*),
    COUNT(CASE WHEN DATE(created_at) = '${TARGET_DATE}' THEN 1 END),
    0
FROM factions
ORDER BY table_name;
"

# Check if there's any data for the target date
DEPUTIES_COUNT=$(count_records "SELECT COUNT(*) FROM deputies WHERE DATE(created_at) = '${TARGET_DATE}' OR DATE(last_synced) = '${TARGET_DATE}'")
BILLS_COUNT=$(count_records "SELECT COUNT(*) FROM bills WHERE DATE(created_at) = '${TARGET_DATE}' OR DATE(registration_date) = '${TARGET_DATE}'")
LEGISLATION_COUNT=$(count_records "SELECT COUNT(*) FROM legislation WHERE DATE(created_at) = '${TARGET_DATE}' OR DATE(cached_at) = '${TARGET_DATE}'")
VOTING_COUNT=$(count_records "SELECT COUNT(*) FROM voting_records WHERE DATE(created_at) = '${TARGET_DATE}' OR session_date = '${TARGET_DATE}'")

TOTAL_FOR_DATE=$((DEPUTIES_COUNT + BILLS_COUNT + LEGISLATION_COUNT + VOTING_COUNT))

if [ "$TOTAL_FOR_DATE" -eq 0 ]; then
    echo -e "\n${YELLOW}⚠️  No data found for ${TARGET_DATE}${NC}\n"

    echo -e "${MAGENTA}Possible reasons:${NC}"
    echo -e "  1. Database hasn't been populated with RADA data yet"
    echo -e "  2. No parliament activities on this specific date"
    echo -e "  3. Data hasn't been synchronized from RADA Open Data API\n"

    echo -e "${CYAN}To populate the database, you need to:${NC}"
    echo -e "  1. Create a data sync script that calls RADA Open Data API directly"
    echo -e "  2. Or use the syncAllDeputies() method in DeputyService"
    echo -e "  3. The MCP tools (get_deputy_info, search_parliament_bills) only query the local database\n"
else
    echo -e "\n${GREEN}✓ Found ${TOTAL_FOR_DATE} records related to ${TARGET_DATE}${NC}\n"
fi

# Show deputies if any exist
if [ "$DEPUTIES_COUNT" -gt 0 ]; then
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}👥 DEPUTIES FOR ${TARGET_DATE}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    run_query "
    SELECT
        rada_id,
        short_name,
        faction_name,
        active,
        DATE(last_synced) as synced_date
    FROM deputies
    WHERE DATE(created_at) = '${TARGET_DATE}' OR DATE(last_synced) = '${TARGET_DATE}'
    ORDER BY short_name
    LIMIT 20;
    "
fi

# Show bills if any exist
if [ "$BILLS_COUNT" -gt 0 ]; then
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}📄 BILLS FOR ${TARGET_DATE}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    run_query "
    SELECT
        bill_number,
        LEFT(title, 60) as title,
        registration_date,
        status
    FROM bills
    WHERE DATE(created_at) = '${TARGET_DATE}' OR DATE(registration_date) = '${TARGET_DATE}'
    ORDER BY registration_date DESC
    LIMIT 20;
    "
fi

# Show legislation if any exists
if [ "$LEGISLATION_COUNT" -gt 0 ]; then
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}⚖️  LEGISLATION FOR ${TARGET_DATE}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    run_query "
    SELECT
        law_number,
        LEFT(title, 60) as title,
        law_type,
        DATE(cached_at) as cached_date
    FROM legislation
    WHERE DATE(created_at) = '${TARGET_DATE}' OR DATE(cached_at) = '${TARGET_DATE}'
    ORDER BY created_at;
    "
fi

# Show voting records if any exist
if [ "$VOTING_COUNT" -gt 0 ]; then
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}🗳️  VOTING RECORDS FOR ${TARGET_DATE}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    run_query "
    SELECT
        session_date,
        question_number,
        LEFT(question_text, 50) as question,
        result
    FROM voting_records
    WHERE DATE(created_at) = '${TARGET_DATE}' OR session_date = '${TARGET_DATE}'
    ORDER BY session_date DESC, question_number
    LIMIT 20;
    "
fi

# Show all existing legislation (as reference)
TOTAL_LEGISLATION=$(count_records "SELECT COUNT(*) FROM legislation")
if [ "$TOTAL_LEGISLATION" -gt 0 ]; then
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}📚 ALL LEGISLATION IN DATABASE (for reference)${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    run_query "
    SELECT
        law_number,
        LEFT(title, 70) as title,
        DATE(created_at) as added_to_db
    FROM legislation
    ORDER BY created_at;
    "
fi

# API usage for this date
echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}💰 API USAGE FOR ${TARGET_DATE}${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

run_query "
SELECT
    tool_name,
    COUNT(*) as calls,
    ROUND(SUM(total_cost_usd)::numeric, 6) as total_cost_usd,
    COUNT(CASE WHEN status = 'completed' AND error_message IS NULL THEN 1 END) as successful,
    COUNT(CASE WHEN error_message IS NOT NULL THEN 1 END) as errors
FROM cost_tracking
WHERE DATE(created_at) = '${TARGET_DATE}'
GROUP BY tool_name
ORDER BY calls DESC;
"

# Summary
echo -e "\n${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}📈 SUMMARY FOR ${TARGET_DATE}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}\n"

echo -e "  Deputies:           ${GREEN}${DEPUTIES_COUNT}${NC}"
echo -e "  Bills:              ${GREEN}${BILLS_COUNT}${NC}"
echo -e "  Legislation:        ${GREEN}${LEGISLATION_COUNT}${NC}"
echo -e "  Voting Records:     ${GREEN}${VOTING_COUNT}${NC}"
echo -e "  ${YELLOW}Total:              ${GREEN}${TOTAL_FOR_DATE}${NC}\n"

if [ "$TOTAL_FOR_DATE" -eq 0 ]; then
    echo -e "${YELLOW}💡 Tip: To populate the database with RADA data:${NC}"
    echo -e "   1. The database is currently empty or doesn't have data for this date"
    echo -e "   2. You need to implement initial data sync from RADA Open Data API"
    echo -e "   3. Or change the date to check when data actually exists in DB\n"
fi

echo -e "${GREEN}✓ Report completed${NC}\n"
