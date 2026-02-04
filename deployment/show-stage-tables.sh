#!/bin/bash

# Script to show all tables and sample data from stage database
# Usage: ./show-stage-tables.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

CONTAINER="secondlayer-postgres-stage"
DB_USER="secondlayer"
DB_NAME="secondlayer_stage"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Stage Database Tables Overview${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${CYAN}Database: ${DB_NAME}${NC}"
echo -e "${CYAN}Container: ${CONTAINER}${NC}"
echo ""

# Get list of all tables
echo -e "${YELLOW}Fetching table list...${NC}"
TABLES=$(docker exec $CONTAINER psql -U $DB_USER -d $DB_NAME -t -c "
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  ORDER BY table_name;
" | grep -v '^$' | sed 's/^ *//g')

if [ -z "$TABLES" ]; then
  echo -e "${RED}No tables found!${NC}"
  exit 1
fi

# Count tables
TABLE_COUNT=$(echo "$TABLES" | wc -l)
echo -e "${GREEN}Found $TABLE_COUNT tables${NC}"
echo ""

# Loop through each table
CURRENT=0
while IFS= read -r table; do
  CURRENT=$((CURRENT + 1))

  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}[$CURRENT/$TABLE_COUNT] Table: ${CYAN}$table${NC}"
  echo -e "${BLUE}========================================${NC}"

  # Get row count
  ROW_COUNT=$(docker exec $CONTAINER psql -U $DB_USER -d $DB_NAME -t -c "SELECT COUNT(*) FROM \"$table\";" | tr -d ' ')
  echo -e "${YELLOW}Total rows: ${ROW_COUNT}${NC}"

  # Get column info
  echo -e "${YELLOW}Columns:${NC}"
  docker exec $CONTAINER psql -U $DB_USER -d $DB_NAME -c "
    SELECT
      column_name,
      data_type,
      CASE WHEN is_nullable = 'YES' THEN 'NULL' ELSE 'NOT NULL' END as nullable
    FROM information_schema.columns
    WHERE table_name = '$table'
    ORDER BY ordinal_position;
  " 2>/dev/null || echo "  (Could not fetch columns)"

  # Get sample data (first 3 rows)
  echo ""
  echo -e "${YELLOW}Sample data (first 3 rows):${NC}"

  if [ "$ROW_COUNT" -gt 0 ]; then
    docker exec $CONTAINER psql -U $DB_USER -d $DB_NAME -c "
      SELECT * FROM \"$table\" LIMIT 3;
    " 2>/dev/null || echo "  (Could not fetch sample data)"
  else
    echo -e "${CYAN}  (Table is empty)${NC}"
  fi

  echo ""
done <<< "$TABLES"

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✓ Overview complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${YELLOW}Summary:${NC}"
echo -e "  Database: $DB_NAME"
echo -e "  Total tables: $TABLE_COUNT"
echo ""
