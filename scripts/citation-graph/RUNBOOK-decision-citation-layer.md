# Decision↔decision citation layer (LEXAI-1777)

> The Neo4j sections further down (Pipeline, steps 2–5) are history: since LEXAI-2323 the
> graph is served from Postgres only.

Resolves `case_citation_edges.to_case_number` → `edrsr_documents.cause_num` and builds the
precedent (decision↔decision) layer on top of the existing legislation citation graph.

## Background (Step-1 probe, 2026-06-26)

- `case_citation_edges` (prod) = 73.46M raw `from_doc_id → to_case_number` edges (from #1773).
- Resolution = **exact join** on `cause_num`. ~64% of distinct case numbers resolve; that is the
  ceiling — year-normalization is net-negative, and the ~36% unresolved are cited cases genuinely
  absent from the EDRSR corpus (pre-2013 / unpublished / other registry).
- Cardinality: 38.35M distinct cases / 101M decisions → avg **2.635 decisions/case**.
- **Model = Case node** (not decision→decision fan-out, which would be ~150-250M noisy edges):
  `(:Decision)-[:CITES_CASE]->(:Case)`, decision↔decision via 2-hop. `get_case_documents_chain`
  and `check_precedent_status` are served from Postgres (`edrsr_case_index` / `case_citation_links`);
  Neo4j adds graph traversal.

## Full rebuild with the fixed extractor (LEXAI-2314, 2026-11-20)

The first build stored every cited number WITHOUT its procedural suffix (the regex had no
suffix group), read only the first 10,000 characters, and took four-part proceeding numbers
(«Провадження № 3/766/262/16») as case numbers. `case_numbers.py` is the fixed pattern
(unit tests: `python3 test_case_number_extraction.py`); both `extract-citations.py` and the
rebuild runner below use it. Semantics after the rebuild:

- `case_citation_edges.to_case_number` — the cited number normalized: `base` or `base-suffix`
  (ASCII hyphen, lowercased Cyrillic suffix; Latin look-alikes and dash variants folded).
- `case_citation_links.to_case_number` — when `resolved`, the cited case's `cause_num` exactly as
  `edrsr_case_index` spells it (so `= cause_num` joins work); otherwise the normalized number.
  `match_method` = exact | normalized | suffix_completed (bare citation, one suffixed case on that
  base) | suffix_dropped (suffix cited, EDRSR keeps the case bare). A bare citation of a base that
  several cases share stays unresolved (`unresolved_reason = ambiguous_suffix`), never merged.
- `is_self_citation` is suffix-aware; `citation_context` is the reference as written (findable
  with `strpos` in `edrsr_fulltext.full_text`).

Run on cthulhu (prod), in tmux, from a directory holding the four files
(`case_numbers.py rebuild-case-edges.py rebuild-case-graph-0{1,2}-*.sql`) and with
`DATABASE_URL` set from `deployment/.env.local`:

```bash
# 1. extract into UNLOGGED cce_rebuild_bulk; progress per heap-block chunk in cce_rebuild_progress.
#    Restart = rerun the same command (done chunks are skipped, nothing is duplicated).
nice -n 10 ionice -c2 -n7 python3 rebuild-case-edges.py --partitions 2023-2026 --workers 5        # NVMe
nice -n 10 ionice -c2 -n7 python3 rebuild-case-edges.py --partitions 2005-2022,pre2005,future --workers 4  # HDD
python3 rebuild-case-edges.py --status
# 2. build edrsr_case_index_new / case_citation_edges_new / case_citation_links_new (live tables untouched)
docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local -f - < rebuild-case-graph-01-finalize.sql
# 3. swap in one transaction (lock_timeout 3s; rerun on timeout); live -> *_old
docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local -f - < rebuild-case-graph-02-swap.sql
```

`*_old` tables are kept for rollback (reverse renames) until dropped by hand. The staging tables
`cce_rebuild_bulk` / `cce_rebuild_progress` can be dropped after the swap. Merge the reader
change (mcp_backend `case-citation-graph.ts`) only after the swap: it expects the new semantics.
The Neo4j case layer below was NOT reloaded by this rebuild (additive MERGE would keep the old
bare-number edges); see the follow-up task.

## The whole graph in Postgres (LEXAI-2323, 2026-11-20)

`CitationGraphService` reads Postgres only; the app no longer connects to Neo4j. Tables
(migration `297_citation_graph_postgres.sql`) and how each is filled:

| table | from | script |
|---|---|---|
| `decision_statute_citations` | full-text re-extraction (statute patterns of `extract-citations.py`, no 10K window) | `rebuild-case-edges.py --layer statute`, then `rebuild-statute-02-finalize.sql` |
| `statute_article_stats` | aggregate of the above (articles only) | `rebuild-statute-02-finalize.sql` |
| `decision_supersession`, `decision_dissent`, `decision_instance_status`, `case_position_departures` | Neo4j SUPERSEDED_BY / HAS_DISSENT / Decision.status / DEPARTS_FROM, exported once | `neo4j-export-instance-layer.sh`, `neo4j-load-instance-layer.sh` |
| `case_citation_counts` | `case_citation_links` (resolved, non-self) | `build-case-citation-counts.sql` |

```bash
nice -n 10 ionice -c2 -n7 python3 rebuild-case-edges.py --layer statute --partitions 2023-2026 --workers 6
nice -n 10 ionice -c2 -n7 python3 rebuild-case-edges.py --layer statute --partitions 2006-2022,future --workers 5
python3 rebuild-case-edges.py --layer statute --status
docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local < rebuild-statute-02-finalize.sql
docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local < build-case-citation-counts.sql
```

The instance-status layer is a one-off copy: the pipeline that produced it
(`instance-status-0*`) wrote to Neo4j. Rerunning it means pointing its last step at these tables.

### Keeping it current: `incremental-update.py`

Adds every `edrsr_fulltext` decision above the watermark (`citation_graph_watermark`, first run
starts from `max(case_citation_edges.from_case_id)`) to the case index, case edges/links/counts
and the statute layer, in one transaction with the watermark. Nightly cron on cthulhu, after the
harvest, from a directory holding `case_numbers.py extract-citations.py incremental-update.{py,sql}`:

```cron
30 4 * * *  cd ~/citgraph-pg && . ./env.sh && flock -n /tmp/citgraph-inc.lock python3 incremental-update.py >> incremental.log 2>&1
```

Test without writing: `python3 incremental-update.py --dry-run --since <doc_id> --max-docs 3000 --replay`
re-derives already-built decisions and diffs the links against the full rebuild's. Not handled
incrementally (the periodic full rebuild settles them): an older unresolved link whose case
appears later, and member_count/latest_doc_id on older links.

## Pipeline

### 1. Build the Postgres resolution layer (on PROD)
```bash
docker exec -i secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod \
  -v ON_ERROR_STOP=1 -f - < build-case-citation-links.sql
```
Creates (additive; rollback = `DROP TABLE`):
- `edrsr_case_index` — Case dimension (cause_num PK, member_count, latest_doc_id, first/last_date).
- `case_citation_links` — resolved `CITES_CASE` edges + unresolved tail (match_method, reason,
  `is_self_citation`). Indexes on from_doc_id / to_case_number / resolved.

Serves directly, no graph:
- `get_case_documents_chain(case)` = `SELECT doc_id FROM edrsr_documents WHERE cause_num = $case`.
- `check_precedent_status(case)` = `SELECT … FROM case_citation_links WHERE to_case_number = $case
   AND resolved` (inbound citations).

### 2. Export the Case layer (on PROD)
```bash
bash export-case-layer.sh        # -> /tmp/case-layer/{cases,cites_case}.csv.gz
```

### 3. Transfer prod → qdrant.lex import dir
prod→qdrant direct ssh is key-blocked; relay through the orchestrator (macbook):
```bash
for f in cases cites_case; do
  ssh prod "cat /tmp/case-layer/$f.csv.gz" | \
    ssh qdrant.lex "cat > /home/ubuntu/neo4j/import/$f.csv.gz && gunzip -f /home/ubuntu/neo4j/import/$f.csv.gz"
done
```

### 4. Online additive load into Neo4j (on qdrant.lex, NO wipe)
```bash
ssh qdrant.lex 'docker exec -i neo4j cypher-shell -u neo4j -p <pw> --file /import/load-case-layer.cypher'
```
Adds `(:Case)` (38.3M) + `(:Decision)-[:CITES_CASE]->(:Case)` (resolved, non-self) to the live graph.
Existing article graph (391.9M `CITES_ARTICLE`) is untouched. Idempotent (MERGE) — safe to re-run.

### 5. Verify
Top-cited precedent cases (inbound `CITES_CASE`) printed by the cypher; cross-check a known case.

## Next (separate ticket)
Wire `CitationGraphService` (`CITATION_BACKEND=neo4j`) inbound/precedent methods + the
`check_precedent_status` / `get_case_documents_chain` tool handlers to this layer.
