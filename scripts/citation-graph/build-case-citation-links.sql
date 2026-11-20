-- SUPERSEDED (LEXAI-2314, 2026-11-20): use rebuild-case-edges.py + rebuild-case-graph-01-finalize.sql
-- + rebuild-case-graph-02-swap.sql (suffix-aware resolver, build into *_new, atomic swap).
-- This script DROPs the live tables and resolves by exact join only; kept for history.
--
-- build-case-citation-links.sql  (LEXAI-1777, decision<->decision layer)
--
-- Resolves case_citation_edges.to_case_number  ->  edrsr_documents.cause_num (EXACT join).
-- Step-1 probe (2026-06-26) established: ~64% exact-match IS the ceiling (year-normalization
-- is net-negative; the ~36% unresolved = cited case genuinely absent from the EDRSR corpus).
-- So the resolver is a plain exact join -- no heuristics.
--
-- Builds two additive tables (no existing data touched; rollback = DROP TABLE):
--   1. edrsr_case_index  -- the Case dimension: one row per distinct cause_num.
--                           Doubles as the Neo4j (:Case) node source.
--   2. case_citation_links -- resolved (:Decision)-[:CITES_CASE]->(:Case) edges + unresolved tail.
--
-- Run on PROD (both source tables live there; cce exists only on prod). Mirrors how
-- legislation_citation_links (331M) was built directly on prod with tuned work_mem.
--   docker exec -i secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -f -

\timing on
SET statement_timeout = 0;          -- reproducible from source; no per-statement cap
SET work_mem = '16GB';              -- one backend on the 61GB box; legislation resolver needed
                                    -- this to avoid a 219GB temp spill on the context-carrying sort.

-- 1. Case dimension -----------------------------------------------------------
--    One row per litigation (cause_num). member_count drives fan-out decisions;
--    latest_doc_id is the representative decision; first/last_date bound the case
--    timeline (used later for temporal precedent filtering).
DROP TABLE IF EXISTS edrsr_case_index;
CREATE TABLE edrsr_case_index AS
SELECT cause_num,
       count(*)::int                                                    AS member_count,
       min(adjudication_date)                                           AS first_date,
       max(adjudication_date)                                           AS last_date,
       (array_agg(doc_id ORDER BY adjudication_date DESC NULLS LAST))[1] AS latest_doc_id
FROM edrsr_documents
WHERE cause_num IS NOT NULL AND cause_num <> ''
GROUP BY cause_num;
ALTER TABLE edrsr_case_index ADD PRIMARY KEY (cause_num);

-- 2. Resolution / edge table --------------------------------------------------
DROP TABLE IF EXISTS case_citation_links;
CREATE TABLE case_citation_links (
  id                bigserial PRIMARY KEY,
  from_doc_id       bigint  NOT NULL,        -- citing decision (doc_id)
  to_case_number    text    NOT NULL,        -- cited case number (raw)
  resolved          boolean NOT NULL,        -- to_case_number found in edrsr_case_index
  member_count      int     NOT NULL DEFAULT 0,  -- # decisions in the cited case
  latest_doc_id     bigint,                  -- representative cited decision (latest)
  is_self_citation  boolean NOT NULL DEFAULT false, -- citing decision belongs to the cited case
  match_method      text,                    -- 'exact' | NULL
  unresolved_reason text,                    -- 'case_not_in_corpus' | 'malformed' | NULL
  citation_context  text,
  adj_year          smallint,
  src_edge_id       bigint,
  created_at        timestamptz DEFAULT now()
);

INSERT INTO case_citation_links
  (from_doc_id, to_case_number, resolved, member_count, latest_doc_id,
   is_self_citation, match_method, unresolved_reason, citation_context, adj_year, src_edge_id)
SELECT cce.from_case_id,
       cce.to_case_number,
       (ci.cause_num IS NOT NULL),
       COALESCE(ci.member_count, 0),
       ci.latest_doc_id,
       COALESCE(fd.cause_num = cce.to_case_number, false),
       CASE WHEN ci.cause_num IS NOT NULL THEN 'exact' END,
       CASE WHEN ci.cause_num IS NULL THEN
            CASE WHEN cce.to_case_number ~ '^[0-9]{1,4}/[0-9]{1,10}/[0-9]{2,4}$'
                 THEN 'case_not_in_corpus' ELSE 'malformed' END
       END,
       cce.citation_context,
       cce.adj_year,
       cce.id
FROM case_citation_edges cce
LEFT JOIN edrsr_case_index ci ON ci.cause_num = cce.to_case_number
LEFT JOIN edrsr_documents  fd ON fd.doc_id    = cce.from_case_id;

CREATE INDEX idx_ccl_from     ON case_citation_links(from_doc_id);
CREATE INDEX idx_ccl_tocase   ON case_citation_links(to_case_number);
CREATE INDEX idx_ccl_resolved ON case_citation_links(resolved);

ANALYZE edrsr_case_index;
ANALYZE case_citation_links;

\echo '=== edrsr_case_index ==='
SELECT count(*) AS distinct_cases, sum(member_count) AS member_decisions,
       round(avg(member_count),3) AS avg_members FROM edrsr_case_index;

\echo '=== case_citation_links COVERAGE ==='
SELECT count(*) AS total,
       count(*) FILTER (WHERE resolved) AS resolved,
       round(100.0*count(*) FILTER (WHERE resolved)/count(*),2) AS pct_resolved,
       count(*) FILTER (WHERE resolved AND NOT is_self_citation) AS resolved_precedent,
       count(*) FILTER (WHERE resolved AND is_self_citation)     AS resolved_self,
       count(DISTINCT from_doc_id)                                AS citing_decisions,
       count(DISTINCT to_case_number) FILTER (WHERE resolved)     AS distinct_cited_cases
FROM case_citation_links;

\echo '=== unresolved reasons ==='
SELECT unresolved_reason, count(*) FROM case_citation_links
WHERE NOT resolved GROUP BY 1 ORDER BY 2 DESC;
