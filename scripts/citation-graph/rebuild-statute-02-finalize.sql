-- rebuild-statute-02-finalize.sql  (LEXAI-2323)
--
-- After `rebuild-case-edges.py --layer statute` has filled decision_statute_citations:
-- index it (CONCURRENTLY, so the table stays readable) and build statute_article_stats,
-- the per-article totals the citation graph ranks by. Same index names as migration 297,
-- which is therefore a no-op on this database.
--
--   docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local < rebuild-statute-02-finalize.sql
-- Run in tmux. Measured 20.11.2026 (808.6M rows): indexes ~30 min, stats ~4 min.
-- Needs ~150 GB free on the data volume during the build (heap 95 GB, indexes, sort spill).

\set ON_ERROR_STOP on
\timing on
SET statement_timeout = 0;
SET lock_timeout = '30s';
SET maintenance_work_mem = '4GB';
SET max_parallel_maintenance_workers = 4;
SET work_mem = '1GB';
SET jit = off;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dsc_doc ON decision_statute_citations (doc_id);
-- (law_number, law_article) without doc_id on purpose: btree deduplication keeps it at
-- about the size of idx_dsc_doc; with doc_id every key is unique and it was 80 GB.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dsc_law_article ON decision_statute_citations (law_number, law_article);
VACUUM (ANALYZE) decision_statute_citations;

CREATE TABLE IF NOT EXISTS statute_article_stats (
  law_number       text   NOT NULL,
  law_article      text   NOT NULL,
  total_citations  bigint NOT NULL,
  unique_decisions bigint NOT NULL,
  PRIMARY KEY (law_number, law_article)
);

-- Rows without an article (a bare law or «ВС» reference) are not articles: the Neo4j
-- graph had no node for them either. They stay in decision_statute_citations.
BEGIN;
CREATE TEMP TABLE sas_new ON COMMIT DROP AS
-- Two levels instead of count(DISTINCT), so the planner can hash/parallelize the inner one.
SELECT law_number, law_article, sum(n)::bigint AS total_citations, count(*) AS unique_decisions
  FROM (SELECT law_number, law_article, doc_id, count(*) AS n
          FROM decision_statute_citations
         WHERE law_article <> ''
         GROUP BY law_number, law_article, doc_id) per_doc
 GROUP BY law_number, law_article;
TRUNCATE statute_article_stats;
INSERT INTO statute_article_stats SELECT * FROM sas_new;
COMMIT;
ANALYZE statute_article_stats;

\echo '=== decision_statute_citations ==='
SELECT count(*) AS rows, count(DISTINCT doc_id) AS decisions FROM decision_statute_citations;
\echo '=== statute_article_stats ==='
SELECT count(*) AS articles,
       count(*) FILTER (WHERE unique_decisions >= 5) AS articles_ge5,
       sum(total_citations) AS citations,
       sum(total_citations) FILTER (WHERE unique_decisions >= 5) AS citations_ge5
  FROM statute_article_stats;
