-- 298_citation_graph_doc_ndistinct.sql  (LEXAI-2323)
--
-- ANALYZE samples 30K rows of decision_statute_citations (808M rows, ~7 per decision, stored
-- in doc_id order) and estimated 193K distinct doc_ids instead of 118M. The planner then
-- expected ~4,000 rows per decision and drove the citation summary from statute_article_stats
-- with a parallel scan: get_court_decision timed out at 60 s on prod (20.11.2026). Pin the
-- ratio (distinct decisions / rows); takes effect at the next ANALYZE, which follows here.
-- Idempotent; a no-op where the table does not exist.
DO $$
BEGIN
  IF to_regclass('public.decision_statute_citations') IS NOT NULL THEN
    ALTER TABLE decision_statute_citations ALTER COLUMN doc_id SET (n_distinct = -0.146);
    ANALYZE decision_statute_citations (doc_id);
  END IF;
END $$;
