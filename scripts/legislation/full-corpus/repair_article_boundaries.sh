#!/usr/bin/env bash
# Trim structural headings off stored npa.article bodies, one act at a time (LEXAI-2123).
#
# Idempotent: rows already trimmed produce no output from the filter, and the UPDATE
# only touches rows whose body actually differs. Safe to stop and re-run; pass a start
# nreg to resume after the last act it printed.
#
#   PSQL="docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local" \
#     ./repair_article_boundaries.sh [--dry-run] [resume_from_nreg]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSQL="${PSQL:-docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local}"
DRY=""
if [[ "${1:-}" == "--dry-run" ]]; then DRY="--dry-run"; shift; fi
FROM="${1:-}"

q() { $PSQL -X -q -v ON_ERROR_STOP=1 -At "$@"; }

[[ -z "$DRY" ]] && q -c "CREATE UNLOGGED TABLE IF NOT EXISTS npa.article_boundary_fix
  (nreg text, ed_date date, art_no text, title text, body text)"

# Every psql inside the loop gets </dev/null or a pipe: `docker exec -i` would
# otherwise swallow the act list the loop is reading.
# Loose index scan over the primary key: no body is read to list the acts.
q -c "WITH RECURSIVE t AS (
        (SELECT nreg FROM npa.article WHERE nreg > '$FROM' ORDER BY nreg LIMIT 1)
        UNION ALL
        SELECT (SELECT nreg FROM npa.article WHERE nreg > t.nreg ORDER BY nreg LIMIT 1)
          FROM t WHERE t.nreg IS NOT NULL)
      SELECT nreg FROM t WHERE nreg IS NOT NULL" |
while IFS= read -r nreg; do
  lit="${nreg//\'/\'\'}"
  echo -n "$nreg: " >&2
  if [[ -n "$DRY" ]]; then
    q -c "SET statement_timeout='300s'" \
      -c "\\copy (SELECT nreg, ed_date, art_no, body FROM npa.article WHERE nreg = '$lit') to stdout with (format csv)" </dev/null |
      python3 "$HERE/repair_article_boundaries.py" --dry-run
    continue
  fi
  q -c "TRUNCATE npa.article_boundary_fix" </dev/null
  q -c "SET statement_timeout='300s'" \
    -c "\\copy (SELECT nreg, ed_date, art_no, body FROM npa.article WHERE nreg = '$lit') to stdout with (format csv)" </dev/null |
    python3 "$HERE/repair_article_boundaries.py" |
    q -c "\\copy npa.article_boundary_fix from pstdin with (format csv)"
  q -c "SET statement_timeout='300s'" \
    -c "UPDATE npa.article a SET body = f.body, title = f.title
          FROM npa.article_boundary_fix f
         WHERE a.nreg = f.nreg AND a.ed_date = f.ed_date AND a.art_no = f.art_no
           AND a.body IS DISTINCT FROM f.body" </dev/null >/dev/null
done
[[ -z "$DRY" ]] && q -c "DROP TABLE IF EXISTS npa.article_boundary_fix"
echo "done" >&2
