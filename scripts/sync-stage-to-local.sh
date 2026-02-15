#!/bin/bash
##############################################################################
# sync-stage-to-local.sh
#
# Copies data from Stage environment to Local:
#   - PostgreSQL (backend + rada schema)
#   - PostgreSQL (openreyestr) — optional, include with --include-openreyestr
#   - Qdrant vector DB snapshots
#   - MinIO buckets — optional, include with --include-minio
#
# Default mode is INCREMENTAL (merge new data, skip existing):
#   - PG: restore into temp DB, merge with ON CONFLICT DO NOTHING
#   - Qdrant: skip collections with same point count
#   - MinIO: mc mirror without --overwrite
#
# Use --full for destructive replacement (old behavior):
#   - PG: drop + recreate databases
#   - Qdrant: delete + re-upload all collections
#   - MinIO: mc mirror --overwrite
#
# Usage:
#   ./scripts/sync-stage-to-local.sh [OPTIONS]
#
# Options:
#   --full               Full destructive sync (drop + recreate)
#   --skip-openreyestr   Skip OpenReyestr DB (default)
#   --include-openreyestr Include OpenReyestr DB
#   --include-minio      Also sync MinIO buckets
#   --pg-only            Only sync PostgreSQL databases
#   --qdrant-only        Only sync Qdrant collections
#   --dry-run            Show what would be done without executing
#   -y, --yes            Skip confirmation prompt
##############################################################################

set -euo pipefail

# ──────────────── Configuration ────────────────

STAGE_SERVER="gate.lexapp.co.ua"
STAGE_USER="vovkes"
STAGE_DEPLOY_DIR="/home/vovkes/SecondLayer/deployment"

LOCAL_DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../deployment" && pwd)"
DUMP_DIR="/tmp/secondlayer-sync-$$"
REMOTE_DUMP_DIR="/tmp/secondlayer-sync-export"

# Stage DB config (defaults from docker-compose.stage.yml)
STAGE_BACKEND_CONTAINER="secondlayer-postgres-stage"
STAGE_BACKEND_DB="secondlayer_stage"
STAGE_BACKEND_USER="secondlayer"

STAGE_OPENREYESTR_CONTAINER="openreyestr-postgres-stage"
STAGE_OPENREYESTR_DB="openreyestr_stage"
STAGE_OPENREYESTR_USER="openreyestr"

STAGE_QDRANT_CONTAINER="secondlayer-qdrant-stage"

# Local DB config (defaults from docker-compose.local.yml)
LOCAL_BACKEND_CONTAINER="secondlayer-postgres-local"
LOCAL_BACKEND_DB="secondlayer_local"
LOCAL_BACKEND_USER="secondlayer"

LOCAL_OPENREYESTR_CONTAINER="openreyestr-postgres-local"
LOCAL_OPENREYESTR_DB="openreyestr_local"
LOCAL_OPENREYESTR_USER="openreyestr"

LOCAL_QDRANT_CONTAINER="secondlayer-qdrant-local"

TEMP_DB_SUFFIX="_sync_tmp"

# ──────────────── Colors ────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ──────────────── Flags ────────────────

FULL_SYNC=false
SKIP_OPENREYESTR=true    # Skip by default (large DB, usually preloaded)
INCLUDE_MINIO=false
PG_ONLY=false
QDRANT_ONLY=false
DRY_RUN=false
AUTO_YES=false

# ──────────────── Stats counters ────────────────

STAT_PG_BACKEND_ROWS=0
STAT_PG_OPENREYESTR_ROWS=0
STAT_QDRANT_SYNCED=0
STAT_QDRANT_SKIPPED=0
STAT_MINIO_OBJECTS=0

# ──────────────── Parse args ────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --full) FULL_SYNC=true; shift ;;
    --skip-openreyestr) SKIP_OPENREYESTR=true; shift ;;
    --include-openreyestr) SKIP_OPENREYESTR=false; shift ;;
    --include-minio) INCLUDE_MINIO=true; shift ;;
    --pg-only) PG_ONLY=true; shift ;;
    --qdrant-only) QDRANT_ONLY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -y|--yes) AUTO_YES=true; shift ;;
    -h|--help)
      head -35 "$0" | tail -29
      exit 0
      ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

# ──────────────── Helpers ────────────────

msg()  { echo -e "${BLUE}=> $1${NC}"; }
ok()   { echo -e "${GREEN}   ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}   ⚠ $1${NC}"; }
err()  { echo -e "${RED}   ✗ $1${NC}"; }
stat() { echo -e "${CYAN}   → $1${NC}"; }

cleanup() {
  msg "Cleaning up temp files..."
  rm -rf "$DUMP_DIR" 2>/dev/null || true
  # Remote cleanup (best-effort)
  ssh -o ConnectTimeout=5 "${STAGE_USER}@${STAGE_SERVER}" \
    "rm -rf ${REMOTE_DUMP_DIR}" 2>/dev/null || true
  ok "Cleanup done"
}
trap cleanup EXIT

run() {
  if $DRY_RUN; then
    echo -e "${YELLOW}   [dry-run] $*${NC}"
    return 0
  fi
  "$@"
}

# ──────────────── PostgreSQL Functions ────────────────

# Incremental PG sync: dump → temp DB → merge into real DB
sync_pg_incremental() {
  local CONTAINER="$1"
  local DB_NAME="$2"
  local DB_USER="$3"
  local DUMP_FILE="$4"
  local LABEL="$5"
  local TEMP_DB="${DB_NAME}${TEMP_DB_SUFFIX}"

  msg "Incremental merge into ${DB_NAME}..."

  # Copy dump into container
  run docker cp "${DUMP_FILE}" "${CONTAINER}:/tmp/sync.dump"

  # Create temp DB + restore dump into it
  msg "Creating temp DB (${TEMP_DB}) and restoring dump..."
  run docker exec -i "$CONTAINER" bash -c "
    set -e
    # Drop temp DB if leftover from previous failed run
    dropdb -U ${DB_USER} --if-exists ${TEMP_DB}
    createdb -U ${DB_USER} ${TEMP_DB}
  "

  run docker exec "$CONTAINER" pg_restore \
    -U "$DB_USER" \
    -d "$TEMP_DB" \
    --no-owner \
    --no-privileges \
    /tmp/sync.dump 2>/dev/null || {
      # pg_restore exits non-zero on warnings; check tables exist
      TABLE_COUNT=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$TEMP_DB" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
      if [[ "$TABLE_COUNT" -gt 0 ]]; then
        warn "pg_restore had warnings but temp DB has ${TABLE_COUNT} tables — continuing"
      else
        err "pg_restore failed and temp DB is empty"
        docker exec "$CONTAINER" bash -c "dropdb -U ${DB_USER} --if-exists ${TEMP_DB}" 2>/dev/null || true
        return 1
      fi
    }
  ok "Temp DB restored"

  # Schema sync: dump schema from temp, apply to real (ignore errors for existing objects)
  msg "Syncing schema (new tables/columns)..."
  run docker exec "$CONTAINER" bash -c "
    pg_dump -U ${DB_USER} --schema-only --no-owner --no-privileges ${TEMP_DB} \
      | psql -U ${DB_USER} -d ${DB_NAME} -q 2>/dev/null || true
  "
  ok "Schema sync done"

  # Get list of all schemas to sync
  SCHEMAS=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$TEMP_DB" -tAc "
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  " | tr -d ' ')

  # Count rows before merge
  ROWS_BEFORE=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
    SELECT COALESCE(SUM(n_live_tup), 0) FROM pg_stat_user_tables
  " | tr -d ' ')

  # Data merge: dump data from temp with ON CONFLICT DO NOTHING, apply to real
  msg "Merging data (ON CONFLICT DO NOTHING)..."
  for schema in $SCHEMAS; do
    run docker exec "$CONTAINER" bash -c "
      pg_dump -U ${DB_USER} \
        --data-only \
        --schema=${schema} \
        --rows-per-insert=500 \
        --on-conflict-do-nothing \
        --disable-triggers \
        --no-owner \
        --no-privileges \
        ${TEMP_DB} \
        | psql -U ${DB_USER} -d ${DB_NAME} -q 2>/dev/null || true
    "
  done
  ok "Data merge done"

  # Count rows after merge
  ROWS_AFTER=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
    SELECT COALESCE(SUM(n_live_tup), 0) FROM pg_stat_user_tables
  " | tr -d ' ')

  ROWS_ADDED=$((ROWS_AFTER - ROWS_BEFORE))
  if [[ "$ROWS_ADDED" -gt 0 ]]; then
    stat "${ROWS_ADDED} new rows added to ${DB_NAME}"
  else
    stat "No new rows — ${DB_NAME} already up to date"
  fi

  # Fix sequences to max(id)
  msg "Fixing sequences..."
  run docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -q -c "
    DO \$\$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT
          s.relname AS seq_name,
          t.relname AS table_name,
          a.attname AS column_name
        FROM pg_class s
        JOIN pg_depend d ON d.objid = s.oid
        JOIN pg_class t ON d.refobjid = t.oid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE s.relkind = 'S'
      LOOP
        EXECUTE format(
          'SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 1))',
          r.seq_name, r.column_name, r.table_name
        );
      END LOOP;
    END
    \$\$;
  " 2>/dev/null || warn "Sequence fix had errors (non-critical)"
  ok "Sequences fixed"

  # Drop temp DB
  msg "Dropping temp DB..."
  run docker exec "$CONTAINER" bash -c "dropdb -U ${DB_USER} --if-exists ${TEMP_DB}"
  run docker exec "$CONTAINER" rm -f /tmp/sync.dump
  ok "${LABEL} incremental sync complete"

  echo "$ROWS_ADDED"
}

# Full PG sync: drop + recreate (old behavior)
sync_pg_full() {
  local CONTAINER="$1"
  local DB_NAME="$2"
  local DB_USER="$3"
  local DUMP_FILE="$4"
  local LABEL="$5"

  msg "Full replacement of ${DB_NAME}..."

  run docker exec -i "$CONTAINER" bash -c "
    # Terminate existing connections
    psql -U ${DB_USER} -d postgres -c \"
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();
    \" 2>/dev/null || true

    # Drop and recreate
    dropdb -U ${DB_USER} --if-exists ${DB_NAME}
    createdb -U ${DB_USER} ${DB_NAME}

    # Create rada_mcp role if missing (backend only)
    psql -U ${DB_USER} -d postgres -c \"
      DO \\\$\\\$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rada_mcp') THEN
          CREATE ROLE rada_mcp WITH LOGIN PASSWORD 'rada_password';
        END IF;
      END
      \\\$\\\$;
    \" 2>/dev/null || true
  "

  run docker cp "${DUMP_FILE}" "${CONTAINER}:/tmp/sync.dump"
  run docker exec "$CONTAINER" pg_restore \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    /tmp/sync.dump || {
      TABLE_COUNT=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
      if [[ "$TABLE_COUNT" -gt 0 ]]; then
        warn "pg_restore had warnings but DB has ${TABLE_COUNT} tables — continuing"
      else
        err "pg_restore failed and DB is empty"
        exit 1
      fi
    }
  run docker exec "$CONTAINER" rm -f /tmp/sync.dump
  ok "${LABEL} DB restored (${DB_NAME})"
}

# ──────────────── Pre-flight ────────────────

msg "Pre-flight checks..."

# SSH connectivity
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "${STAGE_USER}@${STAGE_SERVER}" "echo ok" &>/dev/null; then
  err "Cannot SSH to ${STAGE_SERVER}. Check your SSH keys."
  exit 1
fi
ok "SSH to ${STAGE_SERVER}"

# Local Docker containers running
for container in "$LOCAL_BACKEND_CONTAINER" "$LOCAL_QDRANT_CONTAINER"; do
  if ! docker inspect --format='{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
    err "Local container $container is not running. Start with: cd deployment && ./manage-gateway.sh start local"
    exit 1
  fi
done
ok "Local containers running"

if ! $SKIP_OPENREYESTR; then
  if ! docker inspect --format='{{.State.Running}}' "$LOCAL_OPENREYESTR_CONTAINER" 2>/dev/null | grep -q true; then
    err "Local container $LOCAL_OPENREYESTR_CONTAINER is not running"
    exit 1
  fi
  ok "OpenReyestr container running"
fi

# ──────────────── Summary ────────────────

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Stage → Local Data Sync                 ║${NC}"
echo -e "${BLUE}╠══════════════════════════════════════════╣${NC}"

if $FULL_SYNC; then
  echo -e "${BLUE}║${NC}  Mode                      ${RED}FULL${NC}           ${BLUE}║${NC}"
else
  echo -e "${BLUE}║${NC}  Mode                      ${GREEN}INCREMENTAL${NC}    ${BLUE}║${NC}"
fi

if ! $QDRANT_ONLY; then
  echo -e "${BLUE}║${NC}  PostgreSQL (backend+rada)  ${GREEN}YES${NC}            ${BLUE}║${NC}"
  if $SKIP_OPENREYESTR; then
    echo -e "${BLUE}║${NC}  PostgreSQL (openreyestr)   ${YELLOW}SKIP${NC}           ${BLUE}║${NC}"
  else
    echo -e "${BLUE}║${NC}  PostgreSQL (openreyestr)   ${GREEN}YES${NC}            ${BLUE}║${NC}"
  fi
fi

if ! $PG_ONLY; then
  echo -e "${BLUE}║${NC}  Qdrant vector DB           ${GREEN}YES${NC}            ${BLUE}║${NC}"
fi

if $INCLUDE_MINIO; then
  echo -e "${BLUE}║${NC}  MinIO buckets              ${GREEN}YES${NC}            ${BLUE}║${NC}"
else
  echo -e "${BLUE}║${NC}  MinIO buckets              ${YELLOW}SKIP${NC}           ${BLUE}║${NC}"
fi

echo -e "${BLUE}║${NC}  Redis cache                ${YELLOW}SKIP${NC} (regen)   ${BLUE}║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

if $DRY_RUN; then
  warn "DRY RUN — no changes will be made"
  echo ""
fi

if ! $AUTO_YES && ! $DRY_RUN; then
  if $FULL_SYNC; then
    read -p "Proceed? Local data will be REPLACED (full sync). [y/N] " confirm
  else
    read -p "Proceed? New data will be MERGED (incremental). [y/N] " confirm
  fi
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

mkdir -p "$DUMP_DIR"

# ═══════════════════════════════════════════
# STEP 1: PostgreSQL
# ═══════════════════════════════════════════

if ! $QDRANT_ONLY; then

  # ── 1a. Backend + RADA DB ──

  msg "Dumping backend DB on stage (${STAGE_BACKEND_DB})..."
  run ssh "${STAGE_USER}@${STAGE_SERVER}" bash -c "'
    set -e
    mkdir -p ${REMOTE_DUMP_DIR}
    docker exec ${STAGE_BACKEND_CONTAINER} pg_dump \
      -U ${STAGE_BACKEND_USER} \
      -Fc \
      --no-owner \
      --no-privileges \
      ${STAGE_BACKEND_DB} > ${REMOTE_DUMP_DIR}/backend.dump
    echo \"SIZE: \$(du -h ${REMOTE_DUMP_DIR}/backend.dump | cut -f1)\"
  '"
  ok "Backend dump created"

  msg "Transferring backend dump..."
  run rsync -ahP --compress \
    "${STAGE_USER}@${STAGE_SERVER}:${REMOTE_DUMP_DIR}/backend.dump" \
    "${DUMP_DIR}/backend.dump"
  ok "Backend dump transferred"

  if $FULL_SYNC; then
    # Full mode: stop containers, drop+recreate, restore
    msg "Stopping local app containers..."
    run docker stop secondlayer-app-local rada-mcp-app-local 2>/dev/null || true

    sync_pg_full "$LOCAL_BACKEND_CONTAINER" "$LOCAL_BACKEND_DB" "$LOCAL_BACKEND_USER" \
      "${DUMP_DIR}/backend.dump" "Backend"

    # Grant rada_mcp access
    run docker exec "$LOCAL_BACKEND_CONTAINER" psql -U "$LOCAL_BACKEND_USER" -d "$LOCAL_BACKEND_DB" -c "
      GRANT USAGE ON SCHEMA rada TO rada_mcp;
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA rada TO rada_mcp;
      GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA rada TO rada_mcp;
      ALTER DEFAULT PRIVILEGES IN SCHEMA rada GRANT ALL ON TABLES TO rada_mcp;
      ALTER DEFAULT PRIVILEGES IN SCHEMA rada GRANT ALL ON SEQUENCES TO rada_mcp;
    " 2>/dev/null || warn "RADA schema grants — schema may not exist yet"
  else
    # Incremental mode: merge via temp DB
    # Ensure rada_mcp role exists before merge (schema sync may reference it)
    run docker exec "$LOCAL_BACKEND_CONTAINER" psql -U "$LOCAL_BACKEND_USER" -d postgres -c "
      DO \$\$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rada_mcp') THEN
          CREATE ROLE rada_mcp WITH LOGIN PASSWORD 'rada_password';
        END IF;
      END
      \$\$;
    " 2>/dev/null || true

    STAT_PG_BACKEND_ROWS=$(sync_pg_incremental "$LOCAL_BACKEND_CONTAINER" "$LOCAL_BACKEND_DB" \
      "$LOCAL_BACKEND_USER" "${DUMP_DIR}/backend.dump" "Backend")

    # Grant rada_mcp access
    run docker exec "$LOCAL_BACKEND_CONTAINER" psql -U "$LOCAL_BACKEND_USER" -d "$LOCAL_BACKEND_DB" -c "
      GRANT USAGE ON SCHEMA rada TO rada_mcp;
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA rada TO rada_mcp;
      GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA rada TO rada_mcp;
      ALTER DEFAULT PRIVILEGES IN SCHEMA rada GRANT ALL ON TABLES TO rada_mcp;
      ALTER DEFAULT PRIVILEGES IN SCHEMA rada GRANT ALL ON SEQUENCES TO rada_mcp;
    " 2>/dev/null || warn "RADA schema grants — schema may not exist yet"
  fi

  # ── 1b. OpenReyestr DB (optional) ──

  if ! $SKIP_OPENREYESTR; then
    msg "Dumping openreyestr DB on stage (${STAGE_OPENREYESTR_DB})..."
    run ssh "${STAGE_USER}@${STAGE_SERVER}" bash -c "'
      set -e
      docker exec ${STAGE_OPENREYESTR_CONTAINER} pg_dump \
        -U ${STAGE_OPENREYESTR_USER} \
        -Fc \
        --no-owner \
        --no-privileges \
        ${STAGE_OPENREYESTR_DB} > ${REMOTE_DUMP_DIR}/openreyestr.dump
      echo \"SIZE: \$(du -h ${REMOTE_DUMP_DIR}/openreyestr.dump | cut -f1)\"
    '"
    ok "OpenReyestr dump created"

    msg "Transferring openreyestr dump..."
    run rsync -ahP --compress \
      "${STAGE_USER}@${STAGE_SERVER}:${REMOTE_DUMP_DIR}/openreyestr.dump" \
      "${DUMP_DIR}/openreyestr.dump"
    ok "OpenReyestr dump transferred"

    if $FULL_SYNC; then
      run docker stop openreyestr-app-local 2>/dev/null || true
      sync_pg_full "$LOCAL_OPENREYESTR_CONTAINER" "$LOCAL_OPENREYESTR_DB" \
        "$LOCAL_OPENREYESTR_USER" "${DUMP_DIR}/openreyestr.dump" "OpenReyestr"
    else
      STAT_PG_OPENREYESTR_ROWS=$(sync_pg_incremental "$LOCAL_OPENREYESTR_CONTAINER" \
        "$LOCAL_OPENREYESTR_DB" "$LOCAL_OPENREYESTR_USER" \
        "${DUMP_DIR}/openreyestr.dump" "OpenReyestr")
    fi
  fi
fi

# ═══════════════════════════════════════════
# STEP 2: Qdrant
# ═══════════════════════════════════════════

if ! $PG_ONLY; then

  msg "Checking Qdrant collections..."

  # Get stage collections with point counts
  STAGE_COLLECTIONS_JSON=$(ssh "${STAGE_USER}@${STAGE_SERVER}" \
    "curl -sf http://localhost:6337/collections" 2>/dev/null) || { err "Failed to list stage Qdrant collections"; STAGE_COLLECTIONS_JSON=""; }

  if [[ -z "$STAGE_COLLECTIONS_JSON" ]]; then
    warn "No Qdrant collections found on stage — skipping"
  else
    STAGE_COLLECTIONS=$(echo "$STAGE_COLLECTIONS_JSON" | python3 -c \
      'import sys,json; [print(c["name"]) for c in json.load(sys.stdin)["result"]["collections"]]' 2>/dev/null) || STAGE_COLLECTIONS=""

    if [[ -z "$STAGE_COLLECTIONS" ]]; then
      warn "No Qdrant collections found on stage — skipping"
    else
      ok "Stage collections: $(echo $STAGE_COLLECTIONS | tr '\n' ' ')"

      # Get local collections with point counts
      LOCAL_COLLECTIONS_JSON=$(curl -sf http://localhost:6333/collections 2>/dev/null) || LOCAL_COLLECTIONS_JSON='{"result":{"collections":[]}}'

      for collection in $STAGE_COLLECTIONS; do
        # Get stage point count
        STAGE_INFO=$(ssh "${STAGE_USER}@${STAGE_SERVER}" \
          "curl -sf http://localhost:6337/collections/${collection}" 2>/dev/null) || { err "Failed to get info for ${collection} on stage"; continue; }
        STAGE_POINTS=$(echo "$STAGE_INFO" | python3 -c \
          'import sys,json; print(json.load(sys.stdin)["result"]["points_count"])' 2>/dev/null) || STAGE_POINTS=0

        # Get local point count
        LOCAL_INFO=$(curl -sf "http://localhost:6333/collections/${collection}" 2>/dev/null) || LOCAL_INFO=""
        if [[ -n "$LOCAL_INFO" ]]; then
          LOCAL_POINTS=$(echo "$LOCAL_INFO" | python3 -c \
            'import sys,json; print(json.load(sys.stdin)["result"]["points_count"])' 2>/dev/null) || LOCAL_POINTS=0
        else
          LOCAL_POINTS=-1  # Collection doesn't exist locally
        fi

        # Decide whether to sync
        SHOULD_SYNC=false
        if [[ "$LOCAL_POINTS" -eq -1 ]]; then
          stat "${collection}: missing locally (stage has ${STAGE_POINTS} points) — will sync"
          SHOULD_SYNC=true
        elif [[ "$STAGE_POINTS" -gt "$LOCAL_POINTS" ]] && ! $FULL_SYNC; then
          stat "${collection}: stage has more points (${STAGE_POINTS} vs ${LOCAL_POINTS}) — will sync"
          SHOULD_SYNC=true
        elif [[ "$STAGE_POINTS" -eq "$LOCAL_POINTS" ]] && ! $FULL_SYNC; then
          stat "${collection}: same point count (${LOCAL_POINTS}) — skipping"
          STAT_QDRANT_SKIPPED=$((STAT_QDRANT_SKIPPED + 1))
          continue
        elif [[ "$STAGE_POINTS" -lt "$LOCAL_POINTS" ]] && ! $FULL_SYNC; then
          stat "${collection}: local has more points (${LOCAL_POINTS} vs ${STAGE_POINTS}) — skipping"
          STAT_QDRANT_SKIPPED=$((STAT_QDRANT_SKIPPED + 1))
          continue
        elif $FULL_SYNC; then
          stat "${collection}: full sync — will replace (${STAGE_POINTS} points)"
          SHOULD_SYNC=true
        fi

        if ! $SHOULD_SYNC; then
          continue
        fi

        msg "Snapshotting collection: ${collection}..."

        # Create snapshot on stage Qdrant
        SNAPSHOT_NAME=$(run ssh "${STAGE_USER}@${STAGE_SERVER}" \
          "curl -sf -X POST http://localhost:6337/collections/${collection}/snapshots | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"result\"][\"name\"])'" \
        ) || { err "Failed to snapshot ${collection}"; continue; }
        ok "Snapshot created: ${SNAPSHOT_NAME}"

        # Download snapshot from stage
        msg "Transferring snapshot ${collection}..."
        run ssh "${STAGE_USER}@${STAGE_SERVER}" \
          "curl -sf http://localhost:6337/collections/${collection}/snapshots/${SNAPSHOT_NAME} -o ${REMOTE_DUMP_DIR}/${collection}.snapshot"
        run rsync -ahP --compress \
          "${STAGE_USER}@${STAGE_SERVER}:${REMOTE_DUMP_DIR}/${collection}.snapshot" \
          "${DUMP_DIR}/${collection}.snapshot"
        ok "Snapshot transferred: $(du -h "${DUMP_DIR}/${collection}.snapshot" 2>/dev/null | cut -f1)"

        # Delete remote snapshot to save space
        run ssh "${STAGE_USER}@${STAGE_SERVER}" \
          "curl -sf -X DELETE http://localhost:6337/collections/${collection}/snapshots/${SNAPSHOT_NAME} >/dev/null" || true

        # Restore to local Qdrant (delete existing collection first)
        msg "Restoring collection ${collection} locally..."
        run curl -sf -X DELETE "http://localhost:6333/collections/${collection}" >/dev/null 2>&1 || true

        run curl -sf -X POST "http://localhost:6333/collections/${collection}/snapshots/upload?priority=snapshot" \
          -H "Content-Type: multipart/form-data" \
          -F "snapshot=@${DUMP_DIR}/${collection}.snapshot" >/dev/null
        ok "Collection ${collection} restored locally"

        STAT_QDRANT_SYNCED=$((STAT_QDRANT_SYNCED + 1))

        # Clean up snapshot file to save disk space
        rm -f "${DUMP_DIR}/${collection}.snapshot"
      done

      ok "Qdrant sync complete (${STAT_QDRANT_SYNCED} synced, ${STAT_QDRANT_SKIPPED} skipped)"
    fi
  fi
fi

# ═══════════════════════════════════════════
# STEP 3: MinIO (optional)
# ═══════════════════════════════════════════

if $INCLUDE_MINIO; then
  msg "Syncing MinIO buckets..."

  # Check if mc (MinIO client) is installed
  if ! command -v mc &>/dev/null; then
    warn "MinIO client (mc) not installed. Install: curl -O https://dl.min.io/client/mc/release/linux-amd64/mc && chmod +x mc && sudo mv mc /usr/local/bin/"
    warn "Skipping MinIO sync"
  else
    # Set up SSH tunnel for stage MinIO (bound to 127.0.0.1)
    msg "Opening SSH tunnel to stage MinIO..."
    ssh -f -N -L 19000:127.0.0.1:9004 "${STAGE_USER}@${STAGE_SERVER}"
    TUNNEL_PID=$!

    # Wait for tunnel
    sleep 2

    # Read stage MinIO credentials from .env.stage
    STAGE_MINIO_KEY=$(ssh "${STAGE_USER}@${STAGE_SERVER}" \
      "grep MINIO_ROOT_USER ${STAGE_DEPLOY_DIR}/.env.stage | cut -d= -f2" 2>/dev/null) || STAGE_MINIO_KEY=""
    STAGE_MINIO_SECRET=$(ssh "${STAGE_USER}@${STAGE_SERVER}" \
      "grep MINIO_ROOT_PASSWORD ${STAGE_DEPLOY_DIR}/.env.stage | cut -d= -f2" 2>/dev/null) || STAGE_MINIO_SECRET=""

    if [[ -z "$STAGE_MINIO_KEY" || -z "$STAGE_MINIO_SECRET" ]]; then
      warn "Could not read stage MinIO credentials — skipping"
    else
      run mc alias set stage-sync http://localhost:19000 "$STAGE_MINIO_KEY" "$STAGE_MINIO_SECRET" --api S3v4 2>/dev/null
      run mc alias set local-sync http://localhost:9000 minioadmin minioadmin --api S3v4 2>/dev/null

      # List and mirror all buckets
      BUCKETS=$(mc ls stage-sync/ 2>/dev/null | awk '{print $NF}' | tr -d '/') || BUCKETS=""
      for bucket in $BUCKETS; do
        msg "Mirroring bucket: ${bucket}..."
        run mc mb --ignore-existing "local-sync/${bucket}" 2>/dev/null || true
        if $FULL_SYNC; then
          run mc mirror --overwrite "stage-sync/${bucket}" "local-sync/${bucket}"
        else
          # Incremental: only copy objects that don't exist locally
          run mc mirror "stage-sync/${bucket}" "local-sync/${bucket}"
        fi
        ok "Bucket ${bucket} synced"
      done
    fi

    # Close tunnel
    kill "$TUNNEL_PID" 2>/dev/null || true
    ok "MinIO sync complete"
  fi
fi

# ═══════════════════════════════════════════
# STEP 4: Restart local app containers (full mode only)
# ═══════════════════════════════════════════

if $FULL_SYNC; then
  msg "Restarting local app containers..."
  run docker start secondlayer-app-local rada-mcp-app-local 2>/dev/null || true
  if ! $SKIP_OPENREYESTR; then
    run docker start openreyestr-app-local 2>/dev/null || true
  fi

  # Wait for health
  msg "Waiting for containers to become healthy..."
  HEALTHY="starting"
  for i in $(seq 1 30); do
    HEALTHY=$(docker inspect --format='{{.State.Health.Status}}' secondlayer-app-local 2>/dev/null || echo "starting")
    if [[ "$HEALTHY" == "healthy" ]]; then
      break
    fi
    sleep 2
  done

  if [[ "$HEALTHY" == "healthy" ]]; then
    ok "secondlayer-app-local is healthy"
  else
    warn "secondlayer-app-local did not become healthy within 60s — check logs"
  fi
fi

# ═══════════════════════════════════════════
# Done
# ═══════════════════════════════════════════

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
if $FULL_SYNC; then
  echo -e "${GREEN}║  Full sync complete!                     ║${NC}"
else
  echo -e "${GREEN}║  Incremental sync complete!              ║${NC}"
fi
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Local backend DB:      ${LOCAL_BACKEND_DB}"
echo -e "  Local Qdrant:          http://localhost:6333"
if ! $SKIP_OPENREYESTR; then
  echo -e "  Local OpenReyestr DB:  ${LOCAL_OPENREYESTR_DB}"
fi

# Print stats for incremental mode
if ! $FULL_SYNC && ! $DRY_RUN; then
  echo ""
  echo -e "${CYAN}  Stats:${NC}"
  if ! $QDRANT_ONLY; then
    echo -e "    PG backend rows added:     ${STAT_PG_BACKEND_ROWS}"
    if ! $SKIP_OPENREYESTR; then
      echo -e "    PG openreyestr rows added: ${STAT_PG_OPENREYESTR_ROWS}"
    fi
  fi
  if ! $PG_ONLY; then
    echo -e "    Qdrant collections synced: ${STAT_QDRANT_SYNCED}"
    echo -e "    Qdrant collections skipped: ${STAT_QDRANT_SKIPPED}"
  fi
fi
echo ""
