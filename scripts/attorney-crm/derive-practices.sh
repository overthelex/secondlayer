#!/usr/bin/env bash
# One-off backfill of attorney_crm_practice_cases from ЄДРСР, year by year.
# Run on cthulhu inside tmux:  tmux new -s attorney-crm-derive './derive-practices.sh 2024 2025 2026'
# Resumable: the cursor lives in attorney_crm_practice_progress; rerun to continue.
# Progress: SELECT * FROM attorney_crm_practice_progress;
set -euo pipefail

YEARS=("$@")
[ ${#YEARS[@]} -gt 0 ] || YEARS=(2024 2025 2026)
PG_CONTAINER="${PG_CONTAINER:-secondlayer-postgres-local}"
PG_USER="${PG_USER:-secondlayer}"
PG_DB="${PG_DB:-secondlayer_local}"
BATCH="${BATCH:-2000}"
LAG_DAYS="${LAG_DAYS:-30}"
PAUSE="${PAUSE:-0.2}"
LOG="${LOG:-$HOME/attorney-crm-derive.log}"

psql_q() { sudo docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -Atq -v ON_ERROR_STOP=1 -c "$1"; }
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

log "stems snapshot: $(psql_q 'SELECT attorney_crm_refresh_stems();') advocates"

for Y in "${YEARS[@]}"; do
  log "year $Y: start, cursor $(psql_q "SELECT coalesce((SELECT last_doc_id FROM attorney_crm_practice_progress WHERE partition_year=$Y),0);")"
  n=0
  while :; do
    # statement_timeout guards one batch; a timeout aborts the batch without advancing the cursor.
    out=$(psql_q "SET statement_timeout='180s'; SELECT out_docs||'|'||out_with_text||'|'||out_hits||'|'||out_last_doc_id FROM attorney_crm_derive_batch($Y, $BATCH, $LAG_DAYS);")
    docs=${out%%|*}
    [ "$docs" = "0" ] && break
    n=$((n+1))
    if (( n % 50 == 0 )); then
      log "year $Y: batch $n → $out ; total $(psql_q "SELECT docs_scanned||' docs, '||hits||' hits' FROM attorney_crm_practice_progress WHERE partition_year=$Y;")"
    fi
    sleep "$PAUSE"
  done
  log "year $Y: done, $(psql_q "SELECT docs_scanned||' docs, '||docs_with_text||' with text, '||hits||' hits' FROM attorney_crm_practice_progress WHERE partition_year=$Y;")"
done

log "refreshing attorney_crm_practice_stats"
psql_q "SET statement_timeout='0'; REFRESH MATERIALIZED VIEW attorney_crm_practice_stats;"
log "done: $(psql_q 'SELECT count(DISTINCT advocate_source_id)||' advocates, '||count(*)||' cases' FROM attorney_crm_practice_cases;')"
