#!/usr/bin/env bash
# Щоденна перевірка MCP-ключів на legal_prod з листом, якщо є позначки.
#
# Запускається cron'ом на cthulhu (deployment/cron/mcp-key-usage-crontab). Для кожного
# користувача з MCP-активністю за останні DAYS днів запускає mcp-key-usage-report.sh;
# якщо звіт повернув 2 (позначки), повний звіт іде в лист. Окремо позначає масові
# відмови авторизації без відомого користувача (перебір ключів).
#
# Лист іде напряму через Azure Communication Services SMTP (smtp.azurecomm.net:587,
# STARTTLS). Логін і пароль беруться з SMTP_ENV_FILE (~/.acs-smtp.env, chmod 600:
# ACS_SMTP_USER=..., ACS_SMTP_PASS=...). Відправник має бути дозволеним в ACS
# (vladimir@legal.org.ua). Без файлу — відправка без автентифікації на SMTP_HOST
# (напр. relay mail2 10.88.0.9:25, коли WireGuard до нього працює).
#
# Env: MAIL_TO (vladimir@legal.org.ua), MAIL_FROM (vladimir@legal.org.ua),
#      SMTP_HOST (smtp.azurecomm.net), SMTP_PORT (587), SMTP_ENV_FILE (~/.acs-smtp.env),
#      DAYS (1), MAX_ANON_REFUSED_PER_DAY (50),
#      DRY_RUN=1 — надрукувати лист замість відправки,
#      пороги звіту MAX_IPS_PER_DAY / MAX_CALLS_PER_DAY / MAX_MB_PER_DAY передаються далі.
# Код виходу: 0 — позначок немає, 2 — лист надіслано, 1 — помилка.

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
MAIL_TO="${MAIL_TO:-vladimir@legal.org.ua}"
MAIL_FROM="${MAIL_FROM:-vladimir@legal.org.ua}"
SMTP_HOST="${SMTP_HOST:-smtp.azurecomm.net}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_ENV_FILE="${SMTP_ENV_FILE-$HOME/.acs-smtp.env}"
DAYS="${DAYS:-1}"
MAX_ANON="${MAX_ANON_REFUSED_PER_DAY:-50}"
export SSH_HOST=""   # run psql on this host

[[ "$DAYS$MAX_ANON" =~ ^[0-9]+$ ]] || { echo "DAYS / MAX_ANON_REFUSED_PER_DAY мають бути числами" >&2; exit 1; }

PSQL=(docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local -v ON_ERROR_STOP=1 -tA)

echo "[$(date -Is)] MCP key check, last $DAYS day(s)"

if ! USERS=$("${PSQL[@]}" <<SQL
SELECT DISTINCT email FROM mcp_key_usage_daily
 WHERE day >= (now() - interval '$DAYS days')::date AND email IS NOT NULL
UNION
SELECT DISTINCT u.email FROM mcp_access_log l JOIN users u ON u.id = l.user_id
 WHERE l.created_at >= now() - interval '$DAYS days' AND l.outcome <> 'session_opened'
ORDER BY 1;
SQL
); then
  echo "не вдалося отримати список користувачів" >&2
  exit 1
fi

BODY=""
FLAGGED=()
for email in $USERS; do
  out=$("$DIR/mcp-key-usage-report.sh" "$email" "$DAYS" 2>&1)
  rc=$?
  if [[ $rc -eq 2 ]]; then
    FLAGGED+=("$email")
    BODY+=$'\n\n'"################ $email ################"$'\n'"$out"
  elif [[ $rc -ne 0 ]]; then
    echo "звіт для $email завершився з кодом $rc:" >&2
    echo "$out" >&2
    exit 1
  fi
done

ANON=$("${PSQL[@]}" <<SQL
SELECT outcome || ': ' || count(*) || ' з ' || count(DISTINCT client_ip) || ' IP ('
       || array_to_string((array_agg(DISTINCT host(client_ip)))[1:10], ' ') || ')'
  FROM mcp_access_log
 WHERE created_at >= now() - interval '$DAYS days' AND user_id IS NULL AND outcome <> 'session_opened'
 GROUP BY outcome
HAVING count(*) > $MAX_ANON * $DAYS;
SQL
) || { echo "не вдалося перевірити анонімні відмови" >&2; exit 1; }

if [[ -n "$ANON" ]]; then
  FLAGGED+=("анонімні відмови")
  BODY+=$'\n\n'"################ Відмови авторизації без користувача (перебір ключів?) ################"$'\n'"$ANON"
fi

if [[ ${#FLAGGED[@]} -eq 0 ]]; then
  echo "позначок немає ($(echo "$USERS" | grep -c . ) користувачів перевірено)"
  exit 0
fi

SUBJECT="MCP legal.org.ua: позначки використання ключів — ${FLAGGED[*]}"
INTRO="Щоденна перевірка MCP-ключів legal.org.ua за останні $DAYS дн. знайшла позначки.
Пороги: IP/день > ${MAX_IPS_PER_DAY:-3}, викликів/день > ${MAX_CALLS_PER_DAY:-500}, МБ/день > ${MAX_MB_PER_DAY:-50}, анонімних відмов/день > $MAX_ANON.
Повторити вручну: ./scripts/mcp-key-usage-report.sh <email> 30"

if [[ "${DRY_RUN:-}" == 1 ]]; then
  printf 'To: %s\nSubject: %s\n\n%s%s\n' "$MAIL_TO" "$SUBJECT" "$INTRO" "$BODY"
  exit 2
fi

SUBJECT="$SUBJECT" INTRO="$INTRO" BODY="$BODY" MAIL_TO="$MAIL_TO" MAIL_FROM="$MAIL_FROM" \
SMTP_HOST="$SMTP_HOST" SMTP_PORT="$SMTP_PORT" SMTP_ENV_FILE="$SMTP_ENV_FILE" python3 - <<'PY' || { echo "лист не надіслано" >&2; exit 1; }
import os, smtplib
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
m = EmailMessage()
m["From"] = os.environ["MAIL_FROM"]
m["To"] = os.environ["MAIL_TO"]
m["Subject"] = os.environ["SUBJECT"]
m["Date"] = formatdate(localtime=True)
m["Message-ID"] = make_msgid(domain=os.environ["MAIL_FROM"].split("@")[1])
m.set_content(os.environ["INTRO"] + os.environ["BODY"] + "\n")
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

echo "лист надіслано на $MAIL_TO: ${FLAGGED[*]}"
exit 2
