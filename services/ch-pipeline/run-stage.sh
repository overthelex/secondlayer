#!/usr/bin/env bash
# One stage, under supervision, with a log. Usage:
#
#   decisions:    ./run-stage.sh index|fetch|extract|ocr|load [spider]
#   legislation:  ./run-stage.sh acts|versions|fetch-xml|parse-akn|diff|project-legacy|provenance|as-bbl|basic-act [lang]
#
# The optional second argument means different things to the two halves, so
# it is dispatched explicitly rather than exported as both: for the decisions
# stages it is a spider name (CHPIPE_SPIDER), for `diff` it is a language
# (CHPIPE_LANG, default de). The legislation stages take no spider at all.
set -euo pipefail

STAGE="${1:?stage required}"
# A positional argument wins; with none given, an already-exported
# CHPIPE_SPIDER / CHPIPE_LANG survives instead of being clobbered to "".
# The first prod run of `index` was launched as
#   CHPIPE_SPIDER=CH_VB ./run-stage.sh index
# and walked all 54 spiders, because the case below exported the empty
# positional over the env and index_stage read "" as "every spider".
ARG="${2:-${CHPIPE_SPIDER:-${CHPIPE_LANG:-}}}"
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
  index|fetch|extract|ocr|load)
    export CHPIPE_SPIDER="$ARG"
    ;;
  diff|provenance)
    export CHPIPE_LANG="$ARG"
    ;;
  acts|versions|fetch-xml|parse-akn|project-legacy|as-bbl|basic-act)
    if [ -n "$ARG" ]; then
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
