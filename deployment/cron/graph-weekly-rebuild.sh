#!/bin/bash
# Weekly rebuild of the ЄДР relationship graph (schema graph, LEXAI-2303 / LEXAI-2320)
# on cthulhu (legal_prod), user vovkes, after the weekly ЄДР sync.
#
# Order: edrpou-weekly-sync.sh (Tue 03:30) starts openreyestr-edrpou-sync-weekly and returns;
# this script (Tue 06:00) waits until that sync has finished successfully, then runs
# `node dist/scripts/build-graph.js` (full rebuild via graph_stage + swap, one row in
# graph.build) in a one-off container openreyestr-graph-build from the deployed openreyestr
# image, never concurrently with a sync. A deploy that recreates openreyestr-app-local does not
# kill the build. DB credentials are copied from the running app container into a temp env file
# (chmod 600, removed on exit): nothing secret lives in this file or in the crontab.
#
# Sync verdict (log /data/edrpou-sync/sync-edrpou-<YYYYMMDD>.log of the same day, SYNC_DATE
# overrides): no openreyestr-edrpou-sync* container running, the log has "SYNC SUMMARY", the
# summary has "UO: completed" and no failed UO/FSU line. A failed FOP import only warns (the
# graph does not read FOP). Failed / died / not finished within WAIT_HOURS → no build, exit 1.
#
# After the build: the newest full graph.build row must be from this run, and node / edge counts
# must not drop more than MAX_DROP_PCT vs the previous full build. Free disk on / is printed
# before and after; the build refuses to start below MIN_FREE_GB (peak ~25–30 GB).
#
# Failures are mailed like scripts/mcp-key-usage-alert.sh: Azure Communication Services SMTP
# (smtp.azurecomm.net:587, STARTTLS, credentials from SMTP_ENV_FILE ~/.acs-smtp.env) to MAIL_TO.
# The log line "GRAPH-REBUILD FAILED: ..." is written in any case.
#
# Install (merge into the existing crontab; do not run the build by hand while a sync runs):
#   crontab -l | cat - ~/SecondLayer/deployment/cron/graph-crontab | crontab -
# i.e.
#   0 6 * * 2 mkdir -p $HOME/logs && /home/vovkes/SecondLayer/deployment/cron/graph-weekly-rebuild.sh >> $HOME/logs/graph-weekly-rebuild.log 2>&1
#
# Usage: graph-weekly-rebuild.sh [--dry-run] [--check] [--no-wait]
#   --dry-run  discover containers/env, report the sync verdict and graph.build state, print the
#              docker command; starts no container, writes nothing to the DB, sends no mail.
#   --check    only the post-build check of the newest two graph.build rows (read-only).
#   --no-wait  judge the sync log once instead of waiting.
# Env: SYNC_DATE (YYYYMMDD, default today), SYNC_DIR (/data/edrpou-sync), WAIT_HOURS (10), POLL_MINUTES (10),
#      BUILD_TIMEOUT_HOURS (6), MAX_DROP_PCT (10), MIN_FREE_GB (60), BUILD_ARGS (extra
#      build-graph.js flags), NOTIFY (1), MAIL_TO / MAIL_FROM (vladimir@legal.org.ua),
#      SMTP_HOST / SMTP_PORT / SMTP_ENV_FILE.
# Exit: 0 — built and checked, or nothing to do; 1 — failure (mailed).
#
# Logs: /mnt/bulk_storage/opendata/graph-build/build-<date>.log (HDD), 60 days kept.

set -euo pipefail

APP_CONTAINER=openreyestr-app-local
JOB_CONTAINER=openreyestr-graph-build
SYNC_PREFIX=openreyestr-edrpou-sync
SYNC_DIR="${SYNC_DIR:-/data/edrpou-sync}"
WORK_DIR=/mnt/bulk_storage/opendata/graph-build
SYNC_DATE="${SYNC_DATE:-$(date +%Y%m%d)}"
SYNC_LOG="$SYNC_DIR/sync-edrpou-${SYNC_DATE}.log"
WAIT_HOURS="${WAIT_HOURS:-10}"
POLL_MINUTES="${POLL_MINUTES:-10}"
BUILD_TIMEOUT_HOURS="${BUILD_TIMEOUT_HOURS:-6}"
MAX_DROP_PCT="${MAX_DROP_PCT:-10}"
MIN_FREE_GB="${MIN_FREE_GB:-60}"
BUILD_ARGS="${BUILD_ARGS:-}"
NOTIFY="${NOTIFY:-1}"
MAIL_TO="${MAIL_TO:-vladimir@legal.org.ua}"
MAIL_FROM="${MAIL_FROM:-vladimir@legal.org.ua}"
SMTP_HOST="${SMTP_HOST:-smtp.azurecomm.net}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_ENV_FILE="${SMTP_ENV_FILE-$HOME/.acs-smtp.env}"

DRY_RUN=0
CHECK_ONLY=0
NO_WAIT=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --check) CHECK_ONLY=1 ;;
    --no-wait) NO_WAIT=1 ;;
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
for v in "$WAIT_HOURS" "$POLL_MINUTES" "$BUILD_TIMEOUT_HOURS" "$MAX_DROP_PCT" "$MIN_FREE_GB"; do
  [[ "$v" =~ ^[0-9]+$ ]] || { echo "WAIT_HOURS / POLL_MINUTES / BUILD_TIMEOUT_HOURS / MAX_DROP_PCT / MIN_FREE_GB must be integers" >&2; exit 2; }
done
[[ "$SYNC_DATE" =~ ^[0-9]{8}$ ]] || { echo "SYNC_DATE must be YYYYMMDD" >&2; exit 2; }

log() { echo "$(date -Is) $*"; }

notify() {  # notify <subject> <body>
  if [[ "$DRY_RUN" == 1 || "$NOTIFY" != 1 ]]; then
    log "(mail not sent) To: $MAIL_TO Subject: $1"
    return 0
  fi
  SUBJECT="$1" BODY="$2" MAIL_TO="$MAIL_TO" MAIL_FROM="$MAIL_FROM" SMTP_HOST="$SMTP_HOST" \
  SMTP_PORT="$SMTP_PORT" SMTP_ENV_FILE="$SMTP_ENV_FILE" python3 - <<'PY' || log "WARNING: alert mail not sent"
import os, smtplib
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
m = EmailMessage()
m["From"] = os.environ["MAIL_FROM"]
m["To"] = os.environ["MAIL_TO"]
m["Subject"] = os.environ["SUBJECT"]
m["Date"] = formatdate(localtime=True)
m["Message-ID"] = make_msgid(domain=os.environ["MAIL_FROM"].split("@")[1])
m.set_content(os.environ["BODY"] + "\n")
creds = {}
env_file = os.environ.get("SMTP_ENV_FILE", "")
if env_file and os.path.exists(env_file):
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
print("alert sent:", m["Message-ID"])
PY
}

fail() {  # fail <message> [details]
  log "GRAPH-REBUILD FAILED: $1"
  notify "Граф ЄДР: тижнева перебудова не вдалася — $1" \
    "$(printf '%s\n\nХост: %s\nЛог cron: ~/logs/graph-weekly-rebuild.log\nЛоги збірки: %s\nЛог синхронізації ЄДР: %s\n\n%s' \
      "$1" "$(hostname)" "$WORK_DIR" "$SYNC_LOG" "${2:-}")"
  exit 1
}

disk() { log "free disk on /: $(df -h --output=avail / | tail -1 | tr -d ' ') ($1)"; }
free_gb() { df -BG --output=avail / | tail -1 | tr -dc '0-9'; }

running() { docker ps --format '{{.Names}}' | grep -E "$1" || true; }

# Read-only queries against graph.build, run inside the app container (it has the DB env and pg).
# graph_query last-finished → epoch seconds of the newest full build (empty if none)
# graph_query check <since-epoch|0> <max-drop-pct> → "OK ..." / "FAIL ..." lines, exit 1 on FAIL
graph_query() {
  docker exec -i -e Q_MODE="$1" -e Q_SINCE="${2:-0}" -e Q_MAX_DROP="${3:-10}" "$APP_CONTAINER" node - <<'JS'
const { Pool } = require('pg');
const e = process.env;
const pool = new Pool({ host: e.POSTGRES_HOST, port: Number(e.POSTGRES_PORT || 5432), user: e.POSTGRES_USER,
  password: e.POSTGRES_PASSWORD, database: e.POSTGRES_DB, max: 1 });
const sumNodes = (c) => Object.keys(c).filter((k) => k.startsWith('nodes_')).reduce((s, k) => s + Number(c[k] || 0), 0);
(async () => {
  const { rows } = await pool.query(`SELECT id, started_at, finished_at, counts, seconds FROM graph.build
    WHERE params->>'limit' IS NULL ORDER BY id DESC LIMIT 2`);
  if (e.Q_MODE === 'last-finished') {
    console.log(rows[0] ? Math.floor(new Date(rows[0].finished_at).getTime() / 1000) : '');
    return 0;
  }
  if (!rows.length) { console.log('FAIL no full build row in graph.build'); return 1; }
  const [cur, prev] = rows;
  const since = Number(e.Q_SINCE || 0);
  const desc = (r) => `#${r.id} started ${r.started_at.toISOString()} finished ${r.finished_at.toISOString()}: ` +
    `nodes ${sumNodes(r.counts)}, edges ${Number(r.counts.edges || 0)}, ` +
    `bytes ${Number(r.counts.bytes_node || 0) + Number(r.counts.bytes_edge || 0)}, took ${Math.round((r.finished_at - r.started_at) / 1000)} s`;
  console.log(`INFO newest   ${desc(cur)}`);
  if (prev) console.log(`INFO previous ${desc(prev)}`);
  let bad = 0;
  if (since && cur.started_at.getTime() / 1000 < since - 120) {
    console.log(`FAIL newest graph.build row #${cur.id} is older than this run: the build did not finish`); bad = 1;
  }
  if (!cur.finished_at) { console.log(`FAIL graph.build row #${cur.id} has no finished_at`); bad = 1; }
  if (!(Number(cur.counts.edges) > 0) || !(sumNodes(cur.counts) > 0)) { console.log(`FAIL row #${cur.id} has no nodes or edges`); bad = 1; }
  if (prev) {
    const maxDrop = Number(e.Q_MAX_DROP);
    for (const [what, a, b] of [['nodes', sumNodes(prev.counts), sumNodes(cur.counts)],
                                ['edges', Number(prev.counts.edges || 0), Number(cur.counts.edges || 0)]]) {
      const pct = a > 0 ? ((a - b) / a) * 100 : 0;
      const line = `${what} ${a} -> ${b} (${pct > 0 ? '-' : '+'}${Math.abs(pct).toFixed(2)}%)`;
      if (pct > maxDrop) { console.log(`FAIL ${line}, dropped more than ${maxDrop}%`); bad = 1; }
      else console.log(`OK ${line}`);
    }
  } else console.log('OK no previous full build to compare with');
  return bad;
})().then((code) => pool.end().then(() => process.exit(code)))
  .catch((err) => { console.log(`FAIL query error: ${err.message}`); process.exit(1); });
JS
}

post_check() {  # post_check <since-epoch|0>
  local out rc=0
  out=$(graph_query check "$1" "$MAX_DROP_PCT") || rc=$?
  while IFS= read -r l; do log "check: $l"; done <<< "$out"
  if [[ $rc -ne 0 ]]; then
    fail "post-build check: $(grep '^FAIL' <<< "$out" | head -3 | tr '\n' ';')" "$out"
  fi
  log "post-build check passed"
}

# Verdict on the sync log: prints done-ok / done-failed:<why> / died / running / missing.
sync_state() {
  if [[ -n "$(running "^${SYNC_PREFIX}")" ]]; then echo running; return; fi
  if [[ ! -f "$SYNC_LOG" ]]; then echo missing; return; fi
  local summary
  summary=$(tr '\r' '\n' < "$SYNC_LOG" | sed -n '/^SYNC SUMMARY/,$p')
  if [[ -z "$summary" ]]; then echo died; return; fi
  if grep -Eq '^ +(UO|FSU): failed' <<< "$summary"; then
    echo "done-failed:$(grep -E '^ +(UO|FSU): failed' <<< "$summary" | head -2 | sed 's/^ *//' | tr '\n' ';')"; return
  fi
  if ! grep -Eq '^ +UO: completed' <<< "$summary"; then echo "done-failed:no 'UO: completed' in the summary"; return; fi
  if grep -Eq '^ +FOP: failed' <<< "$summary"; then
    log "WARNING: FOP import failed in $SYNC_LOG (the graph does not use FOP, building anyway)" >&2
  fi
  echo done-ok
}

# ---------------------------------------------------------------------------------------------

exec 9>/tmp/graph-weekly-rebuild.lock
flock -n 9 || { log "another run holds the lock, skipping"; exit 0; }

if [[ -z "$(running "^${APP_CONTAINER}\$")" ]]; then
  fail "$APP_CONTAINER is not running"
fi
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$APP_CONTAINER")
NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$APP_CONTAINER" | awk '{print $1}')

if [[ "$CHECK_ONLY" == 1 ]]; then
  post_check 0
  exit 0
fi

if [[ -n "$(running "^${JOB_CONTAINER}\$")" ]]; then
  log "$JOB_CONTAINER is already running, skipping"
  exit 0
fi

log "app $APP_CONTAINER image $IMAGE network $NETWORK; waiting for $SYNC_LOG"

# Wait (bounded) for this week's ЄДР sync to finish.
deadline=$(( $(date +%s) + WAIT_HOURS * 3600 ))
while :; do
  state=$(sync_state)
  case "$state" in
    done-ok) log "ЄДР sync finished successfully ($SYNC_LOG)"; break ;;
    done-failed:*) fail "ЄДР sync failed, graph not rebuilt: ${state#done-failed:}" "$(tr '\r' '\n' < "$SYNC_LOG" | sed -n '/^SYNC SUMMARY/,$p' | head -20)" ;;
    died) fail "ЄДР sync container is gone but $SYNC_LOG has no SYNC SUMMARY (sync died), graph not rebuilt" "$(tr '\r' '\n' < "$SYNC_LOG" | tail -15)" ;;
  esac
  if [[ "$DRY_RUN" == 1 || "$NO_WAIT" == 1 ]]; then
    log "sync state: $state ($SYNC_LOG); would keep polling every ${POLL_MINUTES} min for up to ${WAIT_HOURS} h"
    [[ "$DRY_RUN" == 1 ]] && break
    fail "ЄДР sync not finished (state: $state), --no-wait given"
  fi
  if (( $(date +%s) >= deadline )); then
    fail "ЄДР sync did not finish within ${WAIT_HOURS} h (state: $state), graph not rebuilt"
  fi
  sleep $(( POLL_MINUTES * 60 ))
done

# Skip if a full build already ran after this sync (re-run of the cron job, manual build).
SYNC_DONE=0
[[ -f "$SYNC_LOG" ]] && SYNC_DONE=$(stat -c %Y "$SYNC_LOG")
LAST_BUILD=$(graph_query last-finished) || fail "cannot read graph.build"
if [[ -n "$LAST_BUILD" ]]; then
  log "newest full graph build finished $(date -Is -d "@$LAST_BUILD")"
  if [[ "$SYNC_DONE" -gt 0 && "$LAST_BUILD" -gt "$SYNC_DONE" ]]; then
    log "graph already rebuilt after this sync, nothing to do"
    [[ "$DRY_RUN" == 1 ]] || exit 0
  fi
fi

disk "before"
FREE=$(free_gb)
if (( FREE < MIN_FREE_GB )); then
  fail "only ${FREE} GB free on /, need ${MIN_FREE_GB} GB for the build (peak ~25–30 GB)"
fi

mkdir -p "$WORK_DIR"
# Keep two months of logs.
find "$WORK_DIR" -maxdepth 1 -name 'build-*.log' -mtime +60 -delete 2>/dev/null || true
STAMP=$(date +%Y-%m-%d-%H%M)
LOG="build-${STAMP}.log"
CMD="nice -n 19 node dist/scripts/build-graph.js ${BUILD_ARGS} > /work/${LOG} 2>&1"

ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
chmod 600 "$ENV_FILE"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" \
  | grep -E '^(NODE_ENV|TZ|POSTGRES_(HOST|PORT|USER|PASSWORD|DB))=' > "$ENV_FILE"
for k in POSTGRES_HOST POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
  grep -q "^$k=" "$ENV_FILE" || fail "$k is not set in $APP_CONTAINER"
done

RUN=(docker run -d --name "$JOB_CONTAINER"
  --network "$NETWORK"
  --env-file "$ENV_FILE"
  -e NODE_OPTIONS=--max-old-space-size=8192
  -v "$WORK_DIR:/work"
  --cpu-shares 256
  --no-healthcheck
  --entrypoint sh
  "$IMAGE" -c "$CMD")

if [[ "$DRY_RUN" == 1 ]]; then
  log "env file would carry: $(cut -d= -f1 "$ENV_FILE" | tr '\n' ' ')"
  log "would run: ${RUN[*]}"
  log "would wait up to ${BUILD_TIMEOUT_HOURS} h, then check graph.build (max drop ${MAX_DROP_PCT}%); current state:"
  graph_query check 0 "$MAX_DROP_PCT" | while IFS= read -r l; do log "check: $l"; done || true
  log "dry run: no container started, nothing written"
  exit 0
fi

# Last guard right before starting: no sync and no other build.
if [[ -n "$(running "^(${SYNC_PREFIX}|${JOB_CONTAINER}\$)")" ]]; then
  fail "a sync or build container appeared before start: $(running "^(${SYNC_PREFIX}|${JOB_CONTAINER}\$)" | tr '\n' ' ')"
fi

docker rm -f "$JOB_CONTAINER" >/dev/null 2>&1 || true
START=$(date +%s)
"${RUN[@]}" >/dev/null
log "started $JOB_CONTAINER from $IMAGE, log $WORK_DIR/$LOG"

# No --rm: keep the container until its exit code is read.
rc=0
EXIT_CODE=$(timeout "$(( BUILD_TIMEOUT_HOURS * 3600 ))" docker wait "$JOB_CONTAINER") || rc=$?
if [[ $rc -ne 0 ]]; then
  docker stop -t 60 "$JOB_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$JOB_CONTAINER" >/dev/null 2>&1 || true
  fail "build did not finish within ${BUILD_TIMEOUT_HOURS} h (stopped), see $WORK_DIR/$LOG" "$(tail -15 "$WORK_DIR/$LOG" 2>/dev/null)"
fi
docker rm -f "$JOB_CONTAINER" >/dev/null 2>&1 || true
log "build container exited with $EXIT_CODE after $(( $(date +%s) - START )) s"
disk "after"
if [[ "$EXIT_CODE" != 0 ]]; then
  fail "build-graph.js exited with $EXIT_CODE, see $WORK_DIR/$LOG" "$(tail -15 "$WORK_DIR/$LOG" 2>/dev/null)"
fi

post_check "$START"
log "graph rebuilt"
