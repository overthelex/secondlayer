#!/bin/bash
#
# OpenReyestr Full Backfill — 7 parallel threads
#
# Runs two imports in parallel:
#   • EDRPOU (UO/FOP/FSU)  — IMPORT_WORKERS=3 parallel DB batch writers per entity
#   • NAIS registries (×11) — CONCURRENCY=4 parallel downloads/imports
#   Total: 3 + 4 = 7 concurrent operations
#
# Usage:
#   ./scripts/backfill-openreyestr.sh [local|stage]
#   ./scripts/backfill-openreyestr.sh local --only=nais
#   ./scripts/backfill-openreyestr.sh local --only=edrpou
#   ./scripts/backfill-openreyestr.sh local --only=nais --registries=notaries,debtors
#   ./scripts/backfill-openreyestr.sh local --threads=10

set -uo pipefail

# ─── Args ───────────────────────────────────────────────────────────────────
ENV="${1:-local}"
ONLY="all"          # all | edrpou | nais
REGISTRIES_FILTER=""  # comma-separated registry names for --only=nais
THREADS=7

for arg in "${@:2}"; do
  case "$arg" in
    --only=*)        ONLY="${arg#*=}" ;;
    --registries=*)  REGISTRIES_FILTER="${arg#*=}" ;;
    --threads=*)     THREADS="${arg#*=}" ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Split 7 threads: 3 for EDRPOU workers + 4 for NAIS concurrency
EDRPOU_WORKERS=$(( THREADS * 3 / 7 ))
NAIS_CONCURRENCY=$(( THREADS - EDRPOU_WORKERS ))
[[ $EDRPOU_WORKERS -lt 1 ]] && EDRPOU_WORKERS=1
[[ $NAIS_CONCURRENCY -lt 1 ]] && NAIS_CONCURRENCY=1

CONTAINER="openreyestr-app-${ENV}"
LOG_DIR=$(mktemp -d /tmp/backfill-openreyestr-XXXXXX)

# ─── Colors ─────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Helpers ─────────────────────────────────────────────────────────────────
header() {
  echo ""
  echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}${BOLD}  $1${NC}"
  echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
}

log() { echo -e "${CYAN}[$(date +%T)]${NC} $1"; }
ok()  { echo -e "${GREEN}[$(date +%T)] ✅ $1${NC}"; }
err() { echo -e "${RED}[$(date +%T)] ❌ $1${NC}"; }
warn(){ echo -e "${YELLOW}[$(date +%T)] ⚠️  $1${NC}"; }

# ─── Verify container ────────────────────────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  err "Container ${CONTAINER} is not running"
  echo "  Start with: cd deployment && ./manage-gateway.sh start ${ENV}"
  exit 1
fi

# ─── Print plan ──────────────────────────────────────────────────────────────
header "OpenReyestr Backfill"
echo -e "  Environment:      ${BOLD}${ENV}${NC}"
echo -e "  Container:        ${CONTAINER}"
echo -e "  Mode:             ${ONLY}"
echo -e "  Total threads:    ${THREADS}"
echo -e "  EDRPOU workers:   ${EDRPOU_WORKERS}  (parallel DB batch writers per UO/FOP/FSU)"
echo -e "  NAIS concurrency: ${NAIS_CONCURRENCY}  (parallel registry downloads)"
echo -e "  Logs:             ${LOG_DIR}/"
[[ -n "$REGISTRIES_FILTER" ]] && echo -e "  NAIS filter:      ${REGISTRIES_FILTER}"
echo ""

# ─── Quick row count helper ───────────────────────────────────────────────────
count_rows() {
  docker exec "$CONTAINER" node -e "
    const { Pool } = require('pg');
    const p = new Pool();
    const tables = [
      'legal_entities','individual_entrepreneurs','public_associations',
      'founders','signers','beneficiaries','assignees','members',
      'executive_power','termination_started','bankruptcy_info',
      'enforcement_proceedings','debtors',
      'notaries','court_experts','arbitration_managers',
      'special_forms','forensic_methods','bankruptcy_cases',
      'legal_acts','administrative_units','streets'
    ];
    Promise.all(tables.map(t =>
      p.query('SELECT COUNT(*) FROM ' + t).then(r => ({ t, n: r.rows[0].count })).catch(() => ({ t, n: 'N/A' }))
    )).then(rows => {
      console.log('\n  TABLE                       ROWS');
      console.log('  ' + '-'.repeat(40));
      rows.forEach(({t,n}) => console.log('  ' + t.padEnd(28) + n));
      return p.end();
    });
  " 2>/dev/null
}

# ─── EDRPOU runner ───────────────────────────────────────────────────────────
run_edrpou() {
  local log="${LOG_DIR}/edrpou.log"
  local extra_args=""
  log "Starting EDRPOU (UO/FOP/FSU) with ${EDRPOU_WORKERS} workers..." | tee "$log"

  if docker exec \
    -e IMPORT_WORKERS="${EDRPOU_WORKERS}" \
    -e IMPORT_BATCH_SIZE="500" \
    "$CONTAINER" \
    node dist/scripts/sync-edrpou.js ${extra_args} >> "$log" 2>&1; then
    ok "EDRPOU completed" | tee -a "$log"
    return 0
  else
    local exit_code=$?
    err "EDRPOU failed (exit ${exit_code})" | tee -a "$log"
    echo "  Last 20 lines of edrpou.log:"
    tail -20 "$log"
    return 1
  fi
}

# ─── NAIS registries runner ──────────────────────────────────────────────────
run_nais() {
  local log="${LOG_DIR}/nais.log"
  local filter_arg=""
  [[ -n "$REGISTRIES_FILTER" ]] && filter_arg="--only=${REGISTRIES_FILTER}"

  log "Starting NAIS registries with concurrency=${NAIS_CONCURRENCY}..." | tee "$log"

  if docker exec \
    -e CONCURRENCY="${NAIS_CONCURRENCY}" \
    "$CONTAINER" \
    node dist/scripts/sync-all-registries.js ${filter_arg} >> "$log" 2>&1; then
    ok "NAIS registries completed" | tee -a "$log"
    return 0
  else
    local exit_code=$?
    err "NAIS registries failed (exit ${exit_code})" | tee -a "$log"
    echo "  Last 20 lines of nais.log:"
    tail -20 "$log"
    return 1
  fi
}

# ─── Print row counts before ─────────────────────────────────────────────────
echo -e "${YELLOW}Row counts BEFORE:${NC}"
count_rows
echo ""

# ─── Launch ──────────────────────────────────────────────────────────────────
START_TS=$(date +%s)
EDRPOU_PID=""
NAIS_PID=""
EDRPOU_STATUS=0
NAIS_STATUS=0

if [[ "$ONLY" == "all" || "$ONLY" == "edrpou" ]]; then
  run_edrpou &
  EDRPOU_PID=$!
  log "EDRPOU launched → PID ${EDRPOU_PID}  (log: ${LOG_DIR}/edrpou.log)"
fi

if [[ "$ONLY" == "all" || "$ONLY" == "nais" ]]; then
  run_nais &
  NAIS_PID=$!
  log "NAIS launched   → PID ${NAIS_PID}  (log: ${LOG_DIR}/nais.log)"
fi

# ─── Progress monitor ────────────────────────────────────────────────────────
# Print last log line from each process every 30 seconds
monitor_progress() {
  while true; do
    sleep 30
    echo ""
    echo -e "${CYAN}--- Progress at $(date +%T) ---${NC}"
    if [[ -n "$EDRPOU_PID" ]] && kill -0 "$EDRPOU_PID" 2>/dev/null; then
      local last
      last=$(tail -1 "${LOG_DIR}/edrpou.log" 2>/dev/null | cut -c1-100)
      echo -e "  EDRPOU: ${last}"
    fi
    if [[ -n "$NAIS_PID" ]] && kill -0 "$NAIS_PID" 2>/dev/null; then
      local last
      last=$(tail -1 "${LOG_DIR}/nais.log" 2>/dev/null | cut -c1-100)
      echo -e "  NAIS:   ${last}"
    fi
  done
}
monitor_progress &
MONITOR_PID=$!

# ─── Wait for both ───────────────────────────────────────────────────────────
if [[ -n "$EDRPOU_PID" ]]; then
  wait "$EDRPOU_PID" || EDRPOU_STATUS=$?
fi
if [[ -n "$NAIS_PID" ]]; then
  wait "$NAIS_PID" || NAIS_STATUS=$?
fi

kill "$MONITOR_PID" 2>/dev/null || true

# ─── Summary ─────────────────────────────────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_TS ))
ELAPSED_MIN=$(( ELAPSED / 60 ))
ELAPSED_SEC=$(( ELAPSED % 60 ))

header "Backfill Complete — ${ELAPSED_MIN}m ${ELAPSED_SEC}s"

if [[ -n "$EDRPOU_PID" ]]; then
  if [[ $EDRPOU_STATUS -eq 0 ]]; then
    ok "EDRPOU (UO/FOP/FSU)"
  else
    err "EDRPOU (UO/FOP/FSU) — exit code ${EDRPOU_STATUS}"
  fi
fi

if [[ -n "$NAIS_PID" ]]; then
  if [[ $NAIS_STATUS -eq 0 ]]; then
    ok "NAIS registries (×11)"
  else
    err "NAIS registries — exit code ${NAIS_STATUS}"
  fi
fi

# ─── Row counts after ────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}Row counts AFTER:${NC}"
count_rows

echo ""
echo -e "  Full logs:"
echo -e "    tail -f ${LOG_DIR}/edrpou.log"
echo -e "    tail -f ${LOG_DIR}/nais.log"
echo ""

# Exit with error if any step failed
[[ $EDRPOU_STATUS -ne 0 || $NAIS_STATUS -ne 0 ]] && exit 1
exit 0
