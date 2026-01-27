#!/bin/bash

# Import RADA JSON data into database
# Usage: ./import-rada-json.sh <path-to-json-file>

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <path-to-json-file>"
    echo ""
    echo "Examples:"
    echo "  $0 /home/vovkes/SecondLayer/RADA/mps_skl9.json"
    echo "  $0 /home/vovkes/SecondLayer/RADA/deputies.json"
    exit 1
fi

JSON_FILE="$1"
CONTAINER_NAME="rada-mcp-app"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}🇺🇦 RADA JSON Data Import${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "📂 Source file: $JSON_FILE"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}\n"

# Check if file exists
if [ ! -f "$JSON_FILE" ]; then
    echo -e "${RED}❌ Error: File not found: $JSON_FILE${NC}"
    exit 1
fi

echo -e "${GREEN}✓ File exists${NC}\n"

# Check if container is running
if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo -e "${RED}❌ Error: $CONTAINER_NAME container is not running${NC}"
    echo -e "Start it with: cd mcp_rada && docker-compose up -d"
    exit 1
fi

echo -e "${GREEN}✓ Container $CONTAINER_NAME is running${NC}\n"

# Copy JSON file to container
CONTAINER_JSON_PATH="/tmp/$(basename $JSON_FILE)"
echo -e "📦 Copying JSON file to container...\n"
docker cp "$JSON_FILE" "$CONTAINER_NAME:$CONTAINER_JSON_PATH"

# Copy import script to container
echo -e "📦 Copying import script to container...\n"
docker cp /home/vovkes/SecondLayer/mcp_rada/dist/scripts/import-json-data.js "$CONTAINER_NAME:/app/dist/scripts/"

# Run import in container
echo -e "🔄 Starting data import...\n"
docker exec "$CONTAINER_NAME" node /app/dist/scripts/import-json-data.js "$CONTAINER_JSON_PATH"

# Cleanup
docker exec "$CONTAINER_NAME" rm -f "$CONTAINER_JSON_PATH"

echo -e "\n${GREEN}✅ Import completed!${NC}"
echo -e "\n${CYAN}💡 Check the results with:${NC}"
echo -e "   ./show-rada-data-for-date.sh $(date +%Y-%m-%d)\n"
