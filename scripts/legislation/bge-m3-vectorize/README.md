# Legislation vectorization on bge-m3 (LEXAI-1807)

Migrate the legislation vector index (`legal_sections`) from **VoyageAI `voyage-multilingual-2`**
to **bge-m3 (BAAI/bge-m3, 1024-dim)** — the same model/TEI service as EDRSR — for a single
embedding stack across the platform.

## Why

- Court decisions (EDRSR) already use bge-m3 via TEI (`BGE_M3_URL=http://tei-bge-m3:80`).
- Legislation (`legal_sections`, 73 acts) is on VoyageAI; the query path
  (`search_legislation` / `get_legislation_section`) embeds queries with VoyageAI too.
- Only **73 / 645** acts are vectorized; **283** more have content and need it (incl. КПК, Митний,
  ЦПК, КК, Конституція). Migrating unifies the model AND fills coverage in one pass.

> bge-m3 and Voyage are both 1024-dim but **different vector spaces** — you cannot mix them in one
> collection. This migration is all-or-nothing per collection + requires the query path to switch too.

## Steps (safe cutover)

1. **Vectorize into a NEW collection** `legal_sections_bge` (keeps live Voyage `legal_sections` serving):
   ```bash
   # pilot: Constitution only
   python vectorize_legislation.py --pilot --recreate-collection
   # verify, then everything with content
   python vectorize_legislation.py --all --skip-existing
   ```
   Deterministic point ids → re-runnable/idempotent. Also mirrors into Postgres `legislation_chunks`
   (`ON CONFLICT (article_id, chunk_index)`).

2. **Backend change (separate PR)** — switch the legislation embedding to bge-m3 so query vectors
   match the new points. In `mcp_backend`:
   - `src/services/embedding-service.ts` — make the legislation `EmbeddingService` embed via
     `BgeM3Client` (`src/utils/bge-m3-client.ts`) instead of VoyageAI, OR add an
     `EMBEDDING_PROVIDER=bge` branch and set it for the legislation service.
   - Point the legislation collection at the new one: set Qdrant collection to `legal_sections_bge`
     (the `EmbeddingService` COLLECTION constant / env), or after cutover rename it to `legal_sections`.
   - `src/services/legislation-service.ts::indexArticlesForVectorSearch` (the in-app indexer) must use
     the same bge-m3 client so future edits (e.g. LEXAI-1805 repaired articles) re-embed consistently.
   - Keep `document_type='legislation'`, `rada_id`, `article_number`, `article_id` in the payload
     (the hybrid matcher in `findRelevantArticles` requires them).

3. **Cutover**: deploy the PR (query → bge-m3 + collection swap). Verify via MCP
   `search_legislation` / `get_legislation_section` (query mode). Then drop the old Voyage vectors and
   remove `VOYAGEAI_EMBEDDING_MODEL` from legislation config.

4. **Re-embed repaired articles** (LEXAI-1805): rerun for `2755-17` and `2145-19` (deterministic ids
   overwrite the stale chunks).

## Prereqs / gotchas

- Run **inside the prod docker network** — `tei-bge-m3` and `secondlayer-qdrant-prod` are internal.
- Env: `DATABASE_URL`, `BGE_M3_URL`, `QDRANT_URL`, `QDRANT_API_KEY`. Deps: `psycopg2-binary qdrant-client requests`.
- **No acts are skipped by default.** `--exclude` still exists but is empty. It used to hold
  `254к/96-ВР`, `4651-vi`, `5073-VI`, `4173-IX` — official NUMBERS that had been stored in
  `legislation.rada_id`, giving the Constitution, the КПК and two more acts a second row each.
  Migration 188 merged those duplicates away and a unique index on `lower(rada_id)` plus a CHECK
  now prevent the shape, so the list matched nothing and was removed.
- **289 NO_CONTENT acts** are not handled here — they need article import first (separate task).
- Chunking is a byte-exact port of `createArticleChunks` (500/100). Genuinely-long articles (e.g.
  ПКУ ст.14 ~215K) chunk into many pieces — that's expected, not the LEXAI-1805 blob bug.

## Files

- `vectorize_legislation.py` — the migration/vectorization job (pilot / one-act / --all, dry-run, resume).
