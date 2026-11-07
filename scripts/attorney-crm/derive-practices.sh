#!/usr/bin/env bash
# One-off backfill of attorney_crm_practice_cases from ЄДРСР.
#   ./derive-practices.sh 2024              one cursor for the year
#   ./derive-practices.sh 2024 2 4          shard 2 of 4 (doc_id % 4 = 2); run the
#                                           other shards in their own tmux sessions
# Resumable: cursors live in attorney_crm_practice_progress; rerun to continue.
# Progress: SELECT * FROM attorney_crm_practice_progress ORDER BY 1, 2;
set -euo pipefail

Y="${1:?year}"
SHARD="${2:-0}"
SHARDS="${3:-1}"
PG_CONTAINER="${PG_CONTAINER:-secondlayer-postgres-local}"
PG_USER="${PG_USER:-secondlayer}"
PG_DB="${PG_DB:-secondlayer_local}"
BATCH="${BATCH:-2000}"
LAG_DAYS="${LAG_DAYS:-30}"
PAUSE="${PAUSE:-0.2}"
LOG="${LOG:-$HOME/attorney-crm-derive.log}"

psql_q() { sudo docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -Atq -v ON_ERROR_STOP=1 -c "$1"; }
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

# Shard 0 refreshes the registry snapshot; the others wait for it (first row appears).
if [ "$SHARD" = "0" ]; then
  log "stems snapshot: $(psql_q 'SELECT attorney_crm_refresh_stems();') advocates"
else
  until [ "$(psql_q 'SELECT count(*) FROM attorney_crm_advocate_stems;')" != "0" ]; do sleep 5; done
fi

TAG="year $Y shard $SHARD/$SHARDS"
WHERE="partition_year=$Y AND shard=$SHARD"
log "$TAG: start, cursor $(psql_q "SELECT coalesce((SELECT last_doc_id FROM attorney_crm_practice_progress WHERE $WHERE),0);")"
n=0
while :; do
  # statement_timeout guards one batch; a timeout aborts the batch without advancing the cursor.
  out=$(psql_q "SET statement_timeout='180s'; SELECT out_docs||'|'||out_with_text||'|'||out_hits||'|'||out_last_doc_id FROM attorney_crm_derive_batch($Y, $BATCH, $LAG_DAYS, $SHARD, $SHARDS);")
  docs=${out%%|*}
  [ "$docs" = "0" ] && break
  n=$((n+1))
  if (( n % 50 == 0 )); then
    log "$TAG: batch $n → $out ; total $(psql_q "SELECT docs_scanned||' docs, '||hits||' hits' FROM attorney_crm_practice_progress WHERE $WHERE;")"
  fi
  sleep "$PAUSE"
done
log "$TAG: done, $(psql_q "SELECT docs_scanned||' docs, '||docs_with_text||' with text, '||hits||' hits' FROM attorney_crm_practice_progress WHERE $WHERE;")"

# Every shard refreshes when it finishes; the last one to finish leaves the view current.
log "refreshing attorney_crm_practice_stats"
psql_q "SET statement_timeout='0'; REFRESH MATERIALIZED VIEW attorney_crm_practice_stats;"
log "done: $(psql_q 'SELECT count(DISTINCT advocate_source_id)||' advocates, '||count(*)||' cases' FROM attorney_crm_practice_cases;')"
