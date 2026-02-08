#!/bin/bash

# Run RADA week data sync inside Docker container
# Usage: ./run-week-sync.sh [START_DATE] [END_DATE] [CONCURRENCY]

set -e

START_DATE="${1:-2026-01-20}"
END_DATE="${2:-2026-01-27}"
CONCURRENCY="${3:-5}"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}🚀 RADA Week Data Sync${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "📅 Date range:    ${START_DATE} to ${END_DATE}"
echo -e "🔀 Concurrency:   ${CONCURRENCY} parallel threads"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}\n"

# Check if rada-mcp-app container is running
if ! docker ps | grep -q "rada-mcp-app"; then
    echo -e "${RED}❌ Error: rada-mcp-app container is not running${NC}"
    echo -e "Start it with: cd mcp_rada && docker-compose up -d"
    exit 1
fi

echo -e "${GREEN}✓ Container rada-mcp-app is running${NC}\n"

# Copy the compiled script to container
echo -e "📦 Copying sync script to container...\n"
docker cp /home/vovkes/SecondLayer/mcp_rada/dist/scripts/sync-week-data.js rada-mcp-app:/app/dist/scripts/

# Run the sync script inside container
echo -e "🔄 Starting data synchronization...\n"
docker exec -e START_DATE="$START_DATE" \
            -e END_DATE="$END_DATE" \
            -e CONCURRENCY="$CONCURRENCY" \
            rada-mcp-app \
            node dist/scripts/sync-week-data.js

echo -e "\n${GREEN}✅ Sync completed!${NC}"
echo -e "\n${CYAN}💡 Check the results with:${NC}"
echo -e "   ./show-rada-data-for-date.sh ${END_DATE}\n"
