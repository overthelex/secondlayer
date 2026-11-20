#!/usr/bin/env bash
# neo4j-load-instance-layer.sh  (LEXAI-2323) — run on cthulhu after neo4j-export-instance-layer.sh
#   bash neo4j-load-instance-layer.sh [EXPORT_DIR]
set -euo pipefail
DIR="${1:-./neo4j-export}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PG=secondlayer-postgres-local
PSQL="docker exec -i $PG psql -U secondlayer -d secondlayer_local -v ON_ERROR_STOP=1"
docker exec "$PG" rm -rf /tmp/neo4j-export
docker cp "$DIR" "$PG:/tmp/neo4j-export"
$PSQL -f - < "$HERE/neo4j-load-instance-layer.sql"
docker exec "$PG" rm -rf /tmp/neo4j-export
