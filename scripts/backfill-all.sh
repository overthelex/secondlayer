#!/bin/bash
#
# Unified backfill orchestrator for all external data sources.
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

# ─── Colors ─────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

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

run_in_container() {
  local container="$1"
  shift
  docker exec "$container" "$@"
}

run_in_container_env() {
  local container="$1"
  shift
  # Remaining args are -e KEY=VAL ... node script.js
  docker exec "$@" "$container"
}

should_run() {
  [[ "$STEP" == "all" || "$STEP" == "$1" ]]
}

# ─── Banner ─────────────────────────────────────────────────────────────────
header "SecondLayer Data Backfill"
echo -e "  Environment:   ${ENV}"
echo -e "  Date range:    ${START_DATE} to ${END_DATE} (${YEARS} years)"
echo -e "  Step:          ${STEP}"
echo -e "  Compose file:  ${COMPOSE_FILE}"

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

STEP_FAILURES=0

# ─── Step 1: ZO Dictionaries ───────────────────────────────────────────────
if should_run "dictionaries"; then
  step_header "ZO Dictionaries (sync all, 5min timeout)"
  if timeout 300 docker exec "$BACKEND_CONTAINER" node dist/scripts/sync-dictionaries.js; then
    echo -e "${GREEN}  Dictionaries synced${NC}"
  else
    echo -e "${YELLOW}  Warning: Dictionaries step failed or timed out (non-fatal)${NC}"
    ((STEP_FAILURES++)) || true
  fi
fi

# ─── Step 2: Court Decisions ────────────────────────────────────────────────
if should_run "decisions"; then
  step_header "Court Decisions (${START_DATE} to ${END_DATE})"
  if docker exec \
    -e START_DATE="$START_DATE" \
    -e END_DATE="$END_DATE" \
    -e BATCH_DAYS="${BATCH_DAYS:-7}" \
    -e CONCURRENCY="${CONCURRENCY:-2}" \
    "$BACKEND_CONTAINER" \
    node dist/scripts/backfill-court-decisions.js; then
    echo -e "${GREEN}  Court decisions backfilled${NC}"
  else
    echo -e "${RED}  Error: Court decisions step failed${NC}"
    ((STEP_FAILURES++)) || true
  fi
fi

# ─── Step 3: Legislation (12 codes via HTTP API) ───────────────────────────
if should_run "legislation"; then
  step_header "Legislation (12 codes via get_legislation_structure)"

  # Legislation codes to fetch
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

  for code in "${CODES[@]}"; do
    echo -e "  Fetching: ${code}"
    # Call the tool via HTTP API from inside the backend container
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
              console.log('  Status:', res.statusCode, '- Articles:', parsed?.result?.articles_count || parsed?.articles_count || 'N/A');
            } catch(e) {
              console.log('  Status:', res.statusCode);
            }
          });
        });
        req.on('error', e => console.error('  Error:', e.message));
        req.write(data);
        req.end();
      " 2>&1 || echo -e "${YELLOW}  Warning: Failed to fetch ${code}${NC}"
    sleep 2
  done
  echo -e "${GREEN}  Legislation sync complete${NC}"
fi

# ─── Step 4: RADA Reference Data ───────────────────────────────────────────
if should_run "rada-reference"; then
  step_header "RADA Reference Data (deputies, factions, committees)"
  if docker exec "$RADA_CONTAINER" node dist/scripts/sync-reference-data.js; then
    echo -e "${GREEN}  RADA reference data synced${NC}"
  else
    echo -e "${RED}  Error: RADA reference data step failed${NC}"
    ((STEP_FAILURES++)) || true
  fi
fi

# ─── Step 5: RADA Bills & Voting ───────────────────────────────────────────
if should_run "rada-bills"; then
  step_header "RADA Bills & Voting (${START_DATE} to ${END_DATE})"
  if docker exec \
    -e START_DATE="$START_DATE" \
    -e END_DATE="$END_DATE" \
    -e CONCURRENCY="${CONCURRENCY:-5}" \
    "$RADA_CONTAINER" \
    node dist/scripts/sync-week-data.js; then
    echo -e "${GREEN}  RADA bills synced${NC}"
  else
    echo -e "${RED}  Error: RADA bills step failed${NC}"
    ((STEP_FAILURES++)) || true
  fi
fi

# ─── Step 6: NAIS Registries ───────────────────────────────────────────────
if should_run "registries"; then
  step_header "NAIS Registries (full download)"
  if docker exec "$OPENREYESTR_CONTAINER" node dist/scripts/sync-all-registries.js; then
    echo -e "${GREEN}  NAIS registries synced${NC}"
  else
    echo -e "${RED}  Error: NAIS registries step failed${NC}"
    ((STEP_FAILURES++)) || true
  fi
fi

# ─── Done ───────────────────────────────────────────────────────────────────
header "Backfill Complete"
if [[ $STEP_FAILURES -gt 0 ]]; then
  echo -e "  ${YELLOW}Finished with ${STEP_FAILURES} step failure(s)${NC}"
else
  echo -e "  All steps finished successfully."
fi
echo -e "  Verify with:"
echo -e "    docker exec ${BACKEND_CONTAINER} node -e \"const{Pool}=require('pg');const p=new Pool();p.query('SELECT COUNT(*) FROM documents').then(r=>console.log('Documents:',r.rows[0].count)).finally(()=>p.end())\""
echo -e "    docker exec ${RADA_CONTAINER} node -e \"const{Pool}=require('pg');const p=new Pool();p.query('SELECT COUNT(*) FROM bills').then(r=>console.log('Bills:',r.rows[0].count)).finally(()=>p.end())\""
echo ""
