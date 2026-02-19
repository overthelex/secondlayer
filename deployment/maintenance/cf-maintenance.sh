#!/bin/bash
##############################################################################
# Cloudflare Maintenance Mode — SecondLayer
#
# Toggles a branded "We'll be right back" page on Cloudflare edge
# by creating/deleting Worker Routes that point to a resident Worker script.
#
# Usage:
#   cf-maintenance.sh enable    # activate maintenance page on all domains
#   cf-maintenance.sh disable   # deactivate maintenance page
#   cf-maintenance.sh status    # show current routes
#   cf-maintenance.sh setup     # first-time: deploy worker + show zone info
#
# Reads credentials from: <repo-root>/.env.cloudflare
##############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${BLUE}[cf-maintenance]${NC} $*"; }
ok()   { echo -e "${GREEN}[cf-maintenance]${NC} $*"; }
warn() { echo -e "${YELLOW}[cf-maintenance]${NC} $*"; }
err()  { echo -e "${RED}[cf-maintenance]${NC} $*" >&2; }

# ── Load .env.cloudflare ─────────────────────────────────────────────────────
CF_ENV_FILE="$REPO_ROOT/.env.cloudflare"
if [ ! -f "$CF_ENV_FILE" ]; then
    err ".env.cloudflare not found at $CF_ENV_FILE"
    exit 1
fi

# Export vars from file (skip comments and blank lines)
set -a
# shellcheck disable=SC1090
source <(grep -v '^\s*#' "$CF_ENV_FILE" | grep -v '^\s*$')
set +a

if [ -z "${CLOUDFLARE_GLOBAL_API_KEY:-}" ] || [ -z "${CLOUDFLARE_EMAIL:-}" ]; then
    err "CLOUDFLARE_GLOBAL_API_KEY and CLOUDFLARE_EMAIL must be set in $CF_ENV_FILE"
    exit 1
fi

# ── Config ────────────────────────────────────────────────────────────────────
CF_API="https://api.cloudflare.com/client/v4"
WORKER_NAME="secondlayer-maintenance"
WORKER_FILE="$SCRIPT_DIR/maintenance-worker.js"

# Primary zone (all subdomains live here)
PRIMARY_DOMAIN="legal.org.ua"

# Patterns to intercept during maintenance
# Add/remove entries as needed
MAINTENANCE_PATTERNS=(
    "legal.org.ua/*"
    "stage.legal.org.ua/*"
    "mcp.legal.org.ua/*"
    "localdev.legal.org.ua/*"
)

# ── Helpers ───────────────────────────────────────────────────────────────────
cf_get() {
    local path=$1
    curl -sf \
        -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
        -H "X-Auth-Key: $CLOUDFLARE_GLOBAL_API_KEY" \
        -H "Content-Type: application/json" \
        "${CF_API}${path}"
}

cf_post() {
    local path=$1; local data=$2
    curl -sf -X POST \
        -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
        -H "X-Auth-Key: $CLOUDFLARE_GLOBAL_API_KEY" \
        -H "Content-Type: application/json" \
        -d "$data" \
        "${CF_API}${path}"
}

cf_put_file() {
    local path=$1; local file=$2
    curl -sf -X PUT \
        -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
        -H "X-Auth-Key: $CLOUDFLARE_GLOBAL_API_KEY" \
        -H "Content-Type: application/javascript" \
        --data-binary @"$file" \
        "${CF_API}${path}"
}

cf_delete() {
    local path=$1
    curl -sf -X DELETE \
        -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
        -H "X-Auth-Key: $CLOUDFLARE_GLOBAL_API_KEY" \
        "${CF_API}${path}"
}

check_success() {
    local resp=$1; local label=${2:-"operation"}
    local success
    success=$(echo "$resp" | python3 -c \
        "import sys,json; d=json.load(sys.stdin); print(str(d.get('success',False)).lower())" 2>/dev/null || echo "false")
    if [ "$success" != "true" ]; then
        local errors
        errors=$(echo "$resp" | python3 -c \
            "import sys,json; d=json.load(sys.stdin); print('; '.join(e.get('message','?') for e in d.get('errors',[])))" 2>/dev/null || echo "unknown")
        err "$label failed: $errors"
        return 1
    fi
    return 0
}

# ── Get account ID ────────────────────────────────────────────────────────────
get_account_id() {
    local resp
    resp=$(cf_get "/accounts?per_page=1")
    python3 -c \
        "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'])" <<< "$resp"
}

# ── Get zone ID for PRIMARY_DOMAIN ────────────────────────────────────────────
get_zone_id() {
    local resp
    resp=$(cf_get "/zones?name=${PRIMARY_DOMAIN}&status=active")
    local zone_id
    zone_id=$(python3 -c \
        "import sys,json; d=json.load(sys.stdin); r=d.get('result',[]); print(r[0]['id'] if r else '')" <<< "$resp")
    if [ -z "$zone_id" ]; then
        err "Zone for ${PRIMARY_DOMAIN} not found or not active in this CF account"
        exit 1
    fi
    echo "$zone_id"
}

# ── Deploy Worker script ──────────────────────────────────────────────────────
deploy_worker() {
    local account_id=$1
    if [ ! -f "$WORKER_FILE" ]; then
        err "Worker file not found: $WORKER_FILE"
        exit 1
    fi
    log "Uploading Worker '${WORKER_NAME}' to Cloudflare..."
    local resp
    resp=$(cf_put_file "/accounts/${account_id}/workers/scripts/${WORKER_NAME}" "$WORKER_FILE")
    if check_success "$resp" "Worker upload"; then
        ok "Worker '${WORKER_NAME}' deployed"
    else
        exit 1
    fi
}

# ── List current maintenance routes ──────────────────────────────────────────
list_routes() {
    local zone_id=$1
    local resp
    resp=$(cf_get "/zones/${zone_id}/workers/routes")
    python3 - <<PYEOF "$resp"
import sys, json
data = json.loads(sys.argv[1])
routes = [r for r in data.get('result', []) if r.get('script') == '${WORKER_NAME}']
if not routes:
    print("  (no active maintenance routes)")
else:
    for r in routes:
        print(f"  {r['id']}  {r['pattern']}")
PYEOF
}

# ── Enable: create routes for all patterns ────────────────────────────────────
enable_maintenance() {
    log "Enabling Cloudflare maintenance mode..."

    local account_id zone_id
    account_id=$(get_account_id)
    zone_id=$(get_zone_id)

    # Ensure Worker is deployed/up-to-date
    deploy_worker "$account_id"

    # Get existing routes to avoid duplicates
    local existing
    existing=$(cf_get "/zones/${zone_id}/workers/routes")
    local existing_patterns
    existing_patterns=$(python3 -c \
        "import sys,json; d=json.load(sys.stdin); print('\n'.join(r['pattern'] for r in d.get('result',[]) if r.get('script')=='${WORKER_NAME}'))" <<< "$existing")

    local created=0 skipped=0

    for pattern in "${MAINTENANCE_PATTERNS[@]}"; do
        if echo "$existing_patterns" | grep -qxF "$pattern" 2>/dev/null; then
            warn "Route already active: $pattern"
            ((skipped++)) || true
            continue
        fi

        local resp
        resp=$(cf_post "/zones/${zone_id}/workers/routes" \
            "{\"pattern\": \"${pattern}\", \"script\": \"${WORKER_NAME}\"}")

        local success
        success=$(python3 -c \
            "import sys,json; d=json.load(sys.stdin); print(str(d.get('success',False)).lower())" <<< "$resp" 2>/dev/null || echo "false")

        if [ "$success" = "true" ]; then
            local route_id
            route_id=$(python3 -c \
                "import sys,json; d=json.load(sys.stdin); print(d['result']['id'])" <<< "$resp" 2>/dev/null || echo "?")
            ok "  Route created: $pattern  (id: $route_id)"
            ((created++)) || true
        else
            # Non-fatal: some patterns (e.g. localdev) may not be CF-proxied
            local errmsg
            errmsg=$(python3 -c \
                "import sys,json; d=json.load(sys.stdin); print('; '.join(e.get('message','?') for e in d.get('errors',[])))" <<< "$resp" 2>/dev/null || echo "unknown")
            warn "  Skipped $pattern: $errmsg"
        fi
    done

    ok "Maintenance mode ENABLED (created: $created, skipped/failed: $skipped / $((${#MAINTENANCE_PATTERNS[@]} - created - skipped)) )"
    echo ""
    echo -e "${CYAN}Active routes:${NC}"
    list_routes "$zone_id"
}

# ── Disable: delete all maintenance routes ────────────────────────────────────
disable_maintenance() {
    log "Disabling Cloudflare maintenance mode..."

    local zone_id
    zone_id=$(get_zone_id)

    local routes_resp
    routes_resp=$(cf_get "/zones/${zone_id}/workers/routes")

    local route_ids
    route_ids=$(python3 -c \
        "import sys,json; d=json.load(sys.stdin); [print(r['id']) for r in d.get('result',[]) if r.get('script')=='${WORKER_NAME}']" \
        <<< "$routes_resp")

    if [ -z "$route_ids" ]; then
        ok "No active maintenance routes found — site already live"
        return 0
    fi

    local deleted=0
    while IFS= read -r route_id; do
        [ -z "$route_id" ] && continue
        local resp
        resp=$(cf_delete "/zones/${zone_id}/workers/routes/${route_id}")
        local success
        success=$(python3 -c \
            "import sys,json; d=json.load(sys.stdin); print(str(d.get('success',False)).lower())" <<< "$resp" 2>/dev/null || echo "false")
        if [ "$success" = "true" ]; then
            ok "  Deleted route: $route_id"
            ((deleted++)) || true
        else
            warn "  Could not delete route $route_id (may already be gone)"
        fi
    done <<< "$route_ids"

    ok "Maintenance mode DISABLED (removed $deleted route(s)) — site is LIVE"
}

# ── Status ────────────────────────────────────────────────────────────────────
show_status() {
    log "Checking Cloudflare maintenance status..."
    local zone_id
    zone_id=$(get_zone_id)

    local routes_resp
    routes_resp=$(cf_get "/zones/${zone_id}/workers/routes")

    local count
    count=$(python3 -c \
        "import sys,json; d=json.load(sys.stdin); print(len([r for r in d.get('result',[]) if r.get('script')=='${WORKER_NAME}']))" \
        <<< "$routes_resp")

    if [ "$count" -gt 0 ]; then
        warn "MAINTENANCE MODE IS ACTIVE ($count route(s))"
    else
        ok "Site is LIVE — no active maintenance routes"
    fi
    echo ""
    echo -e "${CYAN}Maintenance Worker routes (script='${WORKER_NAME}'):${NC}"
    list_routes "$zone_id"

    echo ""
    echo -e "${CYAN}All Worker routes in zone:${NC}"
    python3 - <<PYEOF "$routes_resp"
import sys, json
data = json.loads(sys.argv[1])
routes = data.get('result', [])
if not routes:
    print("  (none)")
for r in routes:
    print(f"  {r.get('id','-')[:12]}  {r['pattern']:40s}  script={r.get('script','—')}")
PYEOF
}

# ── Setup (first-time) ────────────────────────────────────────────────────────
run_setup() {
    log "Running first-time setup..."
    local account_id zone_id
    account_id=$(get_account_id)
    zone_id=$(get_zone_id)

    ok "Account ID : $account_id"
    ok "Zone ID    : $zone_id  ($PRIMARY_DOMAIN)"

    deploy_worker "$account_id"

    ok ""
    ok "Setup complete. Run './cf-maintenance.sh enable' before a deploy,"
    ok "and './cf-maintenance.sh disable' after."
}

# ── Main ──────────────────────────────────────────────────────────────────────
CMD="${1:-}"
case "$CMD" in
    enable)   enable_maintenance  ;;
    disable)  disable_maintenance ;;
    status)   show_status         ;;
    setup)    run_setup           ;;
    *)
        echo "Usage: $0 <enable|disable|status|setup>"
        echo ""
        echo "  setup    — deploy worker script to Cloudflare (first-time)"
        echo "  enable   — activate maintenance page on all domains"
        echo "  disable  — deactivate maintenance page, site goes live"
        echo "  status   — show current maintenance routes"
        exit 1
        ;;
esac
