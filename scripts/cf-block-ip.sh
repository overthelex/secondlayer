#!/usr/bin/env bash
# Заблокувати IP у Cloudflare для зони legal.org.ua (IP Access Rule, mode=block).
#   ./scripts/cf-block-ip.sh <ip> ["примітка"]
#   ./scripts/cf-block-ip.sh --list            — показати чинні блокування зони
#   ./scripts/cf-block-ip.sh --unblock <rule_id>
# Креди: CF_ENV_FILE (за замовчуванням <repo>/.env.cloudflare: CLOUDFLARE_GLOBAL_API_KEY,
# CLOUDFLARE_EMAIL), зона — CF_ZONE_ID. Запускати на cthulhu (там лежить .env.cloudflare).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CF_ENV_FILE="${CF_ENV_FILE-$DIR/../.env.cloudflare}"
CF_ZONE_ID="${CF_ZONE_ID:-9318befc0707ebccefbcac28128720d2}"
[[ -r "$CF_ENV_FILE" ]] || { echo "немає $CF_ENV_FILE" >&2; exit 1; }
set -a; . "$CF_ENV_FILE"; set +a
: "${CLOUDFLARE_GLOBAL_API_KEY:?}" "${CLOUDFLARE_EMAIL:?}"

API="https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/firewall/access_rules/rules"
cf() { curl -sS -H "X-Auth-Key: $CLOUDFLARE_GLOBAL_API_KEY" -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "Content-Type: application/json" "$@"; }

case "${1:-}" in
  --list)
    cf "$API?per_page=100&mode=block" | python3 -c '
import json,sys; d=json.load(sys.stdin)
for r in d["result"]: print(r["id"], r["configuration"]["value"], r["created_on"][:10], "|", r.get("notes",""))' ;;
  --unblock)
    [[ -n "${2:-}" ]] || { echo "вкажіть rule_id" >&2; exit 1; }
    cf -X DELETE "$API/$2" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok" if d["success"] else d["errors"])' ;;
  "" | -h | --help)
    sed -n '2,7p' "$0"; exit 0 ;;
  *)
    IP="$1"; NOTE="${2:-$(date +%F) blocked by cf-block-ip.sh}"
    [[ "$IP" =~ ^[0-9a-fA-F.:/]+$ ]] || { echo "не схоже на IP: $IP" >&2; exit 1; }
    TARGET=ip; [[ "$IP" == */* ]] && TARGET=ip_range
    python3 -c 'import json,sys; print(json.dumps({"mode":"block","configuration":{"target":sys.argv[1],"value":sys.argv[2]},"notes":sys.argv[3][:200]}))' "$TARGET" "$IP" "$NOTE" \
      | cf -X POST "$API" --data @- \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("заблоковано, rule id", d["result"]["id"]) if d["success"] else (print(d["errors"], file=sys.stderr), sys.exit(1))' ;;
esac
