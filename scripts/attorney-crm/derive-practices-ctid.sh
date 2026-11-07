#!/usr/bin/env bash
# One-off backfill of attorney_crm_practice_cases in physical (ctid) order; see
# attorney_crm/sql/003_ctid_backfill.sql for why this beats the doc_id walk on the HDD.
#   ./derive-practices-ctid.sh 2024          one stream over the 2024 partition
#   ./derive-practices-ctid.sh 2024 1 2      shard 1 of 2 (chunk % 2 = 1), run the
#                                            other shard in its own tmux session
# Resumable: progress lives in attorney_crm_ctid_progress; rerun to continue.
# Refresh the stems snapshot first: SELECT attorney_crm_refresh_stems();
set -euo pipefail

Y="${1:?year}"
SHARD="${2:-0}"
SHARDS="${3:-1}"
PG_CONTAINER="${PG_CONTAINER:-secondlayer-postgres-local}"
PG_USER="${PG_USER:-secondlayer}"
PG_DB="${PG_DB:-secondlayer_local}"
CHUNK_BLOCKS="${CHUNK_BLOCKS:-512}"
LOG="${LOG:-$HOME/attorney-crm-derive-ctid.log}"

psql_q() { sudo docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -Atq -v ON_ERROR_STOP=1 -c "$1"; }
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

TAG="year $Y shard $SHARD/$SHARDS"
WHERE="partition_year=$Y AND shard=$SHARD"
[ "$(psql_q 'SELECT count(*) FROM attorney_crm_advocate_stems;')" != "0" ] || { log "stems snapshot is empty, run attorney_crm_refresh_stems() first"; exit 1; }
log "$TAG: start"
n=0
while :; do
  out=$(psql_q "SET statement_timeout='600s'; SELECT out_docs||'|'||out_hits||'|'||out_chunk||'/'||out_chunks FROM attorney_crm_derive_ctid_batch($Y, $SHARD, $SHARDS, $CHUNK_BLOCKS);")
  n=$((n+1))
  if (( n % 20 == 0 )); then
    log "$TAG: chunk $out ; total $(psql_q "SELECT docs_scanned||' docs, '||hits||' hits' FROM attorney_crm_ctid_progress WHERE $WHERE;")"
  fi
  [ "$(psql_q "SELECT done FROM attorney_crm_ctid_progress WHERE $WHERE;")" = "t" ] && break
done
log "$TAG: done, $(psql_q "SELECT docs_scanned||' docs, '||hits||' hits' FROM attorney_crm_ctid_progress WHERE $WHERE;")"
log "refreshing attorney_crm_practice_stats"
psql_q "SET statement_timeout='0'; REFRESH MATERIALIZED VIEW attorney_crm_practice_stats;"
log "done: $(psql_q 'SELECT count(DISTINCT advocate_source_id)||'' advocates, ''||count(*)||'' cases'' FROM attorney_crm_practice_cases;')"
