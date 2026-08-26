#!/usr/bin/env bash
# Re-extract the whole citation graph, from the decision texts up.
#
# Versioned copy of the sequence that used to live only as ~/ch-citations-
# reextract.sh on the prod box -- which meant the one procedure nobody
# remembers the order of existed in exactly one place, on a machine, with no
# review and no history. Run it from services/ch-pipeline.
#
# What it does, in order:
#   1. aliases            -- the abbreviation -> SR number map, first,
#                            because step 1 of resolution reads it and the
#                            act corpus may have grown since the last run.
#   2. reset the queue    -- UPDATE ch_citation_state SET extracted_at = NULL
#   3. citations          -- re-scan every decision's text, replacing edges
#   4. citations-resolve  -- with CHPIPE_CIT_RESOLVE_ALL=1, so the terminal
#                            unresolved_abbr / unresolved rows are given
#                            another chance against the alias map and the
#                            decision corpus as they are TODAY.
#   5. reports_cit        -- the numbers, so the run ends with a measurement
#                            rather than an assumption.
#
# The reset is one narrow UPDATE over ch_citation_state (~40 bytes a row, one
# small partial index, no GIN) and takes seconds. It is NOT the old
# `UPDATE ch_court_decisions SET citations_extracted_at = NULL`: that column
# sat inside an index predicate on a 19 GB table with a 7.6 GB full-text GIN,
# so the same reset was a full row rewrite into every index -- measured
# 2026-08-25, 22+ minutes for 1.22M rows, and 0.6 GB of GIN growth in a day.
# Nothing in this script writes ch_court_decisions at all.
#
# Steps 3 and 4 are the long ones (hours over the full corpus). RUN IT UNDER
# tmux, and outside the 07:15 UTC delta window -- run-delta.sh's flock does
# not know about this script, so an overlapping delta would have its own
# `citations` run competing for the same queue.
#
# Usage:
#   ./scripts/reextract-citations.sh              # the whole corpus
#   ./scripts/reextract-citations.sh CH_BGer      # one spider's decisions
#
# With a spider argument the reset is scoped to that spider's decisions too,
# so a single court can be re-extracted without discarding the rest of the
# corpus's stamps.
set -euo pipefail

SPIDER="${1:-}"
# The spider name is interpolated into the reset statement's SQL literal
# below (psql -c, not a bound parameter), so it is checked against the shape
# a spider name actually has before it gets anywhere near the database. A
# name is [A-Za-z0-9_]+ -- CH_BGer, ZG_Obergericht, GE_TAPI -- and anything
# else is either a typo worth catching or a quote-breaking injection worth
# refusing.
#
# bash's own [[ =~ ]], NOT `grep -Eq`: grep validates per LINE, so
# $'CH_BGer\nDROP TABLE ch_case_citations' has a line that matches and grep
# reports success -- while the whole argument, newline and all, is what ends
# up inside the SQL literal. In [[ =~ ]] the subject is the entire string:
# `$` is its end and the character class cannot span a newline. Measured in
# tests/test_reextract_citations_sh.py, which runs this script for real.
if [ -n "$SPIDER" ] && ! [[ "$SPIDER" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "refusing spider name '$SPIDER': expected ^[A-Za-z0-9_]+$" >&2
  exit 2
fi

# `python3 -m chpipe...` needs services/ch-pipeline on the path, so run from
# there whatever directory the operator invoked this from.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
LOG_DIR=/data/ch-corpus/logs
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/reextract-citations${SPIDER:+-$SPIDER}.log"

# Same one-variable read as run-stage.sh: deployment/.env.prod has a line
# with an unquoted space that breaks `set -a; . .env.prod`.
PGPASS="$(grep -E '^POSTGRES_PASSWORD=' ~/SecondLayer/deployment/.env.prod | cut -d= -f2-)"
export CHPIPE_DSN="postgresql://secondlayer:${PGPASS}@127.0.0.1:5438/secondlayer_prod"
export CHPIPE_RAW_DIR=/data/ch-corpus/raw

say() { echo "=== $(date -Is) $* ===" | tee -a "$LOG"; }

say "starting re-extraction${SPIDER:+ for $SPIDER}"

say "1/5 aliases"
python3 -m chpipe.stages.aliases_stage >> "$LOG" 2>&1

say "2/5 resetting ch_citation_state"
if [ -n "$SPIDER" ]; then
  psql "$CHPIPE_DSN" -v ON_ERROR_STOP=1 -c "
    UPDATE ch_citation_state s SET extracted_at = NULL, attempts = 0,
           last_error = NULL, updated_at = now()
      FROM ch_court_decisions d
     WHERE d.ecli = s.ecli AND d.spider = '${SPIDER}'" >> "$LOG" 2>&1
else
  psql "$CHPIPE_DSN" -v ON_ERROR_STOP=1 -c "
    UPDATE ch_citation_state SET extracted_at = NULL, attempts = 0,
           last_error = NULL, updated_at = now()" >> "$LOG" 2>&1
fi

say "3/5 citations (hours -- this is the long one)"
CHPIPE_SPIDER="$SPIDER" python3 -m chpipe.stages.citations_stage >> "$LOG" 2>&1

# Resolution is corpus-wide by design: it works over the raw edge tables, not
# over a spider's decisions, and CHPIPE_CIT_RESOLVE_ALL=1 re-opens the
# terminal states (unresolved_abbr, unresolved) an ordinary run never revisits.
say "4/5 citations-resolve (CHPIPE_CIT_RESOLVE_ALL=1)"
CHPIPE_CIT_RESOLVE_ALL=1 python3 -m chpipe.stages.citations_resolve_stage >> "$LOG" 2>&1

say "5/5 report"
python3 -m chpipe.reports_cit | tee -a "$LOG"

say "done -- check decisions.stamped against decisions.loaded above"
