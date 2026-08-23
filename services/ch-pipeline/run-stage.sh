#!/usr/bin/env bash
# One stage, under supervision, with a log. Usage:
#   ./run-stage.sh index|fetch|extract|ocr|load [spider]
set -euo pipefail

STAGE="${1:?stage required}"
SPIDER="${2:-}"
LOG_DIR=/data/ch-corpus/logs
mkdir -p "$LOG_DIR"

# ~/SecondLayer/deployment/.env.prod has a line with an unquoted space that
# breaks `set -a; . .env.prod`, so read only the one variable we need
# instead of sourcing the whole file.
PGPASS="$(grep -E '^POSTGRES_PASSWORD=' ~/SecondLayer/deployment/.env.prod | cut -d= -f2-)"
export CHPIPE_DSN="postgresql://secondlayer:${PGPASS}@127.0.0.1:5438/secondlayer_prod"
export CHPIPE_RAW_DIR=/data/ch-corpus/raw
export CHPIPE_SPIDER="$SPIDER"

LOG="$LOG_DIR/${STAGE}${SPIDER:+-$SPIDER}.log"
echo "=== $(date -Is) starting $STAGE ${SPIDER} ===" >> "$LOG"
exec python3 -m "chpipe.stages.${STAGE}_stage" >> "$LOG" 2>&1
