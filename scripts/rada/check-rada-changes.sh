#!/bin/bash

# Script to check RADA database changes for January 26, 2026
# Uses rada-mcp-app container and PostgreSQL

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
RADA_CONTAINER="rada-postgres"
RADA_DB="rada_db"
RADA_USER="rada_mcp"
TARGET_DATE="2026-01-26"
RADA_API_URL="http://localhost:3001"
RADA_API_KEY="test-key-123"

echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}    RADA Database Changes Report - ${TARGET_DATE}${NC}"
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
    docker exec "$RADA_CONTAINER" psql -U "$RADA_USER" -d "$RADA_DB" -t -A -c "$query"
}

# Function to execute SQL query with formatting
run_query_formatted() {
    local query="$1"
    docker exec "$RADA_CONTAINER" psql -U "$RADA_USER" -d "$RADA_DB" -c "$query"
}

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📊 SUMMARY OF CHANGES FOR ${TARGET_DATE}${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# 1. Check deputies
echo -e "${YELLOW}👥 DEPUTIES (Депутати):${NC}"
DEPUTIES_NEW=$(run_query "SELECT COUNT(*) FROM deputies WHERE DATE(created_at) = '${TARGET_DATE}'")
DEPUTIES_UPDATED=$(run_query "SELECT COUNT(*) FROM deputies WHERE DATE(updated_at) = '${TARGET_DATE}' AND DATE(created_at) != '${TARGET_DATE}'")
DEPUTIES_SYNCED=$(run_query "SELECT COUNT(*) FROM deputies WHERE DATE(last_synced) = '${TARGET_DATE}'")

echo -e "  New records:     ${GREEN}${DEPUTIES_NEW}${NC}"
echo -e "  Updated records: ${GREEN}${DEPUTIES_UPDATED}${NC}"
echo -e "  Synced records:  ${GREEN}${DEPUTIES_SYNCED}${NC}"

if [ "$DEPUTIES_NEW" -gt 0 ]; then
    echo -e "\n  ${CYAN}Sample of new deputies:${NC}"
    run_query_formatted "
        SELECT rada_id, short_name, faction_name, active
        FROM deputies
        WHERE DATE(created_at) = '${TARGET_DATE}'
        LIMIT 5;
    "
fi

# 2. Check bills
echo -e "\n${YELLOW}📄 BILLS (Законопроекти):${NC}"
BILLS_NEW=$(run_query "SELECT COUNT(*) FROM bills WHERE DATE(created_at) = '${TARGET_DATE}'")
BILLS_REGISTERED=$(run_query "SELECT COUNT(*) FROM bills WHERE DATE(registration_date) = '${TARGET_DATE}'")
BILLS_UPDATED=$(run_query "SELECT COUNT(*) FROM bills WHERE DATE(updated_at) = '${TARGET_DATE}' AND DATE(created_at) != '${TARGET_DATE}'")

echo -e "  New records:          ${GREEN}${BILLS_NEW}${NC}"
echo -e "  Registered on date:   ${GREEN}${BILLS_REGISTERED}${NC}"
echo -e "  Updated records:      ${GREEN}${BILLS_UPDATED}${NC}"

if [ "$BILLS_NEW" -gt 0 ]; then
    echo -e "\n  ${CYAN}Sample of new bills:${NC}"
    run_query_formatted "
        SELECT bill_number, LEFT(title, 60) as title, registration_date, status
        FROM bills
        WHERE DATE(created_at) = '${TARGET_DATE}'
        LIMIT 5;
    "
fi

# 3. Check legislation
echo -e "\n${YELLOW}⚖️  LEGISLATION (Законодавство):${NC}"
LEGISLATION_NEW=$(run_query "SELECT COUNT(*) FROM legislation WHERE DATE(created_at) = '${TARGET_DATE}'")
LEGISLATION_UPDATED=$(run_query "SELECT COUNT(*) FROM legislation WHERE DATE(updated_at) = '${TARGET_DATE}' AND DATE(created_at) != '${TARGET_DATE}'")

echo -e "  New records:     ${GREEN}${LEGISLATION_NEW}${NC}"
echo -e "  Updated records: ${GREEN}${LEGISLATION_UPDATED}${NC}"

if [ "$LEGISLATION_NEW" -gt 0 ]; then
    echo -e "\n  ${CYAN}New legislation:${NC}"
    run_query_formatted "
        SELECT law_number, LEFT(title, 60) as title, law_type
        FROM legislation
        WHERE DATE(created_at) = '${TARGET_DATE}';
    "
fi

# 4. Check voting records
echo -e "\n${YELLOW}🗳️  VOTING RECORDS (Голосування):${NC}"
VOTING_NEW=$(run_query "SELECT COUNT(*) FROM voting_records WHERE DATE(created_at) = '${TARGET_DATE}'")
VOTING_SESSION=$(run_query "SELECT COUNT(*) FROM voting_records WHERE session_date = '${TARGET_DATE}'")

echo -e "  New records:          ${GREEN}${VOTING_NEW}${NC}"
echo -e "  Sessions on date:     ${GREEN}${VOTING_SESSION}${NC}"

if [ "$VOTING_NEW" -gt 0 ]; then
    echo -e "\n  ${CYAN}Sample of voting records:${NC}"
    run_query_formatted "
        SELECT session_date, question_number, LEFT(question_text, 50) as question, result
        FROM voting_records
        WHERE DATE(created_at) = '${TARGET_DATE}'
        LIMIT 5;
    "
fi

# 5. Check committees (only has created_at, no updated_at)
echo -e "\n${YELLOW}🏛️  COMMITTEES (Комітети):${NC}"
COMMITTEES_NEW=$(run_query "SELECT COUNT(*) FROM committees WHERE DATE(created_at) = '${TARGET_DATE}'")

echo -e "  New records:     ${GREEN}${COMMITTEES_NEW}${NC}"

# 6. Check factions (only has created_at, no updated_at)
echo -e "\n${YELLOW}🎭 FACTIONS (Фракції):${NC}"
FACTIONS_NEW=$(run_query "SELECT COUNT(*) FROM factions WHERE DATE(created_at) = '${TARGET_DATE}'")

echo -e "  New records:     ${GREEN}${FACTIONS_NEW}${NC}"

# 7. Check deputy assistants
echo -e "\n${YELLOW}👔 DEPUTY ASSISTANTS (Помічники депутатів):${NC}"
ASSISTANTS_NEW=$(run_query "SELECT COUNT(*) FROM deputy_assistants WHERE DATE(created_at) = '${TARGET_DATE}'")

echo -e "  New records:     ${GREEN}${ASSISTANTS_NEW}${NC}"

# 8. Check cost tracking
echo -e "\n${YELLOW}💰 COST TRACKING (Відстеження витрат):${NC}"
COST_NEW=$(run_query "SELECT COUNT(*) FROM cost_tracking WHERE DATE(created_at) = '${TARGET_DATE}'")
COST_TOTAL=$(run_query "SELECT COALESCE(SUM(total_cost_usd), 0) FROM cost_tracking WHERE DATE(created_at) = '${TARGET_DATE}'")

echo -e "  API calls made:  ${GREEN}${COST_NEW}${NC}"
echo -e "  Total cost:      ${GREEN}\$${COST_TOTAL}${NC}"

if [ "$COST_NEW" -gt 0 ]; then
    echo -e "\n  ${CYAN}Most used tools:${NC}"
    run_query_formatted "
        SELECT tool_name, COUNT(*) as calls,
               ROUND(SUM(total_cost_usd)::numeric, 4) as total_cost
        FROM cost_tracking
        WHERE DATE(created_at) = '${TARGET_DATE}'
        GROUP BY tool_name
        ORDER BY calls DESC
        LIMIT 5;
    "
fi

# 9. Check cross-reference tables
echo -e "\n${YELLOW}🔗 CROSS-REFERENCE DATA (Перехресні посилання):${NC}"

DEPUTY_MENTIONS=$(run_query "SELECT COUNT(*) FROM deputy_court_mentions WHERE DATE(created_at) = '${TARGET_DATE}'")
echo -e "  Deputy court mentions:    ${GREEN}${DEPUTY_MENTIONS}${NC}"

BILL_IMPACT=$(run_query "SELECT COUNT(*) FROM bill_court_impact WHERE DATE(created_at) = '${TARGET_DATE}'")
echo -e "  Bill court impact:        ${GREEN}${BILL_IMPACT}${NC}"

LAW_CITATIONS=$(run_query "SELECT COUNT(*) FROM law_court_citations WHERE DATE(created_at) = '${TARGET_DATE}'")
echo -e "  Law court citations:      ${GREEN}${LAW_CITATIONS}${NC}"

# Summary totals
echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📈 TOTAL NEW RECORDS FOR ${TARGET_DATE}${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

TOTAL_NEW=$((DEPUTIES_NEW + BILLS_NEW + LEGISLATION_NEW + VOTING_NEW + COMMITTEES_NEW + FACTIONS_NEW + ASSISTANTS_NEW))
TOTAL_UPDATED=$((DEPUTIES_UPDATED + BILLS_UPDATED + LEGISLATION_UPDATED))

echo -e "  Total new records:      ${GREEN}${TOTAL_NEW}${NC}"
echo -e "  Total updated records:  ${GREEN}${TOTAL_UPDATED}${NC}"
echo -e "  API calls made:         ${GREEN}${COST_NEW}${NC}"
echo -e "  Total cost:             ${GREEN}\$${COST_TOTAL}${NC}"

# Check API health
echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}🔌 API STATUS CHECK${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Check RADA API health
if curl -s -f "${RADA_API_URL}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ RADA MCP API is responding${NC}"
    API_STATUS=$(curl -s "${RADA_API_URL}/health" | jq -r '.status // "unknown"' 2>/dev/null || echo "unknown")
    echo -e "  Status: ${API_STATUS}"
else
    echo -e "${RED}✗ RADA MCP API is not responding${NC}"
fi

# List available tools
echo -e "\n${CYAN}Available RADA MCP tools:${NC}"
TOOLS=$(curl -s -X POST "${RADA_API_URL}/api/tools" \
    -H "Authorization: Bearer ${RADA_API_KEY}" \
    -H "Content-Type: application/json" \
    2>/dev/null | jq -r '.tools[]?.name // empty' 2>/dev/null | head -10)

if [ -n "$TOOLS" ]; then
    echo "$TOOLS" | while read -r tool; do
        echo -e "  • ${tool}"
    done
else
    echo -e "  ${YELLOW}(Could not retrieve tool list)${NC}"
fi

# Database size info
echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}💾 DATABASE SIZE${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

run_query_formatted "
    SELECT
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
        pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
        pg_size_pretty(pg_indexes_size(schemaname||'.'||tablename)) AS indexes_size
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    LIMIT 10;
"

echo -e "\n${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Report completed successfully${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}\n"

# Optional: Export to file
if [ "$1" == "--save" ]; then
    OUTPUT_FILE="rada_changes_${TARGET_DATE}_$(date +%H%M%S).txt"
    echo -e "${YELLOW}💾 Saving report to ${OUTPUT_FILE}...${NC}"
    $0 > "$OUTPUT_FILE" 2>&1
    echo -e "${GREEN}✓ Report saved to ${OUTPUT_FILE}${NC}"
fi
