-- rebuild-case-graph-01-finalize.sql  (LEXAI-2314)
--
-- Turns the staging heap filled by rebuild-case-edges.py (cce_rebuild_bulk) into
-- three NEW tables next to the live ones, which keep serving until
-- rebuild-case-graph-02-swap.sql renames them in one short transaction:
--
--   edrsr_case_index_new     same shape as edrsr_case_index, rebuilt from the current
--                            edrsr_documents (the old one is a July 2026 snapshot)
--   case_citation_edges_new  one row per (citing doc, normalized cited number)
--   case_citation_links_new  edges resolved against edrsr_case_index_new
--
-- Semantics of case_citation_links_new.to_case_number (changed by this rebuild):
--   resolved      -> the cited case's cause_num EXACTLY as edrsr_case_index /
--                    edrsr_documents spell it, so `to_case_number = cause_num` joins work
--   not resolved  -> the cited number as normalized by case_numbers.py
--                    («base» or «base-suffix», ASCII hyphen, lowercased Cyrillic suffix)
-- match_method: exact | normalized | suffix_completed | suffix_dropped
-- unresolved_reason: case_not_in_corpus | ambiguous_suffix
-- citation_context: the reference as written, starting at its first digit (findable
-- in edrsr_fulltext.full_text with strpos), not the old «№ …» match.
--
-- Nothing live is read-locked beyond a normal SELECT; nothing live is written.
--   docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local \
--     -v ON_ERROR_STOP=1 -f - < rebuild-case-graph-01-finalize.sql

\set ON_ERROR_STOP on
\timing on
SET statement_timeout = 0;
SET work_mem = '1GB';
SET maintenance_work_mem = '4GB';
SET max_parallel_workers_per_gather = 4;
SET max_parallel_maintenance_workers = 4;
SET jit = off;

-- The resolver key of a cause_num, the same normalization case_numbers.py applies to
-- a cited number: «base» or «base-suffix» for a known suffix, NULL for any other
-- shape (those can still match a cited number only exactly, which they never do,
-- since the extractor emits only the two shapes above).
CREATE OR REPLACE FUNCTION pg_temp.cg_norm(c text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  -- One expression, no sub-SELECT, so the planner inlines it: the first version (a LATERAL
  -- sub-select) could not be inlined and took 42 min over 49.8M cause_nums.
  SELECT CASE
    WHEN btrim(c) ~ '^\d{1,4}/\d{1,10}/\d{2,4}$' THEN btrim(c)
    WHEN btrim(c) ~ '^\d{1,4}/\d{1,10}/\d{2,4}\s*[-‐‑‒–—―−]\s*[A-Za-zА-Яа-яІіЇїЄєҐґ]{1,3}$'
     AND translate(lower(regexp_replace(btrim(c), '^.*[-‐‑‒–—―−]\s*', '')), 'aekcopxhwrgf', 'аексорхнцкпа')
         IN ('ц','к','п','а','г','е','ап','нр','б','н','на','зн','кр')
    THEN substring(btrim(c) from '^(\d{1,4}/\d{1,10}/\d{2,4})') || '-' ||
         translate(lower(regexp_replace(btrim(c), '^.*[-‐‑‒–—―−]\s*', '')), 'aekcopxhwrgf', 'аексорхнцкпа')
  END
$f$;

-- 1. Case dimension, current ------------------------------------------------
DROP TABLE IF EXISTS edrsr_case_index_new;   -- only ever our own staging table
CREATE TABLE edrsr_case_index_new AS
SELECT cause_num,
       count(*)::int                                                    AS member_count,
       min(adjudication_date)                                           AS first_date,
       max(adjudication_date)                                           AS last_date,
       (array_agg(doc_id ORDER BY adjudication_date DESC NULLS LAST))[1] AS latest_doc_id
FROM edrsr_documents
WHERE cause_num IS NOT NULL AND cause_num <> ''
GROUP BY cause_num;
ALTER TABLE edrsr_case_index_new ADD CONSTRAINT edrsr_case_index_new_pkey PRIMARY KEY (cause_num);
ANALYZE edrsr_case_index_new;

-- Resolver lookups (session temp tables).
-- norm -> the spelling with the most decisions (case-only spelling variants collapse).
CREATE TEMP TABLE cg_norm AS
SELECT DISTINCT ON (norm) norm, split_part(norm, '-', 1) AS base, cause_num, member_count, latest_doc_id
  FROM (SELECT pg_temp.cg_norm(cause_num) AS norm, cause_num, member_count, latest_doc_id
          FROM edrsr_case_index_new) s
 WHERE norm IS NOT NULL
 ORDER BY norm, member_count DESC NULLS LAST, cause_num;
CREATE UNIQUE INDEX ON cg_norm (norm);
ANALYZE cg_norm;

-- base -> how many distinct cases share it, and the one norm when it is unique.
CREATE TEMP TABLE cg_base AS
SELECT base, count(*)::int AS n_cases, min(norm) AS only_norm, bool_or(norm = base) AS has_bare
  FROM cg_norm GROUP BY base;
CREATE UNIQUE INDEX ON cg_base (base);
ANALYZE cg_base;

-- 2. Edges -----------------------------------------------------------------
DROP TABLE IF EXISTS case_citation_edges_new;
CREATE TABLE case_citation_edges_new (
  id               bigserial PRIMARY KEY,
  from_case_id     bigint NOT NULL,
  to_case_number   text   NOT NULL,
  citation_context text   DEFAULT '',
  justice_kind     smallint,
  adj_year         smallint,
  created_at       timestamptz DEFAULT now()
);
INSERT INTO case_citation_edges_new (from_case_id, to_case_number, citation_context, justice_kind, adj_year)
SELECT DISTINCT ON (from_case_id, to_case_number)
       from_case_id, to_case_number, citation_context, justice_kind, adj_year
  FROM cce_rebuild_bulk
 ORDER BY from_case_id, to_case_number;

-- justice_kind from edrsr_documents (edrsr_fulltext carries it for ~2% of rows).
-- edrsr_documents can hold a doc_id twice (seen: 137910810); the latest row wins.
CREATE TEMP TABLE cg_doc AS
SELECT DISTINCT ON (d.doc_id) d.doc_id, d.justice_kind, d.cause_num, pg_temp.cg_norm(d.cause_num) AS own_norm
  FROM edrsr_documents d
  JOIN (SELECT DISTINCT from_case_id FROM case_citation_edges_new) e ON e.from_case_id = d.doc_id
 ORDER BY d.doc_id, d.adjudication_date DESC NULLS LAST;
CREATE UNIQUE INDEX ON cg_doc (doc_id);
ANALYZE cg_doc;

UPDATE case_citation_edges_new e SET justice_kind = d.justice_kind
  FROM cg_doc d
 WHERE d.doc_id = e.from_case_id AND e.justice_kind IS NULL AND d.justice_kind IS NOT NULL;

CREATE UNIQUE INDEX uq_cce_new_dedup ON case_citation_edges_new (from_case_id, to_case_number);
CREATE INDEX idx_cce_new_adj_year ON case_citation_edges_new (adj_year);
ANALYZE case_citation_edges_new;

-- 3. Links -----------------------------------------------------------------
DROP TABLE IF EXISTS case_citation_links_new;
CREATE TABLE case_citation_links_new (
  id                bigserial PRIMARY KEY,
  from_doc_id       bigint  NOT NULL,
  to_case_number    text    NOT NULL,
  resolved          boolean NOT NULL,
  member_count      int     NOT NULL DEFAULT 0,
  latest_doc_id     bigint,
  is_self_citation  boolean NOT NULL DEFAULT false,
  match_method      text,
  unresolved_reason text,
  citation_context  text,
  adj_year          smallint,
  src_edge_id       bigint,
  created_at        timestamptz DEFAULT now()
);

INSERT INTO case_citation_links_new
  (from_doc_id, to_case_number, resolved, member_count, latest_doc_id, is_self_citation,
   match_method, unresolved_reason, citation_context, adj_year, src_edge_id)
SELECT e.from_case_id,
       COALESCE(r.cause_num, e.to_case_number),
       r.cause_num IS NOT NULL,
       COALESCE(r.member_count, 0),
       r.latest_doc_id,
       -- self: the citing decision's own case, or a bare citation of its own base number
       COALESCE(fd.own_norm = r.norm, false)
         OR COALESCE(fd.own_norm = e.to_case_number, false)
         OR COALESCE(e.to_case_number !~ '-' AND split_part(fd.own_norm, '-', 1) = e.to_case_number, false),
       CASE WHEN x.norm IS NOT NULL AND x.cause_num = e.to_case_number THEN 'exact'
            WHEN x.norm IS NOT NULL THEN 'normalized'
            WHEN y.norm IS NOT NULL AND e.to_case_number ~ '-' THEN 'suffix_dropped'
            WHEN y.norm IS NOT NULL THEN 'suffix_completed' END,
       CASE WHEN r.cause_num IS NULL THEN
            CASE WHEN e.to_case_number !~ '-' AND b.n_cases > 1 THEN 'ambiguous_suffix'
                 ELSE 'case_not_in_corpus' END
       END,
       e.citation_context,
       e.adj_year,
       e.id
  FROM case_citation_edges_new e
  -- the cited number itself is a case (any spelling of it)
  LEFT JOIN cg_norm x ON x.norm = e.to_case_number
  LEFT JOIN cg_base b ON b.base = split_part(e.to_case_number, '-', 1)
  -- otherwise: cited bare and exactly one case on that base (necessarily suffixed) ->
  -- complete it; cited with a suffix and EDRSR keeps the only case on the base bare ->
  -- drop it. Several cases on one base stay unresolved (ambiguous), never merged.
  LEFT JOIN cg_norm y ON x.norm IS NULL AND b.n_cases = 1
        AND y.norm = CASE WHEN e.to_case_number !~ '-' THEN b.only_norm
                          WHEN b.has_bare THEN b.base END
  CROSS JOIN LATERAL (SELECT COALESCE(x.norm, y.norm) AS norm,
                             COALESCE(x.cause_num, y.cause_num) AS cause_num,
                             COALESCE(x.member_count, y.member_count) AS member_count,
                             COALESCE(x.latest_doc_id, y.latest_doc_id) AS latest_doc_id) r
  LEFT JOIN cg_doc fd ON fd.doc_id = e.from_case_id;

CREATE INDEX idx_ccl_new_from     ON case_citation_links_new (from_doc_id);
CREATE INDEX idx_ccl_new_tocase   ON case_citation_links_new (to_case_number);
CREATE INDEX idx_ccl_new_resolved ON case_citation_links_new (resolved);
ANALYZE case_citation_links_new;

-- 4. Report ----------------------------------------------------------------
\echo '=== row counts old vs new ==='
SELECT 'edrsr_case_index' AS t, (SELECT count(*) FROM edrsr_case_index) AS old, (SELECT count(*) FROM edrsr_case_index_new) AS new
UNION ALL SELECT 'case_citation_edges', (SELECT count(*) FROM case_citation_edges), (SELECT count(*) FROM case_citation_edges_new)
UNION ALL SELECT 'case_citation_links', (SELECT count(*) FROM case_citation_links), (SELECT count(*) FROM case_citation_links_new);

\echo '=== links coverage (new) ==='
SELECT count(*) AS total,
       count(*) FILTER (WHERE resolved) AS resolved,
       round(100.0 * count(*) FILTER (WHERE resolved) / count(*), 2) AS pct_resolved,
       count(*) FILTER (WHERE resolved AND NOT is_self_citation) AS resolved_precedent,
       count(*) FILTER (WHERE is_self_citation) AS self,
       count(DISTINCT from_doc_id) AS citing_decisions,
       max(adj_year) AS max_year
  FROM case_citation_links_new;
SELECT match_method, unresolved_reason, count(*) FROM case_citation_links_new GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '=== newest citing decision ==='
SELECT max(d.adjudication_date) FROM edrsr_documents d
 WHERE d.doc_id = (SELECT max(from_doc_id) FROM case_citation_links_new);
