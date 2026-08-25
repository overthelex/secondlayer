#!/usr/bin/env bash
# One stage, under supervision, with a log. Usage:
#
#   decisions:    ./run-stage.sh index|fetch|extract|ocr|load|citations [spider]
#   citations:    ./run-stage.sh aliases|citations-resolve   (no argument)
#   legislation:  ./run-stage.sh acts|versions|fetch-xml|parse-akn|diff|project-legacy|provenance|as-bbl|basic-act [lang]
#
# The optional second argument means different things to the two halves, so
# it is dispatched explicitly rather than exported as both: for the decisions
# stages -- `citations` included, same CHPIPE_SPIDER family -- it is a spider
# name, for `diff` it is a language (CHPIPE_LANG, default de). `aliases` and
# `citations-resolve` take no second argument at all, same as the legislation
# stages below.
set -euo pipefail

STAGE="${1:?stage required}"
# A positional argument wins; with none given, the family's OWN env var
# survives instead of being clobbered to "". The first prod run of `index`
# was launched as
#   CHPIPE_SPIDER=CH_VB ./run-stage.sh index
# and walked all 54 spiders, because the case below exported the empty
# positional over the env and index_stage read "" as "every spider".
# Resolved per family, deliberately: a leftover CHPIPE_LANG=fr must not
# become CHPIPE_SPIDER=fr on the next `index` (one nonsense spider is worse
# than all of them), and vice versa.
POS="${2:-}"
ARG="$POS"
LOG_DIR=/data/ch-corpus/logs
mkdir -p "$LOG_DIR"

# ~/SecondLayer/deployment/.env.prod has a line with an unquoted space that
# breaks `set -a; . .env.prod`, so read only the one variable we need
# instead of sourcing the whole file.
PGPASS="$(grep -E '^POSTGRES_PASSWORD=' ~/SecondLayer/deployment/.env.prod | cut -d= -f2-)"
export CHPIPE_DSN="postgresql://secondlayer:${PGPASS}@127.0.0.1:5438/secondlayer_prod"
export CHPIPE_RAW_DIR=/data/ch-corpus/raw

# `fetch-xml` on the command line, fetch_xml_stage as a module.
MODULE="chpipe.stages.${STAGE//-/_}_stage"

case "$STAGE" in
  index|fetch|extract|ocr|load|citations)
    ARG="${POS:-${CHPIPE_SPIDER:-}}"
    export CHPIPE_SPIDER="$ARG"
    ;;
  diff|provenance)
    ARG="${POS:-${CHPIPE_LANG:-}}"
    export CHPIPE_LANG="$ARG"
    ;;
  acts|versions|fetch-xml|parse-akn|project-legacy|as-bbl|basic-act|aliases|citations-resolve)
    if [ -n "$POS" ]; then
      echo "$STAGE takes no second argument (got '$ARG')" >&2
      exit 2
    fi
    ;;
  *)
    echo "unknown stage '$STAGE' -- see the usage comment at the top" >&2
    exit 2
    ;;
esac

LOG="$LOG_DIR/${STAGE}${ARG:+-$ARG}.log"
echo "=== $(date -Is) starting $STAGE ${ARG} ===" >> "$LOG"
exec python3 -m "$MODULE" >> "$LOG" 2>&1
