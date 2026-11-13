#!/bin/bash
# Supervises the ProZorro contracts backfill (LEXAI-2227) on cthulhu.
#
# The backfill runs inside openreyestr-app-local, and every openreyestr deploy
# recreates that container, which kills it. This loop re-runs each stage until
# its log says "Stopped: done", waiting for the new container in between; the
# backfill resumes from its cursor in prozorro_sync_state. Stages run in order:
# construction (CPV 45) since 2021 first, then the whole history.
#
#   tmux new-session -d -s pzbf ~/SecondLayer/scripts/opendata/prozorro/backfill-contracts-loop.sh
set -uo pipefail
CONTAINER=${CONTAINER:-openreyestr-app-local}
CONCURRENCY=${PROZORRO_CONCURRENCY:-30}
LOG=${LOG:-$HOME/logs/prozorro-contracts-backfill.log}
mkdir -p "$(dirname "$LOG")"
STAGES=("--cpv=45 --since=2021-01-01" "")

say() { echo "[$(date -u +%FT%TZ)] supervisor: $*" | tee -a "$LOG"; }

for stage in "${STAGES[@]}"; do
  for attempt in $(seq 1 200); do
    until [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)" = healthy ]; do sleep 30; done
    say "stage [${stage:-all}] attempt $attempt"
    out=$(mktemp)
    # shellcheck disable=SC2086
    docker exec -e PROZORRO_CONCURRENCY="$CONCURRENCY" "$CONTAINER" \
      node dist/scripts/backfill-prozorro-contracts.js $stage 2>&1 \
      | grep --line-buffered -v dotenv | tee -a "$LOG" > "$out"
    if grep -q "Stopped: done" "$out"; then rm -f "$out"; say "stage [${stage:-all}] done"; continue 2; fi
    if grep -q "Another contracts backfill holds the lock" "$out"; then rm -f "$out"; sleep 300; continue; fi
    rm -f "$out"
    say "stage [${stage:-all}] interrupted, retrying in 60s"
    sleep 60
  done
  say "stage [${stage:-all}] gave up after 200 attempts"; exit 1
done
say "all stages done"
