-- Migration 183: distinct-judge lookup so the judge filter stops scanning EDRSR (LEXAI-1927)
--
-- `search_court_decisions` filters by judge with a substring match, because the
-- tools advertise partial names ("ПІБ судді або частина ПІБ"). That was rendered
-- as `LOWER(d.judge) LIKE LOWER('%value%')` against edrsr_documents — 135.8M rows
-- across 26 partitions. A leading wildcard cannot use the per-partition b-tree on
-- judge, and LOWER(judge) would not match a plain judge index anyway, so EXPLAIN
-- showed a Seq Scan on every partition. Measured through the tool: hybrid+judge
-- 120 s, fulltext+judge >90 s, structured+judge 83 s. The vector leg, once its own
-- index was fixed, answered the same filter in 2.7 s.
--
-- The fix is to do the substring match where it is cheap. There are only 26,642
-- distinct judges in the whole registry, so resolving the fragment against a
-- derived table and then filtering by equality lets the existing b-tree indexes do
-- the work. Semantics are unchanged: the same LIKE runs, just over 26k rows rather
-- than 135.8M. Verified identical result counts (17,540 for '%Писана%'), with the
-- query going from 15,170 ms to 33 ms.
--
-- Derived from edrsr_documents itself, which matters: `judges_current` (5,952 rows)
-- holds only sitting judges and `judge_analytics` is likewise partial — both were
-- missing "Потолова Ганна Володимирівна", who has 6,400 decisions from 2012. A
-- lookup built from the decisions themselves is complete by construction.
--
-- decisions count is carried along so callers can rank or disambiguate: the data
-- has no single canonical spelling per judge, e.g. "Писана Таміла Олександрівна"
-- (12,240) and "Писана Т.О." (5,034) are the same person recorded two ways.

CREATE MATERIALIZED VIEW IF NOT EXISTS edrsr_judges_distinct AS
  SELECT judge, count(*) AS decisions
    FROM edrsr_documents
   WHERE judge IS NOT NULL AND btrim(judge) <> ''
   GROUP BY judge;

-- unique index is a hard requirement for REFRESH MATERIALIZED VIEW CONCURRENTLY,
-- which is how this should be refreshed so readers never see an empty view
CREATE UNIQUE INDEX IF NOT EXISTS idx_ejd_judge
  ON edrsr_judges_distinct (judge);

-- trigram GIN over a 4.5 MB table: the substring resolve lands in ~2 ms
CREATE INDEX IF NOT EXISTS idx_ejd_judge_trgm
  ON edrsr_judges_distinct USING gin (lower(judge) gin_trgm_ops);

ANALYZE edrsr_judges_distinct;

-- The 2009 partition was the only one without a judge index, so it would have gone
-- on seq-scanning even after the rewrite.
CREATE INDEX IF NOT EXISTS idx_ed_p_2009_judge
  ON edrsr_documents_p_2009 (judge);

-- Refresh after each EDRSR sync; ~17 s to rebuild from scratch on 135.8M rows.
--   REFRESH MATERIALIZED VIEW CONCURRENTLY edrsr_judges_distinct;
