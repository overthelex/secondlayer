#!/usr/bin/env bash
# Weekly re-walk of the phase-2 cantonal sources (GE/NE SIL, TI RLeggi, ZH ZH-Lex).
# Sunday 09:00 Kyiv (06:00 UTC in summer), after cantonal-acts and lexfind-registry.
# sil/ti re-fetch every current page (~2.3K pages, ~25 min); zh-acts re-walks the
# index (~60 min) and only new/changed editions go through fetch/parse/pdf.
#
# Moved from the GCP box (was ~/ch-cantonal-phase2-weekly.sh there, never in git).
# Paths come from the environment set in crontab.fragment; the checkout is the
# one deploy-lawrider-cthulhu.yml keeps in sync, never ~/SecondLayer.
set -uo pipefail
: "${CHPIPE_REPO:?CHPIPE_REPO is not set}"
cd "$CHPIPE_REPO/services/ch-pipeline"
exec 9>/data/ch-corpus/logs/cantonal-phase2-weekly.lock; flock -n 9 || exit 0
run() { echo "== $(date -u +%FT%TZ) start $*"; "$@"; echo "== $(date -u +%FT%TZ) exit $? $*"; }
run ./run-stage.sh sil-acts
run ./run-stage.sh sil-fetch GE
run ./run-stage.sh sil-fetch NE
run ./run-stage.sh sil-parse
run ./run-stage.sh ti-acts
run ./run-stage.sh ti-fetch
run ./run-stage.sh ti-parse
run ./run-stage.sh zh-acts
run ./run-stage.sh zh-fetch
run ./run-stage.sh zh-parse
run env CHPIPE_SOURCE=zhlex ./run-stage.sh pdf-text
run env CHPIPE_SOURCE=lexwork_pdf ./run-stage.sh pdf-text
run ./run-stage.sh lexfind-versions
run env CHPIPE_SOURCE=lexfind ./run-stage.sh pdf-text
run ./run-stage.sh reports-cantonal
run ./run-stage.sh project-legacy
echo "== $(date -u +%FT%TZ) PHASE2 WEEKLY DONE"
