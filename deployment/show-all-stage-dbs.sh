#!/bin/bash

# Script to show data from ALL stage database containers
# Supports: PostgreSQL, Redis, Qdrant
# Usage: ./show-all-stage-dbs.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Stage Databases Complete Overview${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# ============================================
# 1. PostgreSQL Databases
# ============================================
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║ 1. PostgreSQL (secondlayer-postgres-stage)${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

PG_CONTAINER="secondlayer-postgres-stage"
PG_USER="secondlayer"

if docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  # Get all databases
  DATABASES=$(docker exec $PG_CONTAINER psql -U $PG_USER -d postgres -t -c "
    SELECT datname FROM pg_database
    WHERE datistemplate = false
    AND datname != 'postgres'
    ORDER BY datname;
  " 2>/dev/null | grep -v '^$' | sed 's/^ *//g')

  if [ -n "$DATABASES" ]; then
    echo -e "${GREEN}Databases found:${NC}"
    echo "$DATABASES" | sed 's/^/  - /'
    echo ""

    # Process each database
    while IFS= read -r db_name; do
      echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      echo -e "${MAGENTA}Database: ${CYAN}${db_name}${NC}"
      echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

      # Show table summary
      docker exec $PG_CONTAINER psql -U $PG_USER -d $db_name -c "
        SELECT
          table_name,
          (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = t.table_name) as columns,
          (xpath('/row/cnt/text()', query_to_xml(format('SELECT COUNT(*) AS cnt FROM %I', table_name), false, true, '')))[1]::text::int AS rows
        FROM information_schema.tables t
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY rows DESC, table_name;
      " 2>/dev/null || echo "  (Could not fetch tables)"

      echo ""
    done <<< "$DATABASES"
  else
    echo -e "${YELLOW}No user databases found${NC}"
  fi
else
  echo -e "${RED}Container not found or not running${NC}"
fi

echo ""

# ============================================
# 2. Redis Cache
# ============================================
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║ 2. Redis (secondlayer-redis-stage)${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

REDIS_CONTAINER="secondlayer-redis-stage"

if docker ps --format '{{.Names}}' | grep -q "^${REDIS_CONTAINER}$"; then
  # Get Redis info
  echo -e "${GREEN}Redis Info:${NC}"
  docker exec $REDIS_CONTAINER redis-cli INFO stats | grep -E "total_commands_processed|total_connections_received|keyspace_hits|keyspace_misses" || true
  echo ""

  # Get database info
  echo -e "${GREEN}Databases:${NC}"
  docker exec $REDIS_CONTAINER redis-cli INFO keyspace || echo "  No keys found"
  echo ""

  # Get key count
  KEY_COUNT=$(docker exec $REDIS_CONTAINER redis-cli DBSIZE | grep -oE '[0-9]+')
  echo -e "${YELLOW}Total keys: ${KEY_COUNT}${NC}"
  echo ""

  if [ "$KEY_COUNT" -gt 0 ]; then
    # Sample keys by pattern
    echo -e "${CYAN}Sample keys (first 20):${NC}"
    docker exec $REDIS_CONTAINER redis-cli --scan --count 20 | head -20 | while read key; do
      TYPE=$(docker exec $REDIS_CONTAINER redis-cli TYPE "$key" | tr -d '\r')
      TTL=$(docker exec $REDIS_CONTAINER redis-cli TTL "$key" | tr -d '\r')

      if [ "$TTL" = "-1" ]; then
        TTL_STR="no expiry"
      elif [ "$TTL" = "-2" ]; then
        TTL_STR="expired"
      else
        TTL_STR="${TTL}s"
      fi

      echo -e "  ${CYAN}${key}${NC} (${YELLOW}${TYPE}${NC}, TTL: ${TTL_STR})"
    done
    echo ""

    # Group keys by pattern
    echo -e "${CYAN}Key patterns:${NC}"
    docker exec $REDIS_CONTAINER redis-cli --scan | sed 's/:.*//' | sort | uniq -c | sort -rn | head -10 | while read count pattern; do
      echo -e "  ${count} keys matching: ${CYAN}${pattern}:*${NC}"
    done
  fi
else
  echo -e "${RED}Container not found or not running${NC}"
fi

echo ""

# ============================================
# 3. Qdrant Vector Database
# ============================================
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║ 3. Qdrant (secondlayer-qdrant-stage)${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

QDRANT_CONTAINER="secondlayer-qdrant-stage"
QDRANT_PORT="6337"

if docker ps --format '{{.Names}}' | grep -q "^${QDRANT_CONTAINER}$"; then
  # Get collections via HTTP API
  echo -e "${GREEN}Collections:${NC}"

  COLLECTIONS=$(curl -s http://localhost:${QDRANT_PORT}/collections 2>/dev/null)

  if [ $? -eq 0 ] && [ -n "$COLLECTIONS" ]; then
    # Parse collection names and info
    echo "$COLLECTIONS" | docker exec -i $QDRANT_CONTAINER sh -c 'cat | grep -o "\"name\":\"[^\"]*\"" | cut -d\" -f4' | while read collection; do
      echo -e "  ${CYAN}Collection: ${collection}${NC}"

      # Get collection info
      COLLECTION_INFO=$(curl -s http://localhost:${QDRANT_PORT}/collections/${collection} 2>/dev/null)

      if [ $? -eq 0 ] && [ -n "$COLLECTION_INFO" ]; then
        VECTORS_COUNT=$(echo "$COLLECTION_INFO" | grep -o '"vectors_count":[0-9]*' | cut -d: -f2)
        POINTS_COUNT=$(echo "$COLLECTION_INFO" | grep -o '"points_count":[0-9]*' | cut -d: -f2)

        echo -e "    Points: ${YELLOW}${POINTS_COUNT:-0}${NC}"
        echo -e "    Vectors: ${YELLOW}${VECTORS_COUNT:-0}${NC}"
      fi
      echo ""
    done

    if [ -z "$(echo "$COLLECTIONS" | grep '"name"')" ]; then
      echo -e "  ${YELLOW}No collections found${NC}"
    fi
  else
    echo -e "  ${RED}Could not fetch collections (API might not be available)${NC}"
  fi
else
  echo -e "${RED}Container not found or not running${NC}"
fi

echo ""

# ============================================
# Summary
# ============================================
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Overview complete!${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Stage Database Services:${NC}"
echo -e "  1. PostgreSQL - Relational database (tables, rows)"
echo -e "  2. Redis      - Cache (key-value pairs)"
echo -e "  3. Qdrant     - Vector database (collections, points)"
echo ""
