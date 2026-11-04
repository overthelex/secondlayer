#!/usr/bin/env bash
# Звіт про використання MCP-ключа клієнтом (legal.org.ua, legal_prod на cthulhu).
#
# Показує, хто і як користується ключем: виклики по днях, різні IP / User-Agent,
# сесії, обсяг відданих даних, топ інструментів, відмови авторизації, і позначає
# ознаки нецільового використання (ключ з багатьох мереж, масове вивантаження).
#
# Дані: cost_tracking (+ client_ip/user_agent/mcp_session_id/response_bytes),
# mcp_access_log, view mcp_key_usage_daily — міграція 244.
#
# Використання:
#   ./scripts/mcp-key-usage-report.sh <email | префікс ключа sl_xxxx | all> [днів=7]
# На самому cthulhu (cron): SSH_HOST= ./scripts/mcp-key-usage-report.sh ...
# Пороги (env): MAX_IPS_PER_DAY=3  MAX_CALLS_PER_DAY=500  MAX_MB_PER_DAY=50
# REPORT_HTML=1 — таблиці у форматі HTML (psql -H), для листа.
# Код виходу: 0 — без ознак, 2 — є позначки (для cron/алертів), 1 — помилка.
#
# Приклад: ./scripts/mcp-key-usage-report.sh mrbraun013@gmail.com 30

set -euo pipefail

WHO="${1:?вкажіть email клієнта або префікс ключа (sl_xxxx)}"
DAYS="${2:-7}"
MAX_IPS="${MAX_IPS_PER_DAY:-3}"
MAX_CALLS="${MAX_CALLS_PER_DAY:-500}"
MAX_MB="${MAX_MB_PER_DAY:-50}"
SSH_HOST="${SSH_HOST-local}"   # empty = run on this host (cthulhu)

[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "днів має бути числом" >&2; exit 1; }
[[ "$MAX_IPS$MAX_CALLS$MAX_MB" =~ ^[0-9]+$ ]] || { echo "пороги мають бути числами" >&2; exit 1; }
# Only characters that can appear in an email or key prefix; the value is inlined into SQL.
[[ "$WHO" =~ ^[A-Za-z0-9._%+@-]+$ ]] || { echo "недопустимі символи в '$WHO'" >&2; exit 1; }

if [[ "$WHO" == all ]]; then
  FILTER="true"
  LOG_FILTER="true"
elif [[ "$WHO" == *@* ]]; then
  FILTER="lower(email) = lower('$WHO')"
  LOG_FILTER="user_id = (SELECT id FROM users WHERE lower(email) = lower('$WHO'))"
else
  FILTER="key_prefix = left('$WHO', 8)"
  LOG_FILTER="key_prefix LIKE left('$WHO', 12) || '%'"
fi
SINCE="now() - interval '$DAYS days'"

PSQL="docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local -v ON_ERROR_STOP=1 -P pager=off"
run_sql() {
  if [[ -n "$SSH_HOST" ]]; then
    ssh "$SSH_HOST" "sudo $PSQL $*"
  else
    $PSQL "$@"
  fi
}

echo "=== MCP-використання: $WHO, останні $DAYS дн. ==="
run_sql ${REPORT_HTML:+-H} <<SQL
\\echo '--- По днях і ключах ---'
SELECT day, key_name, key_prefix, calls, failed_calls AS failed, distinct_ips AS ips,
       distinct_user_agents AS uas, sessions, distinct_tools AS tools,
       round(response_bytes / 1048576.0, 2) AS mb_out, round(cost_usd, 4) AS cost_usd
FROM mcp_key_usage_daily
WHERE $FILTER AND day >= ($SINCE)::date
ORDER BY day DESC, calls DESC;

\\echo '--- IP-адреси та клієнти ---'
WITH keys AS (SELECT DISTINCT user_id, key_prefix FROM mcp_key_usage_daily WHERE $FILTER)
SELECT host(ct.client_ip) AS ip, left(ct.user_agent, 60) AS user_agent, count(*) AS calls,
       min(ct.created_at) AS first_seen, max(ct.created_at) AS last_seen
FROM cost_tracking ct
JOIN keys k ON k.user_id IS NOT DISTINCT FROM ct.user_id AND k.key_prefix = left(ct.client_key, 8)
WHERE ct.request_id LIKE 'mcp-%' AND ct.created_at >= $SINCE
GROUP BY 1, 2 ORDER BY calls DESC LIMIT 30;

\\echo '--- Топ інструментів ---'
WITH keys AS (SELECT DISTINCT user_id, key_prefix FROM mcp_key_usage_daily WHERE $FILTER)
SELECT ct.tool_name, count(*) AS calls, round(sum(COALESCE(ct.response_bytes,0)) / 1048576.0, 2) AS mb_out,
       round(sum(ct.total_cost_usd), 4) AS cost_usd
FROM cost_tracking ct
JOIN keys k ON k.user_id IS NOT DISTINCT FROM ct.user_id AND k.key_prefix = left(ct.client_key, 8)
WHERE ct.request_id LIKE 'mcp-%' AND ct.created_at >= $SINCE
GROUP BY 1 ORDER BY calls DESC LIMIT 20;

\\echo '--- Останні 20 викликів ---'
WITH keys AS (SELECT DISTINCT user_id, key_prefix FROM mcp_key_usage_daily WHERE $FILTER)
SELECT ct.created_at, ct.tool_name, left(ct.user_query, 70) AS query, host(ct.client_ip) AS ip,
       ct.status, ct.response_bytes AS bytes
FROM cost_tracking ct
JOIN keys k ON k.user_id IS NOT DISTINCT FROM ct.user_id AND k.key_prefix = left(ct.client_key, 8)
WHERE ct.request_id LIKE 'mcp-%' AND ct.created_at >= $SINCE
ORDER BY ct.created_at DESC LIMIT 20;

\\echo '--- Сесії та відмови авторизації (mcp_access_log) ---'
SELECT outcome, transport, auth_method, key_prefix, count(*) AS events,
       count(DISTINCT client_ip) AS ips, max(created_at) AS last_at
FROM mcp_access_log
WHERE $LOG_FILTER AND created_at >= $SINCE
GROUP BY 1, 2, 3, 4 ORDER BY events DESC;
SQL

echo "=== Позначки (IP/день > $MAX_IPS, викликів/день > $MAX_CALLS, МБ/день > $MAX_MB) ==="
FLAGS=$(run_sql -tA <<SQL
SELECT day || ' ' || key_name || ': ' || concat_ws(', ',
         CASE WHEN distinct_ips > $MAX_IPS THEN distinct_ips || ' різних IP (' || array_to_string(ips[1:10], ' ') || ')' END,
         CASE WHEN calls > $MAX_CALLS THEN calls || ' викликів' END,
         CASE WHEN response_bytes > $MAX_MB * 1048576 THEN round(response_bytes / 1048576.0, 1) || ' МБ віддано' END)
FROM mcp_key_usage_daily
WHERE $FILTER AND day >= ($SINCE)::date
  AND (distinct_ips > $MAX_IPS OR calls > $MAX_CALLS OR response_bytes > $MAX_MB * 1048576)
ORDER BY day DESC;
SELECT 'відмови авторизації: ' || count(*) || ' з ' || count(DISTINCT client_ip) || ' IP'
FROM mcp_access_log
WHERE $LOG_FILTER AND created_at >= $SINCE AND outcome <> 'session_opened'
HAVING count(*) > 0;
SQL
)

if [[ -n "$FLAGS" ]]; then
  echo "$FLAGS"
  exit 2
fi
echo "ознак нецільового використання немає"
