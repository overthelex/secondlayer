#!/usr/bin/env bash
# Аларм безпеки MCP / API-ключів на legal_prod (cthulhu): кожні 5 хвилин, лист лише коли є події.
#
# Доповнює щоденний mcp-key-usage-alert.sh (обсяги), тут — спроби зробити недозволене:
#   1. Відмови відомим клієнтам (mcp_access_log): tool_denied (інструмент поза доступом —
#      операторський або поза v2 для ключа), endpoint_denied (клієнтський ключ sl_ не на
#      /api/v2/mcp), rate_limited, auth_failed, invalid_api_key з префіксом sl_
#      (відкликаний ключ або підбір; відкликаний позначено окремо).
#   2. Клієнтський ключ sl_ у cost_tracking поза v2/mcp — детектор обходу (після PR з
#      tool-access-policy має бути завжди порожньо; не порожньо = знайшли нову діру).
#   3. Відповідь більша за MAX_RESPONSE_MB (масове вивантаження).
#   4. Для WATCH_EMAILS (клієнти під наглядом): новий IP, якого не було раніше, і вхід у веб.
#   5. Сканування сайту по аналітиці Cloudflare (scripts/http_scan_alert.py): сканерні шляхи
#      (/.env, /.git, /.aws, swagger, actuator, phpinfo, wp-…), нестандартні порти (:8080/:8443),
#      перебір багатьох шляхів з 403/404 з одного IP. Бекенд цього трафіку не бачить (SPA або
#      WAF), тому без цієї секції сканер вразливостей проходив повз аларм. Потребує
#      CF_ENV_FILE (~/SecondLayer/.env.cloudflare: CLOUDFLARE_GLOBAL_API_KEY, CLOUDFLARE_EMAIL);
#      без нього секція пропускається з попередженням у лог.
#
# Вікно: від позначки в STATE_FILE до now() з БД; позначка зсувається лише після успішного
# листа (або коли подій немає), тож подія не губиться, якщо SMTP впав.
#
# Env: MAIL_TO / MAIL_FROM (vladimir@legal.org.ua), SMTP_HOST / SMTP_PORT / SMTP_ENV_FILE —
#      як у mcp-key-usage-alert.sh; WATCH_EMAILS (через кому, mrbraun013@gmail.com),
#      MAX_RESPONSE_MB (5), STATE_FILE (~/.mcp-security-alert.since),
#      CF_ENV_FILE (<repo>/.env.cloudflare), SCAN_MIN_HITS (3), PROBE_MIN_PATHS (20),
#      DRY_RUN=1 — надрукувати лист і не зсувати позначку.
# Код виходу: 0 — подій немає, 2 — лист надіслано (або DRY_RUN), 1 — помилка.
#
# Cron на cthulhu (vovkes), кожні 5 хв. Файл лежить не в deployment/, бо зміна там
# запускає повний перезбір обох продів:
#   */5 * * * * mkdir -p $HOME/logs && WATCH_EMAILS=mrbraun013@gmail.com /home/vovkes/SecondLayer/scripts/mcp-security-alert.sh >> $HOME/logs/mcp-security-alert.log 2>&1

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
MAIL_TO="${MAIL_TO:-vladimir@legal.org.ua}"
MAIL_FROM="${MAIL_FROM:-vladimir@legal.org.ua}"
SMTP_HOST="${SMTP_HOST:-smtp.azurecomm.net}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_ENV_FILE="${SMTP_ENV_FILE-$HOME/.acs-smtp.env}"
WATCH_EMAILS="${WATCH_EMAILS:-mrbraun013@gmail.com}"
MAX_RESPONSE_MB="${MAX_RESPONSE_MB:-5}"
STATE_FILE="${STATE_FILE:-$HOME/.mcp-security-alert.since}"
CF_ENV_FILE="${CF_ENV_FILE-$DIR/../.env.cloudflare}"
SCAN_MIN_HITS="${SCAN_MIN_HITS:-3}"
PROBE_MIN_PATHS="${PROBE_MIN_PATHS:-20}"

[[ "$MAX_RESPONSE_MB" =~ ^[0-9]+$ ]] || { echo "MAX_RESPONSE_MB має бути числом" >&2; exit 1; }
[[ "$SCAN_MIN_HITS$PROBE_MIN_PATHS" =~ ^[0-9]+$ ]] || { echo "SCAN_MIN_HITS / PROBE_MIN_PATHS мають бути числами" >&2; exit 1; }
[[ "$WATCH_EMAILS" =~ ^[A-Za-z0-9._%+@,-]*$ ]] || { echo "WATCH_EMAILS: недопустимі символи" >&2; exit 1; }

PSQL=(docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local -v ON_ERROR_STOP=1 -X -q)

NOW=$("${PSQL[@]}" -tA -c "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')") \
  || { echo "БД недоступна" >&2; exit 1; }
if [[ -s "$STATE_FILE" ]]; then
  SINCE=$(<"$STATE_FILE")
else
  SINCE=$("${PSQL[@]}" -tA -c "SELECT to_char((now() - interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")
fi
[[ "$SINCE" =~ ^[0-9T:.Z-]+$ ]] || { echo "зіпсований $STATE_FILE: $SINCE" >&2; exit 1; }

WATCH_SQL="ARRAY(SELECT lower(trim(x)) FROM unnest(string_to_array('$WATCH_EMAILS', ',')) x WHERE trim(x) <> '')"
win() { echo "$1.created_at > '$SINCE'::timestamptz AND $1.created_at <= '$NOW'::timestamptz"; }

# Кожна секція: заголовок | SQL count | SQL таблиця (psql -H).
# Порожні масиви ініціалізуємо явно: під set -u `declare -a X` без присвоєння лишає X unset,
# і ${#X[@]} у тихому запуску падає з «unbound variable» (позначка тоді не зсувається).
TITLES=(); COUNTS=(); TABLES=()

section() {
  local title="$1" sql="$2" n
  n=$("${PSQL[@]}" -tA -c "SELECT count(*) FROM ($sql) s") || { echo "запит «$title» не вдався" >&2; exit 1; }
  if [[ "$n" -gt 0 ]]; then
    TITLES+=("$title"); COUNTS+=("$n")
    TABLES+=("$("${PSQL[@]}" -H -c "$sql LIMIT 50")")
  fi
}

section "Відмови відомим клієнтам і використання ключів sl_ поза дозволеним" "
SELECT to_char(l.created_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI:SS') AS kyiv_time,
       coalesce(u.email, ku.email, '—') AS email, l.outcome, l.transport,
       l.key_prefix, CASE WHEN k.is_active = false THEN 'ВІДКЛИКАНИЙ' ELSE '' END AS key_state,
       host(l.client_ip) AS ip, left(l.user_agent, 40) AS user_agent, left(l.detail, 120) AS detail
  FROM mcp_access_log l
  LEFT JOIN users u ON u.id = l.user_id
  LEFT JOIN api_keys k ON l.key_prefix IS NOT NULL AND left(k.key, 12) = l.key_prefix
  LEFT JOIN users ku ON ku.id = k.user_id
 WHERE $(win l)
   AND (l.outcome IN ('tool_denied', 'endpoint_denied', 'rate_limited', 'auth_failed')
        OR (l.outcome = 'invalid_api_key' AND l.key_prefix LIKE 'sl\_%'))
 ORDER BY l.created_at DESC"

section "Клієнтський ключ sl_ виконав інструмент НЕ через /api/v2/mcp (обхід!)" "
SELECT to_char(c.created_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI:SS') AS kyiv_time,
       u.email, c.tool_name, coalesce(c.mcp_transport, 'REST/legacy') AS transport, c.status,
       left(c.client_key, 12) AS key_prefix, host(c.client_ip) AS ip
  FROM cost_tracking c JOIN users u ON u.id = c.user_id
 WHERE $(win c) AND c.client_key LIKE 'sl\_%'
   AND coalesce(c.mcp_transport, '') <> 'v2/mcp'
   AND NOT (coalesce(u.is_admin, false) OR u.role = 'administrator')
 ORDER BY c.created_at DESC"

section "Відповіді більші за ${MAX_RESPONSE_MB} МБ (масове вивантаження?)" "
SELECT to_char(c.created_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI:SS') AS kyiv_time,
       u.email, c.tool_name, round(c.response_bytes / 1048576.0, 1) AS mb,
       c.mcp_transport, host(c.client_ip) AS ip
  FROM cost_tracking c LEFT JOIN users u ON u.id = c.user_id
 WHERE $(win c) AND c.response_bytes > ${MAX_RESPONSE_MB} * 1048576
 ORDER BY c.response_bytes DESC"

section "Клієнт під наглядом: новий IP" "
WITH w AS (SELECT id, email FROM users WHERE lower(email) = ANY($WATCH_SQL)),
seen AS (
  SELECT user_id, client_ip, created_at, 'mcp-call' AS src FROM cost_tracking WHERE user_id IN (SELECT id FROM w) AND client_ip IS NOT NULL
  UNION ALL
  SELECT user_id, client_ip, created_at, 'mcp-' || outcome FROM mcp_access_log WHERE user_id IN (SELECT id FROM w) AND client_ip IS NOT NULL)
SELECT w.email, host(s.client_ip) AS ip, min(s.src) AS first_via,
       to_char(min(s.created_at) AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI:SS') AS first_seen_kyiv
  FROM seen s JOIN w ON w.id = s.user_id
 GROUP BY w.email, s.client_ip
HAVING min(s.created_at) > '$SINCE'::timestamptz AND min(s.created_at) <= '$NOW'::timestamptz"

section "Клієнт під наглядом: вхід у веб-кабінет" "
SELECT email, to_char((last_login AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI:SS') AS last_login_kyiv  -- users.last_login: timestamp без зони, UTC
  FROM users
 WHERE lower(email) = ANY($WATCH_SQL)
   AND last_login > ('$SINCE'::timestamptz AT TIME ZONE 'UTC') AND last_login <= ('$NOW'::timestamptz AT TIME ZONE 'UTC')"

# 5. Сканування сайту: аналітика Cloudflare, бо фронтенд/WAF у БД не пишуть.
if [[ -n "$CF_ENV_FILE" && -r "$CF_ENV_FILE" ]]; then
  if CF_OUT=$(set -a; . "$CF_ENV_FILE"; set +a; \
        SINCE="$SINCE" NOW="$NOW" SCAN_MIN_HITS="$SCAN_MIN_HITS" PROBE_MIN_PATHS="$PROBE_MIN_PATHS" \
        PSQL_CMD="${PSQL[*]}" python3 "$DIR/http_scan_alert.py"); then
    CF_N="${CF_OUT%%$'\n'*}"
    if [[ "$CF_N" =~ ^[0-9]+$ && "$CF_N" -gt 0 ]]; then
      TITLES+=("Сканування сайту: підозрілі IP за аналітикою Cloudflare"); COUNTS+=("$CF_N")
      TABLES+=("${CF_OUT#*$'\n'}")
    fi
  else
    echo "[$(date -Is)] секцію Cloudflare пропущено (http_scan_alert.py повернув помилку)" >&2
  fi
else
  echo "[$(date -Is)] секцію Cloudflare пропущено: немає $CF_ENV_FILE" >&2
fi

advance() { [[ "${DRY_RUN:-}" == 1 ]] || printf '%s\n' "$NOW" > "$STATE_FILE"; }

if [[ ${#TITLES[@]} -eq 0 ]]; then
  advance
  exit 0
fi

SUMMARY=""
BODY=""
for i in "${!TITLES[@]}"; do
  SUMMARY+="${TITLES[$i]}: ${COUNTS[$i]}"$'\n'
  BODY+=$'\n'"################ ${TITLES[$i]} (${COUNTS[$i]}) ################"$'\n'"${TABLES[$i]}"
done
SUBJECT="⚠ MCP legal.org.ua: подія безпеки — ${TITLES[0]}$([[ ${#TITLES[@]} -gt 1 ]] && echo " (+$(( ${#TITLES[@]} - 1 )))")"
INTRO="Аларм безпеки MCP / API-ключів legal.org.ua, вікно $SINCE … $NOW (UTC).
${SUMMARY}Клієнти під наглядом: $WATCH_EMAILS. Показано до 50 рядків на секцію.
Деталі: ./scripts/mcp-key-usage-report.sh <email> 7; відключити ключ: UPDATE api_keys SET is_active=false WHERE left(key,12)='<key_prefix>';
Заблокувати IP у Cloudflare: ./scripts/cf-block-ip.sh <ip> \"<примітка>\" (IP Access Rule, зона legal.org.ua)."

echo "[$(date -Is)] $SINCE..$NOW: ${SUMMARY//$'\n'/; }"

if [[ "${DRY_RUN:-}" == 1 ]]; then
  printf 'To: %s\nSubject: %s\n\n%s\n%s\n' "$MAIL_TO" "$SUBJECT" "$INTRO" "$BODY"
  exit 2
fi

SUBJECT="$SUBJECT" INTRO="$INTRO" HTML_BODY="$BODY" MAIL_DIR="$DIR" MAIL_TO="$MAIL_TO" MAIL_FROM="$MAIL_FROM" \
SMTP_HOST="$SMTP_HOST" SMTP_PORT="$SMTP_PORT" SMTP_ENV_FILE="$SMTP_ENV_FILE" python3 - <<'PY' || { echo "лист не надіслано, позначку не зсунуто" >&2; exit 1; }
import os, re, smtplib, sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
sys.path.insert(0, os.environ["MAIL_DIR"])
from mcp_key_usage_mail import render_html
m = EmailMessage()
m["From"] = os.environ["MAIL_FROM"]
m["To"] = os.environ["MAIL_TO"]
m["Subject"] = os.environ["SUBJECT"]
m["Date"] = formatdate(localtime=True)
m["Message-ID"] = make_msgid(domain=os.environ["MAIL_FROM"].split("@")[1])
m["X-Priority"] = "1"
plain = re.sub(r"<[^>]+>", " ", os.environ["HTML_BODY"])
m.set_content(os.environ["INTRO"] + "\n" + plain + "\n")
m.add_alternative(render_html(os.environ["SUBJECT"], os.environ["INTRO"], os.environ["HTML_BODY"]), subtype="html")
creds = {}
env_file = os.environ.get("SMTP_ENV_FILE", "")
if env_file:
    with open(env_file) as f:  # KEY=VALUE lines; never echoed
        for line in f:
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.rstrip("\n").split("=", 1)
                creds[k.strip()] = v.strip().strip('"').strip("'")
with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ["SMTP_PORT"]), timeout=30) as s:
    s.ehlo("cthulhu")
    if creds:
        s.starttls()
        s.ehlo("cthulhu")
        s.login(creds["ACS_SMTP_USER"], creds["ACS_SMTP_PASS"])
    s.send_message(m)
print("sent:", m["Message-ID"])
PY

advance
exit 2
