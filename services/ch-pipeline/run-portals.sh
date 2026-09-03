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
set -euo pipefail
cd "$(dirname "$0")"
SPIDERS="${1:-}"
if [ -z "$SPIDERS" ]; then
  SPIDERS="$(python3 -c 'from chpipe.portals import PORTAL_SPIDERS; print(" ".join(sorted(PORTAL_SPIDERS)))')"
fi
for s in $SPIDERS; do
  ./run-stage.sh portals-discover "$s"
  ./run-stage.sh fetch "$s"
  ./run-stage.sh extract "$s"
  ./run-stage.sh ocr "$s"
  ./run-stage.sh load "$s"
  ./run-stage.sh citations "$s"
done
