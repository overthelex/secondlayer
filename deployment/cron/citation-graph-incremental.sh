#!/bin/bash
# Nightly incremental update of the EDRSR citation graph in Postgres (LEXAI-2323)
# on cthulhu (legal_prod), user vovkes.
#
# Runs scripts/citation-graph/incremental-update.py: every edrsr_fulltext decision above the
# watermark (citation_graph_watermark) is added to edrsr_case_index, case_citation_edges/links,
# case_citation_counts, decision_statute_citations and statute_article_stats, in one transaction
# with the watermark — a failed run commits nothing and the next run repeats it. Scheduled after
# the daily EDRSR fulltext harvest (CI cron 02:30 UTC). Decisions per run are capped (MAX_DOCS);
# the rest waits for the next night.
#
# DB password is read from the running postgres container; nothing secret lives in this file or
# in the crontab. flock keeps runs from overlapping. Refuses to start below MIN_FREE_GB free on /.
#
# Install (merge into the existing crontab):
#   crontab -l | cat - ~/SecondLayer/deployment/cron/citation-graph-crontab | crontab -
#
# Usage: citation-graph-incremental.sh [--dry-run]
# Env: REPO (/home/vovkes/SecondLayer), PG_CONTAINER (secondlayer-postgres-local),
#      MAX_DOCS (500000), MIN_FREE_GB (20), LOCK (/tmp/citgraph-inc.lock)
set -euo pipefail
REPO="${REPO:-/home/vovkes/SecondLayer}"
PG_CONTAINER="${PG_CONTAINER:-secondlayer-postgres-local}"
MAX_DOCS="${MAX_DOCS:-500000}"
MIN_FREE_GB="${MIN_FREE_GB:-20}"
LOCK="${LOCK:-/tmp/citgraph-inc.lock}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "$(ts) citation-graph incremental: start, free on / = ${free_gb} GB"
if [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
  echo "$(ts) CITGRAPH-INCREMENTAL FAILED: only ${free_gb} GB free (< ${MIN_FREE_GB})"
  exit 1
fi

PW=$(docker exec "$PG_CONTAINER" printenv POSTGRES_PASSWORD)
PORT=$(docker port "$PG_CONTAINER" 5432/tcp | head -1 | sed 's/.*://')
export DATABASE_URL="host=127.0.0.1 port=${PORT:-5432} dbname=secondlayer_local user=secondlayer password=$PW"

cd "$REPO/scripts/citation-graph"
exec flock -n "$LOCK" nice -n 10 ionice -c2 -n7 python3 incremental-update.py --max-docs "$MAX_DOCS" "$@"
