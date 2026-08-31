#!/bin/bash
# Extract legislation citations from every Arabic judgment.
#
# The corpus is ~3.9 GB of text, so it is streamed straight out of Postgres into
# the extractor rather than staged on disk: COPY TO STDOUT on one end, JSONL on
# the other, nothing in between.
set -euo pipefail

OUT="${1:-citations.jsonl}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PGPW=$(grep -E "^POSTGRES_PASSWORD=" ~/SecondLayer/deployment/.env.prod | head -1 | cut -d= -f2- | tr -d "\"'")

docker exec -i -e PGPASSWORD="$PGPW" secondlayer-postgres-prod \
  psql -U secondlayer -d secondlayer_prod -v ON_ERROR_STOP=1 -c \
  "\copy (SELECT json_build_object('doc_id', doc_id, 'full_text', full_text) \
          FROM ae_court_decisions \
          WHERE language = 'ar' AND full_text IS NOT NULL) \
   TO STDOUT WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')" \
  | python3 "$HERE/extract_citations.py" > "$OUT"

echo "citations: $(wc -l < "$OUT")"
echo "documents citing: $(cut -d'"' -f4 "$OUT" | sort -u | wc -l)"
