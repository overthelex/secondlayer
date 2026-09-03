#!/usr/bin/env bash
# The portal spiders end to end (chpipe/portals, LEXAI-2039): discovery, then
# the ordinary decision stages for each portal spider, then the citation
# extraction those rows are enqueued for. Weekly from cron (the regulators
# publish a few decisions a month); supervised in tmux for the first pass.
#
#   ./run-portals.sh              # every portal
#   ./run-portals.sh CH_ELCOM     # one
#
# Each stage is run-stage.sh's, so its log is /data/ch-corpus/logs/<stage>-<spider>.log.
#
# One copy at a time (flock, the run-delta.sh discipline): the queue's
# row lock is released after each autocommitted claim, so two overlapping
# copies would download the same rows twice. A portal whose discovery
# failed (its stage exits non-zero) is skipped for the rest of this run and
# the script's own exit status reports it, so cron sees the outage.
set -uo pipefail
cd "$(dirname "$0")"
LOG_DIR=/data/ch-corpus/logs
mkdir -p "$LOG_DIR"
exec 9>"$LOG_DIR/portals.lock"
if ! flock -n 9; then
  echo "=== $(date -Is) run-portals already running; skipping ===" >> "$LOG_DIR/portals.log"
  exit 0
fi
SPIDERS="${1:-}"
if [ -z "$SPIDERS" ]; then
  SPIDERS="$(python3 -c 'from chpipe.portals import PORTAL_SPIDERS; print(" ".join(sorted(PORTAL_SPIDERS)))')"
fi
failed=0
for s in $SPIDERS; do
  if ! ./run-stage.sh portals-discover "$s"; then
    echo "=== $(date -Is) $s: discovery failed; stages skipped ===" >> "$LOG_DIR/portals.log"
    failed=1
    continue
  fi
  for stage in fetch extract ocr load citations; do
    ./run-stage.sh "$stage" "$s" || { echo "=== $(date -Is) $s: $stage failed ===" >> "$LOG_DIR/portals.log"; failed=1; break; }
  done
done
exit $failed
