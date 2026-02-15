#!/bin/bash
#
# Unified backfill orchestrator for all external data sources.
# Runs all 4 source groups IN PARALLEL for maximum throughput.
#
# Usage:
#   ./scripts/backfill-all.sh [local|stage] [--years=2] [--step=all|dictionaries|decisions|legislation|rada-reference|rada-bills|registries]
#
# Examples:
#   ./scripts/backfill-all.sh local                          # All steps, 2 years, local containers
#   ./scripts/backfill-all.sh stage --years=1                # All steps, 1 year, stage containers
#   ./scripts/backfill-all.sh local --step=decisions         # Only court decisions
#   ./scripts/backfill-all.sh stage --step=rada-bills --years=0.5

set -uo pipefail
# Note: no -e so individual step failures don't abort the whole run

# ─── Defaults ───────────────────────────────────────────────────────────────
ENV="${1:-local}"
YEARS=2
STEP="all"

# Parse named arguments
for arg in "${@:2}"; do
  case "$arg" in
    --years=*) YEARS="${arg#*=}" ;;
    --step=*)  STEP="${arg#*=}" ;;
    *)         echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ─── Computed dates ─────────────────────────────────────────────────────────
END_DATE=$(date +%Y-%m-%d)
# Calculate start date: YEARS can be fractional (0.5 = 6 months)
DAYS_BACK=$(echo "$YEARS * 365" | bc | cut -d. -f1)
START_DATE=$(date -d "$END_DATE - ${DAYS_BACK} days" +%Y-%m-%d)

# ─── Container names ───────────────────────────────────────────────────────
BACKEND_CONTAINER="secondlayer-app-${ENV}"
RADA_CONTAINER="rada-mcp-app-${ENV}"
OPENREYESTR_CONTAINER="openreyestr-app-${ENV}"
COMPOSE_FILE="deployment/docker-compose.${ENV}.yml"

# ─── Concurrency (10 threads per source) ──────────────────────────────────
DECISIONS_CONCURRENCY="${CONCURRENCY:-10}"
RADA_REF_CONCURRENCY="${CONCURRENCY:-10}"
RADA_BILLS_CONCURRENCY="${CONCURRENCY:-10}"
REGISTRIES_CONCURRENCY="${CONCURRENCY:-10}"

# ─── Colors ─────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ─── Log directory for parallel output ────────────────────────────────────
LOG_DIR=$(mktemp -d /tmp/backfill-XXXXXX)

# ─── Helpers ────────────────────────────────────────────────────────────────
header() {
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
}

step_header() {
  echo ""
  echo -e "${YELLOW}─── Step: $1 ───${NC}"
}

check_container() {
  local name="$1"
  if ! docker ps --format '{{.Names}}' | grep -q "^${name}$"; then
    echo -e "${RED}Error: Container ${name} is not running${NC}"
    echo "Start it with: cd deployment && docker compose -f docker-compose.${ENV}.yml up -d"
    return 1
  fi
  echo -e "${GREEN}  Container ${name} is running${NC}"
}

should_run() {
  [[ "$STEP" == "all" || "$STEP" == "$1" ]]
}

# ─── Banner ─────────────────────────────────────────────────────────────────
header "SecondLayer Data Backfill (PARALLEL)"
echo -e "  Environment:   ${ENV}"
echo -e "  Date range:    ${START_DATE} to ${END_DATE} (${YEARS} years)"
echo -e "  Step:          ${STEP}"
echo -e "  Concurrency:   ${DECISIONS_CONCURRENCY} per source"
echo -e "  Compose file:  ${COMPOSE_FILE}"
echo -e "  Log dir:       ${LOG_DIR}"

# ─── Verify containers ─────────────────────────────────────────────────────
echo ""
echo "Checking containers..."
NEED_BACKEND=false
NEED_RADA=false
NEED_OPENREYESTR=false

if should_run "dictionaries" || should_run "decisions" || should_run "legislation"; then
  NEED_BACKEND=true
fi
if should_run "rada-reference" || should_run "rada-bills"; then
  NEED_RADA=true
fi
if should_run "registries"; then
  NEED_OPENREYESTR=true
fi

if $NEED_BACKEND; then check_container "$BACKEND_CONTAINER" || exit 1; fi
if $NEED_RADA; then check_container "$RADA_CONTAINER" || exit 1; fi
if $NEED_OPENREYESTR; then check_container "$OPENREYESTR_CONTAINER" || exit 1; fi

# ─── Track background PIDs ────────────────────────────────────────────────
declare -A PIDS
declare -A PID_NAMES

# ─── Step functions (each runs independently) ─────────────────────────────

run_dictionaries() {
  local log="$LOG_DIR/dictionaries.log"
  echo "[$(date +%T)] Starting dictionaries..." > "$log"
  if timeout 300 docker exec "$BACKEND_CONTAINER" node dist/scripts/sync-dictionaries.js >> "$log" 2>&1; then
    echo -e "\n[$(date +%T)] ✅ Dictionaries synced" >> "$log"
    return 0
  else
    echo -e "\n[$(date +%T)] ⚠️  Dictionaries failed or timed out" >> "$log"
    return 1
  fi
}

run_decisions() {
  local log="$LOG_DIR/decisions.log"
  echo "[$(date +%T)] Starting court decisions (concurrency=${DECISIONS_CONCURRENCY})..." > "$log"
  if docker exec \
    -e START_DATE="$START_DATE" \
    -e END_DATE="$END_DATE" \
    -e BATCH_DAYS="${BATCH_DAYS:-7}" \
    -e CONCURRENCY="$DECISIONS_CONCURRENCY" \
    "$BACKEND_CONTAINER" \
    node dist/scripts/backfill-court-decisions.js >> "$log" 2>&1; then
    echo -e "\n[$(date +%T)] ✅ Court decisions backfilled" >> "$log"
    return 0
  else
    echo -e "\n[$(date +%T)] ❌ Court decisions failed" >> "$log"
    return 1
  fi
}

run_legislation() {
  local log="$LOG_DIR/legislation.log"
  echo "[$(date +%T)] Starting legislation (12 codes, 4 parallel)..." > "$log"

  CODES=(
    "Конституція України"
    "Цивільний кодекс України"
    "Кримінальний кодекс України"
    "Господарський кодекс України"
    "Кодекс законів про працю України"
    "Сімейний кодекс України"
    "Земельний кодекс України"
    "Податковий кодекс України"
    "Кримінальний процесуальний кодекс України"
    "Цивільний процесуальний кодекс України"
    "Кодекс адміністративного судочинства України"
    "Господарський процесуальний кодекс України"
  )

  # Fetch 4 codes in parallel
  local leg_pids=()
  local running=0
  local max_parallel=4
  local failed=0

  for code in "${CODES[@]}"; do
    (
      timeout 120 docker exec "$BACKEND_CONTAINER" \
        node -e "
          const http = require('http');
          const data = JSON.stringify({
            name: 'get_legislation_structure',
            arguments: { query: '${code}' }
          });
          const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/api/tools/get_legislation_structure',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + process.env.SECONDARY_LAYER_KEYS?.split(',')[0],
              'Content-Length': Buffer.byteLength(data)
            }
          }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(body);
                console.log('  ${code}: Status', res.statusCode, '- Articles:', parsed?.result?.articles_count || parsed?.articles_count || 'N/A');
              } catch(e) {
                console.log('  ${code}: Status', res.statusCode);
              }
            });
          });
          req.on('error', e => console.error('  ${code}: Error:', e.message));
          req.write(data);
          req.end();
        " 2>&1
    ) >> "$log" &
    leg_pids+=($!)
    ((running++))

    # Wait when we hit max_parallel
    if [[ $running -ge $max_parallel ]]; then
      for pid in "${leg_pids[@]}"; do
        wait "$pid" || ((failed++)) || true
      done
      leg_pids=()
      running=0
    fi
  done

  # Wait for remaining
  for pid in "${leg_pids[@]}"; do
    wait "$pid" || ((failed++)) || true
  done

  echo -e "\n[$(date +%T)] ✅ Legislation sync complete (${failed} failures)" >> "$log"
  return 0
}

run_rada_reference() {
  local log="$LOG_DIR/rada-reference.log"
  echo "[$(date +%T)] Starting RADA reference data (concurrency=${RADA_REF_CONCURRENCY})..." > "$log"
  if docker exec \
    -e CONCURRENCY="$RADA_REF_CONCURRENCY" \
    "$RADA_CONTAINER" \
    node dist/scripts/sync-reference-data.js >> "$log" 2>&1; then
    echo -e "\n[$(date +%T)] ✅ RADA reference data synced" >> "$log"
    return 0
  else
    echo -e "\n[$(date +%T)] ❌ RADA reference data failed" >> "$log"
    return 1
  fi
}

run_rada_bills() {
  local log="$LOG_DIR/rada-bills.log"
  echo "[$(date +%T)] Starting RADA bills & voting (concurrency=${RADA_BILLS_CONCURRENCY})..." > "$log"
  if docker exec \
    -e START_DATE="$START_DATE" \
    -e END_DATE="$END_DATE" \
    -e CONCURRENCY="$RADA_BILLS_CONCURRENCY" \
    "$RADA_CONTAINER" \
    node dist/scripts/sync-week-data.js >> "$log" 2>&1; then
    echo -e "\n[$(date +%T)] ✅ RADA bills synced" >> "$log"
    return 0
  else
    echo -e "\n[$(date +%T)] ❌ RADA bills failed" >> "$log"
    return 1
  fi
}

run_registries() {
  local log="$LOG_DIR/registries.log"
  echo "[$(date +%T)] Starting NAIS registries (concurrency=${REGISTRIES_CONCURRENCY})..." > "$log"
  if docker exec \
    -e CONCURRENCY="$REGISTRIES_CONCURRENCY" \
    "$OPENREYESTR_CONTAINER" \
    node dist/scripts/sync-all-registries.js >> "$log" 2>&1; then
    echo -e "\n[$(date +%T)] ✅ NAIS registries synced" >> "$log"
    return 0
  else
    echo -e "\n[$(date +%T)] ❌ NAIS registries failed" >> "$log"
    return 1
  fi
}

# ─── Launch all steps in parallel ──────────────────────────────────────────

echo ""
echo -e "${CYAN}Launching all steps in parallel...${NC}"
STEP_COUNT=0

if should_run "dictionaries"; then
  run_dictionaries &
  PIDS[$!]="dictionaries"
  PID_NAMES[dictionaries]=$!
  ((STEP_COUNT++))
  echo -e "  🚀 Dictionaries    → PID $!"
fi

if should_run "decisions"; then
  run_decisions &
  PIDS[$!]="decisions"
  PID_NAMES[decisions]=$!
  ((STEP_COUNT++))
  echo -e "  🚀 Court Decisions → PID $!"
fi

if should_run "legislation"; then
  run_legislation &
  PIDS[$!]="legislation"
  PID_NAMES[legislation]=$!
  ((STEP_COUNT++))
  echo -e "  🚀 Legislation     → PID $!"
fi

if should_run "rada-reference"; then
  run_rada_reference &
  PIDS[$!]="rada-reference"
  PID_NAMES[rada-reference]=$!
  ((STEP_COUNT++))
  echo -e "  🚀 RADA Reference  → PID $!"
fi

if should_run "rada-bills"; then
  run_rada_bills &
  PIDS[$!]="rada-bills"
  PID_NAMES[rada-bills]=$!
  ((STEP_COUNT++))
  echo -e "  🚀 RADA Bills      → PID $!"
fi

if should_run "registries"; then
  run_registries &
  PIDS[$!]="registries"
  PID_NAMES[registries]=$!
  ((STEP_COUNT++))
  echo -e "  🚀 NAIS Registries → PID $!"
fi

echo ""
echo -e "  ${CYAN}${STEP_COUNT} steps launched. Waiting for completion...${NC}"
echo ""

# ─── Wait for all and collect results ──────────────────────────────────────
STEP_FAILURES=0
STEP_SUCCESSES=0

for pid in "${!PIDS[@]}"; do
  name="${PIDS[$pid]}"
  if wait "$pid"; then
    echo -e "  ${GREEN}✅ ${name} completed${NC}"
    ((STEP_SUCCESSES++))
  else
    echo -e "  ${RED}❌ ${name} failed${NC}"
    ((STEP_FAILURES++)) || true
  fi
done

# ─── Print logs summary ───────────────────────────────────────────────────
echo ""
echo -e "${CYAN}─── Step Logs ───${NC}"
for logfile in "$LOG_DIR"/*.log; do
  name=$(basename "$logfile" .log)
  echo ""
  echo -e "${YELLOW}=== ${name} ===${NC}"
  # Show last 20 lines of each log (the summary/important parts)
  tail -20 "$logfile"
done

# ─── Done ───────────────────────────────────────────────────────────────────
header "Backfill Complete"
echo -e "  Succeeded: ${STEP_SUCCESSES}/${STEP_COUNT}"
if [[ $STEP_FAILURES -gt 0 ]]; then
  echo -e "  ${YELLOW}Failed: ${STEP_FAILURES}/${STEP_COUNT}${NC}"
fi
echo -e "  Full logs: ${LOG_DIR}/"
echo -e "  Verify with:"
echo -e "    docker exec ${BACKEND_CONTAINER} node -e \"const{Pool}=require('pg');const p=new Pool();p.query('SELECT COUNT(*) FROM documents').then(r=>console.log('Documents:',r.rows[0].count)).finally(()=>p.end())\""
echo -e "    docker exec ${RADA_CONTAINER} node -e \"const{Pool}=require('pg');const p=new Pool();p.query('SELECT COUNT(*) FROM bills').then(r=>console.log('Bills:',r.rows[0].count)).finally(()=>p.end())\""
echo ""
