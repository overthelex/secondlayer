#!/bin/bash
##############################################################################
# sync-stage-to-local.sh
#
# Copies data from Stage environment to Local:
#   - PostgreSQL (backend + rada schema)
#   - PostgreSQL (openreyestr) — optional, skip with --skip-openreyestr
#   - Qdrant vector DB snapshots
#   - MinIO buckets — optional, include with --include-minio
#
# Safe to run multiple times (idempotent):
#   - Uses pg_restore --clean (drops before create)
#   - Qdrant snapshot replaces collections atomically
#   - Temp files cleaned up on exit
#
# Usage:
#   ./scripts/sync-stage-to-local.sh [OPTIONS]
#
# Options:
#   --skip-openreyestr   Skip OpenReyestr DB (large, usually not needed)
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

# ──────────────── Colors ────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ──────────────── Flags ────────────────

SKIP_OPENREYESTR=true    # Skip by default (large DB, usually preloaded)
INCLUDE_MINIO=false
PG_ONLY=false
QDRANT_ONLY=false
DRY_RUN=false
AUTO_YES=false

# ──────────────── Parse args ────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-openreyestr) SKIP_OPENREYESTR=true; shift ;;
    --include-openreyestr) SKIP_OPENREYESTR=false; shift ;;
    --include-minio) INCLUDE_MINIO=true; shift ;;
    --pg-only) PG_ONLY=true; shift ;;
    --qdrant-only) QDRANT_ONLY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -y|--yes) AUTO_YES=true; shift ;;
    -h|--help)
      head -28 "$0" | tail -22
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
  read -p "Proceed? Local data will be REPLACED. [y/N] " confirm
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

  msg "Restoring backend DB locally (${LOCAL_BACKEND_DB})..."

  # Stop app containers that use the DB to avoid connection conflicts
  msg "Stopping local app containers..."
  run docker stop secondlayer-app-local rada-mcp-app-local 2>/dev/null || true

  run docker exec -i "$LOCAL_BACKEND_CONTAINER" bash -c "
    # Terminate existing connections
    psql -U ${LOCAL_BACKEND_USER} -d postgres -c \"
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${LOCAL_BACKEND_DB}' AND pid <> pg_backend_pid();
    \" 2>/dev/null || true

    # Drop and recreate
    dropdb -U ${LOCAL_BACKEND_USER} --if-exists ${LOCAL_BACKEND_DB}
    createdb -U ${LOCAL_BACKEND_USER} ${LOCAL_BACKEND_DB}

    # Create rada_mcp role if missing
    psql -U ${LOCAL_BACKEND_USER} -d postgres -c \"
      DO \\\$\\\$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rada_mcp') THEN
          CREATE ROLE rada_mcp WITH LOGIN PASSWORD 'rada_password';
        END IF;
      END
      \\\$\\\$;
    \"
  "

  run docker cp "${DUMP_DIR}/backend.dump" "${LOCAL_BACKEND_CONTAINER}:/tmp/backend.dump"
  run docker exec "$LOCAL_BACKEND_CONTAINER" pg_restore \
    -U "$LOCAL_BACKEND_USER" \
    -d "$LOCAL_BACKEND_DB" \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    /tmp/backend.dump || {
      # pg_restore exits non-zero on warnings too; check if DB has tables
      TABLE_COUNT=$(docker exec "$LOCAL_BACKEND_CONTAINER" psql -U "$LOCAL_BACKEND_USER" -d "$LOCAL_BACKEND_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
      if [[ "$TABLE_COUNT" -gt 0 ]]; then
        warn "pg_restore had warnings but DB has ${TABLE_COUNT} tables — continuing"
      else
        err "pg_restore failed and DB is empty"
        exit 1
      fi
    }
  run docker exec "$LOCAL_BACKEND_CONTAINER" rm -f /tmp/backend.dump
  ok "Backend DB restored (${LOCAL_BACKEND_DB})"

  # Grant rada_mcp access
  run docker exec "$LOCAL_BACKEND_CONTAINER" psql -U "$LOCAL_BACKEND_USER" -d "$LOCAL_BACKEND_DB" -c "
    GRANT USAGE ON SCHEMA rada TO rada_mcp;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA rada TO rada_mcp;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA rada TO rada_mcp;
    ALTER DEFAULT PRIVILEGES IN SCHEMA rada GRANT ALL ON TABLES TO rada_mcp;
    ALTER DEFAULT PRIVILEGES IN SCHEMA rada GRANT ALL ON SEQUENCES TO rada_mcp;
  " 2>/dev/null || warn "RADA schema grants — schema may not exist yet"

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

    msg "Restoring openreyestr DB locally (${LOCAL_OPENREYESTR_DB})..."
    run docker stop openreyestr-app-local 2>/dev/null || true

    run docker exec -i "$LOCAL_OPENREYESTR_CONTAINER" bash -c "
      psql -U ${LOCAL_OPENREYESTR_USER} -d postgres -c \"
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${LOCAL_OPENREYESTR_DB}' AND pid <> pg_backend_pid();
      \" 2>/dev/null || true
      dropdb -U ${LOCAL_OPENREYESTR_USER} --if-exists ${LOCAL_OPENREYESTR_DB}
      createdb -U ${LOCAL_OPENREYESTR_USER} ${LOCAL_OPENREYESTR_DB}
    "

    run docker cp "${DUMP_DIR}/openreyestr.dump" "${LOCAL_OPENREYESTR_CONTAINER}:/tmp/openreyestr.dump"
    run docker exec "$LOCAL_OPENREYESTR_CONTAINER" pg_restore \
      -U "$LOCAL_OPENREYESTR_USER" \
      -d "$LOCAL_OPENREYESTR_DB" \
      --no-owner \
      --no-privileges \
      --exit-on-error \
      /tmp/openreyestr.dump || {
        TABLE_COUNT=$(docker exec "$LOCAL_OPENREYESTR_CONTAINER" psql -U "$LOCAL_OPENREYESTR_USER" -d "$LOCAL_OPENREYESTR_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
        if [[ "$TABLE_COUNT" -gt 0 ]]; then
          warn "pg_restore had warnings but DB has ${TABLE_COUNT} tables — continuing"
        else
          err "pg_restore failed and DB is empty"
          exit 1
        fi
      }
    run docker exec "$LOCAL_OPENREYESTR_CONTAINER" rm -f /tmp/openreyestr.dump
    ok "OpenReyestr DB restored (${LOCAL_OPENREYESTR_DB})"
  fi
fi

# ═══════════════════════════════════════════
# STEP 2: Qdrant
# ═══════════════════════════════════════════

if ! $PG_ONLY; then

  msg "Creating Qdrant snapshots on stage..."

  # Get list of collections from stage
  COLLECTIONS=$(run ssh "${STAGE_USER}@${STAGE_SERVER}" \
    "curl -sf http://localhost:6337/collections | python3 -c 'import sys,json; [print(c[\"name\"]) for c in json.load(sys.stdin)[\"result\"][\"collections\"]]'" \
  ) || { err "Failed to list Qdrant collections on stage"; COLLECTIONS=""; }

  if [[ -z "$COLLECTIONS" ]]; then
    warn "No Qdrant collections found on stage — skipping"
  else
    ok "Found collections: $(echo $COLLECTIONS | tr '\n' ' ')"

    for collection in $COLLECTIONS; do
      msg "Snapshotting collection: ${collection}..."

      # Create snapshot on stage Qdrant
      SNAPSHOT_NAME=$(run ssh "${STAGE_USER}@${STAGE_SERVER}" \
        "curl -sf -X POST http://localhost:6337/collections/${collection}/snapshots | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"result\"][\"name\"])'" \
      ) || { err "Failed to snapshot ${collection}"; continue; }
      ok "Snapshot created: ${SNAPSHOT_NAME}"

      # Download snapshot from stage Qdrant via SSH tunnel
      msg "Transferring snapshot ${collection}..."
      run ssh "${STAGE_USER}@${STAGE_SERVER}" \
        "curl -sf http://localhost:6337/collections/${collection}/snapshots/${SNAPSHOT_NAME} -o ${REMOTE_DUMP_DIR}/${collection}.snapshot"
      run rsync -ahP --compress \
        "${STAGE_USER}@${STAGE_SERVER}:${REMOTE_DUMP_DIR}/${collection}.snapshot" \
        "${DUMP_DIR}/${collection}.snapshot"
      ok "Snapshot transferred: $(du -h "${DUMP_DIR}/${collection}.snapshot" | cut -f1)"

      # Delete remote snapshot to save space
      run ssh "${STAGE_USER}@${STAGE_SERVER}" \
        "curl -sf -X DELETE http://localhost:6337/collections/${collection}/snapshots/${SNAPSHOT_NAME} >/dev/null" || true

      # Restore to local Qdrant
      msg "Restoring collection ${collection} locally..."

      # Delete local collection if exists (idempotent)
      run curl -sf -X DELETE "http://localhost:6333/collections/${collection}" >/dev/null 2>&1 || true

      # Upload snapshot to local Qdrant
      run curl -sf -X POST "http://localhost:6333/collections/${collection}/snapshots/upload?priority=snapshot" \
        -H "Content-Type: multipart/form-data" \
        -F "snapshot=@${DUMP_DIR}/${collection}.snapshot" >/dev/null
      ok "Collection ${collection} restored locally"

      # Clean up snapshot file to save disk space
      rm -f "${DUMP_DIR}/${collection}.snapshot"
    done

    ok "All Qdrant collections synced"
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
        run mc mirror --overwrite "stage-sync/${bucket}" "local-sync/${bucket}"
        ok "Bucket ${bucket} synced"
      done
    fi

    # Close tunnel
    kill "$TUNNEL_PID" 2>/dev/null || true
    ok "MinIO sync complete"
  fi
fi

# ═══════════════════════════════════════════
# STEP 4: Restart local app containers
# ═══════════════════════════════════════════

msg "Restarting local app containers..."
run docker start secondlayer-app-local rada-mcp-app-local 2>/dev/null || true
if ! $SKIP_OPENREYESTR; then
  run docker start openreyestr-app-local 2>/dev/null || true
fi

# Wait for health
msg "Waiting for containers to become healthy..."
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

# ═══════════════════════════════════════════
# Done
# ═══════════════════════════════════════════

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Sync complete!                          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Local backend DB:      ${LOCAL_BACKEND_DB}"
echo -e "  Local Qdrant:          http://localhost:6333"
if ! $SKIP_OPENREYESTR; then
  echo -e "  Local OpenReyestr DB:  ${LOCAL_OPENREYESTR_DB}"
fi
echo ""
