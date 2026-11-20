-- build-case-citation-counts.sql  (LEXAI-2323)
--
-- case_citation_counts: how many distinct decisions cite each case (resolved links, self-
-- citations excluded). CitationGraphService.getCaseStats reads it; it replaces Neo4j's
-- Case.cited_by_count. Rebuilt whole, in one transaction; rerun after case_citation_links
-- changes (incremental-update.sh does).

\set ON_ERROR_STOP on
\timing on
SET statement_timeout = '2h';
SET lock_timeout = '10s';
SET work_mem = '1GB';

CREATE TABLE IF NOT EXISTS case_citation_counts (
  cause_num         text PRIMARY KEY,
  citing_decisions  int  NOT NULL
);

BEGIN;
CREATE TEMP TABLE ccc_new ON COMMIT DROP AS
SELECT to_case_number AS cause_num, count(DISTINCT from_doc_id)::int AS citing_decisions
  FROM case_citation_links
 WHERE resolved AND NOT is_self_citation
 GROUP BY to_case_number;
TRUNCATE case_citation_counts;
INSERT INTO case_citation_counts SELECT * FROM ccc_new;
COMMIT;
ANALYZE case_citation_counts;
SELECT count(*) AS cases, sum(citing_decisions) AS links,
       (SELECT citing_decisions FROM case_citation_counts WHERE cause_num = '761/9584/15-ц') AS "761/9584/15-ц"
  FROM case_citation_counts;
