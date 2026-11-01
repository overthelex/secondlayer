#!/usr/bin/env bash
# backfill-edrsr-parties.sh  (LEXAI-1760)
#
# Fills edrsr_parties for one adjudication year with the extractor from migration 239.
# Shards edrsr_fulltext_p_<year> into N disjoint HEAP-BLOCK windows and runs one
# edrsr_backfill_parties_range() per window concurrently. Each window walks its blocks in
# physical (ctid) order, so the HDD-backed TOAST is read sequentially, and commits a
# checkpoint (edrsr_parties_progress.next_block) every chunk.
#
# Resumable: re-running the same year reuses the windows recorded in edrsr_parties_progress
# and every window continues from its checkpoint; finished windows are no-ops. When every
# window is done the year is marked covered (edrsr_parties_mark_covered) and the read path
# (count_cases_by_party, search_court_decisions party_role) starts serving it from the table.
#
# Run ON the DB host (uses `docker exec`), inside tmux, off-peak:
#   tmux new -d -s parties 'scripts/edrsr/backfill-edrsr-parties.sh 2024 4 > ~/parties_2024.log 2>&1'
#
# Usage:
#   backfill-edrsr-parties.sh <year> [workers=4] [chunk_blocks=2000]
#   backfill-edrsr-parties.sh status
#   backfill-edrsr-parties.sh reset <year>   # forget a year (rows, checkpoints, coverage) to
#                                            # re-extract it after an extractor change
#
# Env: PG_CONTAINER (default secondlayer-postgres-local). DB and user come from the
# container's own POSTGRES_DB / POSTGRES_USER.
set -euo pipefail

CONTAINER="${PG_CONTAINER:-secondlayer-postgres-local}"

# Bulk maintenance, not a request: no statement timeout; never wait long on a lock.
psql_q() {
  docker exec -i -e PGOPTIONS='-c statement_timeout=0 -c lock_timeout=60s' "$CONTAINER" \
    sh -c 'exec psql -X -q -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' "$@"
}
q() { printf '%s\n' "$1" | psql_q; }
ts() { date '+%F %T'; }

cmd="${1:?usage: backfill-edrsr-parties.sh <year> [workers] [chunk_blocks] | status | reset <year>}"

if [ "$cmd" = "status" ]; then
  q "SELECT adj_year, count(*) AS windows, count(done_at) AS done,
            sum(next_block - blk_lo) AS blocks_done, sum(blk_hi - blk_lo) AS blocks,
            sum(docs) AS docs, sum(parties) AS parties, sum(failed) AS failed,
            max(updated_at) AS last_update
       FROM edrsr_parties_progress GROUP BY adj_year ORDER BY adj_year"
  echo "-- covered:"
  q "SELECT adj_year, doc_count, party_count, built_at FROM edrsr_parties_coverage ORDER BY adj_year"
  exit 0
fi

if [ "$cmd" = "reset" ]; then
  YEAR="${2:?usage: backfill-edrsr-parties.sh reset <year>}"
  [[ "$YEAR" =~ ^[0-9]{4}$ ]] || { echo "bad year: $YEAR"; exit 2; }
  echo "[$(ts)] reset year $YEAR: coverage, checkpoints, failed log, rows (TRUNCATE of the partition)"
  q "BEGIN;
     DELETE FROM edrsr_parties_coverage WHERE adj_year = $YEAR;
     DELETE FROM edrsr_parties_progress WHERE adj_year = $YEAR;
     DELETE FROM edrsr_parties_failed   WHERE adj_year = $YEAR;
     TRUNCATE edrsr_parties_p_$YEAR;
     COMMIT;"
  exit 0
fi

YEAR="$cmd"
WORKERS="${2:-4}"
CHUNK="${3:-2000}"
[[ "$YEAR" =~ ^[0-9]{4}$ ]] || { echo "bad year: $YEAR"; exit 2; }

q "SELECT 1 FROM pg_proc WHERE proname = 'edrsr_backfill_parties_range'" | grep -q 1 \
  || { echo "FATAL: edrsr_backfill_parties_range missing — apply migration 239 first"; exit 1; }
q "SELECT to_regclass('edrsr_fulltext_p_$YEAR') IS NOT NULL" | grep -q t \
  || { echo "FATAL: no partition edrsr_fulltext_p_$YEAR"; exit 1; }

# Windows: reuse the recorded ones (resume), else split [0, blocks) into WORKERS equal parts.
# Rows that land in blocks past the end later are handled by the INSERT/UPDATE triggers.
mapfile -t WINDOWS < <(q "SELECT blk_lo || ' ' || blk_hi FROM edrsr_parties_progress WHERE adj_year = $YEAR ORDER BY blk_lo")
if [ "${#WINDOWS[@]}" -eq 0 ]; then
  BLOCKS=$(q "SELECT pg_relation_size('edrsr_fulltext_p_$YEAR') / current_setting('block_size')::int")
  [ "$BLOCKS" -gt 0 ] || { echo "partition edrsr_fulltext_p_$YEAR is empty"; exit 0; }
  STEP=$(( (BLOCKS + WORKERS - 1) / WORKERS ))
  for ((k = 0; k < WORKERS; k++)); do
    lo=$(( k * STEP )); hi=$(( (k + 1) * STEP )); [ "$hi" -gt "$BLOCKS" ] && hi=$BLOCKS
    [ "$lo" -lt "$hi" ] && WINDOWS+=("$lo $hi")
  done
  echo "[$(ts)] year=$YEAR blocks=$BLOCKS windows=${#WINDOWS[@]} chunk=$CHUNK (new)"
else
  echo "[$(ts)] year=$YEAR resuming ${#WINDOWS[@]} recorded windows chunk=$CHUNK"
fi

pids=()
for w in "${WINDOWS[@]}"; do
  read -r lo hi <<< "$w"
  log="$HOME/parties_${YEAR}_${lo}.log"
  echo "[$(ts)] window [$lo,$hi) → $log"
  ( q "CALL edrsr_backfill_parties_range($YEAR, $lo, $hi, $CHUNK)" > "$log" 2>&1 ) &
  pids+=("$!")
done

fail=0
for p in "${pids[@]}"; do wait "$p" || fail=1; done
if [ "$fail" -ne 0 ]; then
  echo "[$(ts)] a window exited non-zero (see ~/parties_${YEAR}_*.log); re-run the same command to resume"
  exit 1
fi

echo "[$(ts)] all windows done; marking $YEAR covered"
q "SELECT adj_year, doc_count, party_count FROM edrsr_parties_mark_covered($YEAR)"
q "SELECT 'role ' || role, count(*) FROM edrsr_parties WHERE adj_year = $YEAR GROUP BY role ORDER BY role"
q "SELECT 'failed rows', count(*) FROM edrsr_parties_failed WHERE adj_year = $YEAR"
echo "[$(ts)] done"
