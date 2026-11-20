-- rebuild-case-graph-02-swap.sql  (LEXAI-2314)
--
-- Puts the tables built by rebuild-case-graph-01-finalize.sql in place of the live
-- ones in ONE short transaction: live -> *_old, *_new -> live, index names follow so
-- the live tables keep their usual index names. Readers see either the old set or
-- the new set, never a mix. lock_timeout keeps the swap from queueing behind a long
-- reader (and every new reader behind it); on timeout nothing changed — rerun it.
--
-- *_old tables are KEPT. Drop them by hand once the new graph is verified:
--   DROP TABLE case_citation_links_old, case_citation_edges_old, edrsr_case_index_old;
-- Rollback = the same renames in the other direction.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- refuse to run twice or half-built
DO $$
BEGIN
  IF to_regclass('public.case_citation_links_old') IS NOT NULL
     OR to_regclass('public.case_citation_edges_old') IS NOT NULL
     OR to_regclass('public.edrsr_case_index_old') IS NOT NULL THEN
    RAISE EXCEPTION '*_old tables already exist: drop or rename them first';
  END IF;
  IF to_regclass('public.idx_ccl_new_tocase') IS NULL OR to_regclass('public.uq_cce_new_dedup') IS NULL
     OR to_regclass('public.edrsr_case_index_new_pkey') IS NULL THEN
    RAISE EXCEPTION '*_new tables are not fully built (indexes missing)';
  END IF;
END $$;

ALTER TABLE edrsr_case_index RENAME TO edrsr_case_index_old;
ALTER INDEX edrsr_case_index_pkey RENAME TO edrsr_case_index_old_pkey;
ALTER TABLE edrsr_case_index_new RENAME TO edrsr_case_index;
ALTER INDEX edrsr_case_index_new_pkey RENAME TO edrsr_case_index_pkey;

ALTER TABLE case_citation_edges RENAME TO case_citation_edges_old;
ALTER INDEX case_citation_edges_pkey RENAME TO case_citation_edges_old_pkey;
ALTER INDEX uq_cce_dedup RENAME TO uq_cce_old_dedup;
ALTER INDEX idx_cce_adj_year RENAME TO idx_cce_old_adj_year;
ALTER TABLE case_citation_edges_new RENAME TO case_citation_edges;
ALTER INDEX case_citation_edges_new_pkey RENAME TO case_citation_edges_pkey;
ALTER INDEX uq_cce_new_dedup RENAME TO uq_cce_dedup;
ALTER INDEX idx_cce_new_adj_year RENAME TO idx_cce_adj_year;

ALTER TABLE case_citation_links RENAME TO case_citation_links_old;
ALTER INDEX case_citation_links_pkey RENAME TO case_citation_links_old_pkey;
ALTER INDEX idx_ccl_from RENAME TO idx_ccl_old_from;
ALTER INDEX idx_ccl_tocase RENAME TO idx_ccl_old_tocase;
ALTER INDEX idx_ccl_resolved RENAME TO idx_ccl_old_resolved;
ALTER TABLE case_citation_links_new RENAME TO case_citation_links;
ALTER INDEX case_citation_links_new_pkey RENAME TO case_citation_links_pkey;
ALTER INDEX idx_ccl_new_from RENAME TO idx_ccl_from;
ALTER INDEX idx_ccl_new_tocase RENAME TO idx_ccl_tocase;
ALTER INDEX idx_ccl_new_resolved RENAME TO idx_ccl_resolved;

COMMIT;

SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size
  FROM pg_class
 WHERE relname IN ('edrsr_case_index', 'case_citation_edges', 'case_citation_links',
                   'edrsr_case_index_old', 'case_citation_edges_old', 'case_citation_links_old')
 ORDER BY relname;
