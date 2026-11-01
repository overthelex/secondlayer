#!/bin/bash
# Court Data Sync — periodic backfill of court decisions and full texts
# Runs inside the mcp_backend Docker container
# Install: crontab deployment/cron/court-crontab
#
# Usage:
#   ./court-data-sync.sh            # Daily sync (decisions + full texts)
#   ./court-data-sync.sh --monthly  # Also run thematic collections
#   DRY_RUN=true ./court-data-sync.sh  # Preview without writing

set -euo pipefail

LOCK_FILE="/tmp/court-data-sync.lock"
LOG_DIR="/var/log/secondlayer"
LOG_FILE="${LOG_DIR}/court-sync.log"
MONTHLY=false
ERRORS=0

# Parse arguments
for arg in "$@"; do
  case $arg in
    --monthly) MONTHLY=true ;;
  esac
done

# Lock file to prevent parallel runs
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "ERROR: Another court-data-sync is already running (PID $LOCK_PID)" >&2
    exit 1
  fi
  # Stale lock file — remove it
  rm -f "$LOCK_FILE"
fi

trap 'rm -f "$LOCK_FILE"' EXIT
echo $$ > "$LOCK_FILE"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

log "========================================"
log "Court data sync started (monthly=$MONTHLY, dry_run=${DRY_RUN:-false})"

# blue-green on the local stack (LEXAI-2188): the active colour is the one nginx
# points at (deployment/nginx/includes/local-upstreams.conf, rewritten by the
# deploy), then the .active-colors-local marker; a colour counts only if its
# container is running. Last resort: whichever colour is running, blue first.
active_local_backend() {
  local dep up mark c
  dep="$(cd "$(dirname "$0")/.." && pwd)"
  is_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }
  up=$(sed -n 's/^[[:space:]]*server[[:space:]]\{1,\}\(secondlayer-app-local[a-z-]*\):3000.*/\1/p' \
         "$dep/nginx/includes/local-upstreams.conf" 2>/dev/null | head -1)
  if [ -n "$up" ] && is_running "$up"; then echo "$up"; return; fi
  mark=$(grep '^app=' "$dep/.active-colors-local" 2>/dev/null | cut -d= -f2)
  case "$mark" in
    green) c=secondlayer-app-local-green ;;
    blue)  c=secondlayer-app-local ;;
    *)     c="" ;;
  esac
  if [ -n "$c" ] && is_running "$c"; then echo "$c"; return; fi
  for c in secondlayer-app-local secondlayer-app-local-green; do
    if is_running "$c"; then echo "$c"; return; fi
  done
}

# Determine container name
if docker ps --format '{{.Names}}' | grep -q 'secondlayer-app-stage'; then
  CONTAINER="secondlayer-app-stage"
elif ACTIVE=$(active_local_backend) && [ -n "$ACTIVE" ]; then
  CONTAINER="$ACTIVE"
else
  log "ERROR: No backend container running"
  exit 1
fi

log "Using container: $CONTAINER"

# Helper: run a command inside the container with env vars
run_in_container() {
  local description="$1"
  shift
  log "--- $description ---"
  if docker exec "$@" >> "$LOG_FILE" 2>&1; then
    log "$description: OK"
  else
    local code=$?
    log "$description: FAILED (exit code $code)"
    ERRORS=$((ERRORS + 1))
  fi
}

# ── Step 1: Backfill new court decisions (last 14 days) ──────────────

START_DATE=$(date -d '14 days ago' '+%Y-%m-%d' 2>/dev/null || date -v-14d '+%Y-%m-%d')
END_DATE=$(date '+%Y-%m-%d')

run_in_container "Backfill court decisions ($START_DATE to $END_DATE)" \
  -e "START_DATE=$START_DATE" \
  -e "END_DATE=$END_DATE" \
  -e "CONCURRENCY=5" \
  -e "BATCH_DAYS=7" \
  -e "DRY_RUN=${DRY_RUN:-false}" \
  "$CONTAINER" npm run backfill:decisions

# ── Step 2: Backfill full texts from reyestr.court.gov.ua ───────────

run_in_container "Backfill full texts (max 500 docs)" \
  -e "CONCURRENCY=5" \
  -e "DELAY_MS=500" \
  -e "MAX_DOCS=500" \
  -e "DRY_RUN=${DRY_RUN:-false}" \
  "$CONTAINER" npm run backfill:reyestr

# ── Step 3: Thematic collections (monthly only) ─────────────────────

if [ "$MONTHLY" = true ]; then
  DATE_FROM=$(date -d '30 days ago' '+%Y-%m-%d' 2>/dev/null || date -v-30d '+%Y-%m-%d')

  run_in_container "Load debt cases (from $DATE_FROM, max 2000)" \
    -e "DATE_FROM=$DATE_FROM" \
    -e "MAX_DOCS=2000" \
    -e "DRY_RUN=${DRY_RUN:-false}" \
    "$CONTAINER" npm run load:debt-cases

  run_in_container "Load civil property cases (from $DATE_FROM, max 2000)" \
    -e "DATE_FROM=$DATE_FROM" \
    -e "MAX_DOCS=2000" \
    -e "CONCURRENCY=5" \
    -e "DRY_RUN=${DRY_RUN:-false}" \
    "$CONTAINER" npm run load:civil-cases
fi

# ── Summary ──────────────────────────────────────────────────────────

if [ $ERRORS -gt 0 ]; then
  log "Court data sync finished with $ERRORS error(s)"
  log "========================================"
  exit 1
else
  log "Court data sync finished successfully"
  log "========================================"
  exit 0
fi
