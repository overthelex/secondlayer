#!/usr/bin/env bash
# neo4j-export-instance-layer.sh  (LEXAI-2323)
#
# Exports the layers that exist ONLY in Neo4j (neo4j-citation-local on cthulhu) into CSVs
# for neo4j-load-instance-layer.sql, as part of moving the citation graph to Postgres:
#   superseded_by.csv  doc_id, superseded_by_doc_id, disposition, reversed_date   (SUPERSEDED_BY)
#   dissent.csv        parent_doc_id, dissent_doc_id                              (HAS_DISSENT)
#   departs.csv        doc_id, departed_cause_num, departed_on                    (DEPARTS_FROM)
#   status.csv         doc_id, status          (Decision.status: 'overruled' | 'dissent')
#
# The server caps a transaction at 30 s (NEO4J_db_transaction_timeout), and streaming
# 704K SUPERSEDED_BY rows takes longer, so the edge scans are cut into doc_id ranges
# (doc_id is a STRING property; ranges are lexicographic two-character prefixes, served
# by the decision_status / decision_doc_id range indexes). Read-only; the graph is untouched.
#
#   bash neo4j-export-instance-layer.sh [OUT_DIR]     # default ./neo4j-export
set -euo pipefail
OUT="${1:-./neo4j-export}"
mkdir -p "$OUT"
C=neo4j-citation-local
P=$(docker exec "$C" printenv NEO4J_AUTH | cut -d/ -f2-)
cy() { docker exec "$C" cypher-shell -u neo4j -p "$P" --format plain "$1" </dev/null; }

# Plain format prints a header and "a", "b" rows; turn them into CSV with no header.
tocsv() { tail -n +2 | sed -e 's/", "/","/g'; }

bounds=("")
for a in 1 2 3 4 5 6 7 8 9; do for b in 0 1 2 3 4 5 6 7 8 9; do bounds+=("$a$b"); done; done
bounds+=("~")

export_ranged() {  # export_ranged <file> <MATCH … WHERE {R} …> <RETURN …>
  local f="$1" match="$2" ret="$3"
  : > "$OUT/$f"
  for ((i = 0; i < ${#bounds[@]} - 1; i++)); do
    local lo="${bounds[$i]}" hi="${bounds[$((i + 1))]}"
    local r="x.doc_id >= \"$lo\" AND x.doc_id < \"$hi\""
    cy "${match//\{R\}/$r} RETURN $ret" | tocsv >> "$OUT/$f"
  done
  echo "$f: $(wc -l < "$OUT/$f") rows"
}

export_ranged superseded_by.csv \
  'MATCH (x:Decision)-[r:SUPERSEDED_BY]->(h:Decision) WHERE x.status = "overruled" AND {R}' \
  'x.doc_id, h.doc_id, r.disposition, r.reversed_date'
export_ranged dissent.csv \
  'MATCH (p:Decision)-[:HAS_DISSENT]->(x:Decision) WHERE x.status = "dissent" AND {R}' \
  'p.doc_id, x.doc_id'
cy 'MATCH (x:Decision)-[r:DEPARTS_FROM]->(c:Case) RETURN x.doc_id, c.cause_num, toString(r.departed_on)' | tocsv > "$OUT/departs.csv"
echo "departs.csv: $(wc -l < "$OUT/departs.csv") rows"
export_ranged status.csv \
  'MATCH (x:Decision) WHERE x.status IN ["overruled", "dissent"] AND {R}' \
  'x.doc_id, x.status'

# Totals to compare against the CSVs (any "terminated" line above means a chunk was cut).
cy 'MATCH ()-[r:SUPERSEDED_BY]->() RETURN count(r)' | tail -1 | sed 's/^/SUPERSEDED_BY total: /'
cy 'MATCH ()-[r:HAS_DISSENT]->() RETURN count(r)' | tail -1 | sed 's/^/HAS_DISSENT total: /'
