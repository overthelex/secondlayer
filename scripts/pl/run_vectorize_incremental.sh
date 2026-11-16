#!/usr/bin/env bash
# Daily incremental PL vectors (see vectorize_incremental.py). On cthulhu, from cron:
#   scripts/pl/run_vectorize_incremental.sh [export args...]
# 1. export on the host (Postgres at 127.0.0.1:5448, PG* from ~/lawrider/pl-env.sh)
# 2. load in a throwaway container on the `lawrider` network (TEI + Qdrant live there)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${PL_VEC_WORK:-$HOME/lawrider/pl-vectors/incremental}
DEPS=${PL_VEC_DEPS:-$HOME/lawrider/pl-vectors/pydeps}   # requests (pip --target)
TEI_URL=${TEI_URL:-http://tei-bge-m3-lawrider:80}
mkdir -p "$WORK"
# shellcheck disable=SC1091
. "$HOME/lawrider/pl-env.sh"

extra=()
# A one-off job that rewrites pl_act_text points (vectorize_pdf_articles.py) must not race us.
if docker ps --format '{{.Names}}' | grep -qx pl-pdf-vec; then
  echo "pl-pdf-vec is running: legislation left for a later run"
  extra+=(--no-legislation)
fi
if docker ps -a --format '{{.Names}}' | grep -qx pl-vec-incr; then
  echo "pl-vec-incr container already exists; previous run still going"; exit 0
fi

/usr/bin/python3 "$HERE/vectorize_incremental.py" export --work "$WORK" "${extra[@]}" "$@"
[ -f "$WORK/batch.ndjson" ] || exit 0

docker run --rm --name pl-vec-incr --network lawrider --user "$(id -u):$(id -g)" --cpus 1 \
  -v "$WORK:/work" -v "$HERE:/code:ro" -v "$DEPS:/deps:ro" -e PYTHONPATH=/deps \
  -e PYTHONDONTWRITEBYTECODE=1 -e TEI_URL="$TEI_URL" \
  python:3.12-slim python /code/vectorize_incremental.py load --work /work
