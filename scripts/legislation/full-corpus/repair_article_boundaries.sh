#!/usr/bin/env bash
# Trim structural headings off stored npa.article bodies, one act at a time (LEXAI-2123).
#
# Idempotent: rows already trimmed produce no output from the filter, and the UPDATE
# only touches rows whose body actually differs. Safe to stop and re-run.
#
# Progress: one line per act, printed only AFTER that act's UPDATE has committed
# («<nreg>: done rows=… changed=…»). To resume, pass the last nreg printed as done;
# the run continues with the acts strictly after it. Re-running the last act is
# harmless anyway, because the repair is idempotent.
#
#   PSQL="docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local" \
#     ./repair_article_boundaries.sh [--dry-run] [resume_after_nreg]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSQL="${PSQL:-docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local}"
DRY=""
if [[ "${1:-}" == "--dry-run" ]]; then DRY="--dry-run"; shift; fi
FROM="${1:-}"

# An nreg is letters (Cyrillic too), digits and / - _ . : 2755-17, 254к/96-вр,
# z0567-01. Quotes, backslashes, semicolons, whitespace and control characters are
# refused. This is a deny-list on purpose: [:alnum:] depends on the locale and would
# reject Cyrillic under LANG=C. The resume value also goes in as a psql variable.
DENY="['\"\\\\;[:space:][:cntrl:]]"
valid_nreg() { [[ ! "$1" =~ $DENY ]]; }
if ! valid_nreg "$FROM"; then
  echo "invalid resume nreg: $FROM" >&2
  exit 2
fi

q() { $PSQL -X -q -v ON_ERROR_STOP=1 -At "$@"; }

if [[ -z "$DRY" ]]; then
  q -c "CREATE UNLOGGED TABLE IF NOT EXISTS npa.article_boundary_fix
    (nreg text, ed_date date, art_no text, title text, body text)" </dev/null
fi

STATS="$(mktemp)"
trap 'rm -f "$STATS"' EXIT

# Loose index scan over the primary key: no body is read to list the acts. The SQL
# goes in on stdin so :'from' is interpolated by psql (-c does not interpolate).
# Every psql inside the loop gets </dev/null or a pipe: `docker exec -i` would
# otherwise swallow the act list the loop is reading.
q -v from="$FROM" <<'SQL' |
WITH RECURSIVE t AS (
  (SELECT nreg FROM npa.article WHERE nreg > :'from' ORDER BY nreg LIMIT 1)
  UNION ALL
  SELECT (SELECT nreg FROM npa.article WHERE nreg > t.nreg ORDER BY nreg LIMIT 1)
    FROM t WHERE t.nreg IS NOT NULL)
SELECT nreg FROM t WHERE nreg IS NOT NULL;
SQL
while IFS= read -r nreg; do
  if ! valid_nreg "$nreg"; then
    echo "$nreg: SKIPPED, unexpected characters in nreg" >&2
    continue
  fi
  # \copy takes its query verbatim (no :'var'), so the nreg is quoted here; after
  # valid_nreg it cannot contain a quote, the doubling is belt and braces.
  lit="${nreg//\'/\'\'}"
  dump="\\copy (SELECT nreg, ed_date, art_no, body FROM npa.article WHERE nreg = '$lit') to stdout with (format csv)"
  if [[ -n "$DRY" ]]; then
    q -c "SET statement_timeout='300s'" -c "$dump" </dev/null |
      python3 "$HERE/repair_article_boundaries.py" --dry-run 2>"$STATS"
    echo "$nreg: dry-run $(sed 's/^\[repair\] //' "$STATS")" >&2
    continue
  fi
  q -c "TRUNCATE npa.article_boundary_fix" </dev/null
  q -c "SET statement_timeout='300s'" -c "$dump" </dev/null |
    python3 "$HERE/repair_article_boundaries.py" 2>"$STATS" |
    q -c "\\copy npa.article_boundary_fix from pstdin with (format csv)"
  q -c "SET statement_timeout='300s'" \
    -c "UPDATE npa.article a SET body = f.body, title = f.title
          FROM npa.article_boundary_fix f
         WHERE a.nreg = f.nreg AND a.ed_date = f.ed_date AND a.art_no = f.art_no
           AND a.body IS DISTINCT FROM f.body" </dev/null >/dev/null
  # Only now is this act committed; this line is the resume checkpoint.
  echo "$nreg: done $(sed 's/^\[repair\] //' "$STATS")" >&2
done
if [[ -z "$DRY" ]]; then
  q -c "DROP TABLE IF EXISTS npa.article_boundary_fix" </dev/null
fi
echo "all done" >&2
