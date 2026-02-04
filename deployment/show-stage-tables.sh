#!/bin/bash

# Script to show all tables and sample data from ALL stage databases
# Usage: ./show-stage-tables.sh [container_name]
#   If container_name is provided, shows only that container's databases
#   Otherwise, shows all stage PostgreSQL containers

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Stage Databases Overview${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Find all PostgreSQL stage containers
if [ -n "$1" ]; then
  CONTAINERS="$1"
  echo -e "${CYAN}Showing specific container: $1${NC}"
else
  # Find containers with both "postgres" AND "stage" in name
  CONTAINERS=$(docker ps --format '{{.Names}}' | grep postgres | grep stage)
  if [ -z "$CONTAINERS" ]; then
    echo -e "${RED}No stage PostgreSQL containers found!${NC}"
    exit 1
  fi
  echo -e "${CYAN}Found stage PostgreSQL containers:${NC}"
  echo "$CONTAINERS" | sed 's/^/  - /'
fi

echo ""

# Function to show tables for a specific database
show_database_tables() {
  local container=$1
  local db_user=$2
  local db_name=$3

  echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${MAGENTA}Database: ${CYAN}${db_name}${NC}"
  echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  # Get list of all tables
  TABLES=$(docker exec $container psql -U $db_user -d $db_name -t -c "
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  " 2>/dev/null | grep -v '^$' | sed 's/^ *//g')

  if [ -z "$TABLES" ]; then
    echo -e "${YELLOW}  No tables found in this database${NC}"
    echo ""
    return
  fi

  # Count tables
  TABLE_COUNT=$(echo "$TABLES" | wc -l)
  echo -e "${GREEN}  Found $TABLE_COUNT tables${NC}"
  echo ""

  # Show summary table
  echo -e "${YELLOW}  Tables summary:${NC}"
  docker exec $container psql -U $db_user -d $db_name -c "
    SELECT
      table_name,
      (SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t.table_name) as columns,
      (xpath('/row/cnt/text()', query_to_xml(format('SELECT COUNT(*) AS cnt FROM %I', table_name), false, true, '')))[1]::text::int AS rows
    FROM information_schema.tables t
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  " 2>/dev/null || echo "  (Could not fetch table summary)"

  echo ""

  # Ask if user wants detailed view
  if [ -t 0 ]; then  # Only ask if running interactively
    read -p "Show detailed view with sample data? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      return
    fi
  fi

  # Loop through each table for detailed view
  CURRENT=0
  while IFS= read -r table; do
    CURRENT=$((CURRENT + 1))

    echo -e "${BLUE}  ┌────────────────────────────────────┐${NC}"
    echo -e "${BLUE}  │ [$CURRENT/$TABLE_COUNT] Table: ${CYAN}$table${NC}"
    echo -e "${BLUE}  └────────────────────────────────────┘${NC}"

    # Get row count
    ROW_COUNT=$(docker exec $container psql -U $db_user -d $db_name -t -c "SELECT COUNT(*) FROM \"$table\";" 2>/dev/null | tr -d ' ')
    echo -e "${YELLOW}  Total rows: ${ROW_COUNT}${NC}"

    # Get column info
    echo -e "${YELLOW}  Columns:${NC}"
    docker exec $container psql -U $db_user -d $db_name -c "
      SELECT
        column_name,
        data_type,
        CASE WHEN is_nullable = 'YES' THEN 'NULL' ELSE 'NOT NULL' END as nullable
      FROM information_schema.columns
      WHERE table_name = '$table'
      ORDER BY ordinal_position;
    " 2>/dev/null | sed 's/^/    /' || echo "    (Could not fetch columns)"

    # Get sample data (first 3 rows)
    echo ""
    echo -e "${YELLOW}  Sample data (first 3 rows):${NC}"

    if [ "$ROW_COUNT" -gt 0 ]; then
      docker exec $container psql -U $db_user -d $db_name -c "
        SELECT * FROM \"$table\" LIMIT 3;
      " 2>/dev/null | sed 's/^/    /' || echo "    (Could not fetch sample data)"
    else
      echo -e "${CYAN}    (Table is empty)${NC}"
    fi

    echo ""
  done <<< "$TABLES"
}

# Process each container
while IFS= read -r container; do
  echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║ Container: ${CYAN}${container}${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
  echo ""

  # Determine database user
  DB_USER="secondlayer"

  # Get list of all databases (exclude templates and postgres system DB)
  DATABASES=$(docker exec $container psql -U $DB_USER -d postgres -t -c "
    SELECT datname FROM pg_database
    WHERE datistemplate = false
    AND datname != 'postgres'
    ORDER BY datname;
  " 2>/dev/null | grep -v '^$' | sed 's/^ *//g')

  if [ -z "$DATABASES" ]; then
    echo -e "${YELLOW}No user databases found in this container${NC}"
    echo ""
    continue
  fi

  echo -e "${GREEN}Databases in this container:${NC}"
  echo "$DATABASES" | sed 's/^/  - /'
  echo ""

  # Process each database
  while IFS= read -r db_name; do
    show_database_tables "$container" "$DB_USER" "$db_name"
  done <<< "$DATABASES"

  echo ""
done <<< "$CONTAINERS"

echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Overview complete!${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""
