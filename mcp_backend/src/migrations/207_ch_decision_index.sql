-- mcp_backend/src/migrations/207_ch_decision_index.sql
-- Inbound-citation index over ch_case_citations (migration 199): one row per
-- decision the corpus actually cites, with the aggregate numbers the
-- precedent-status tools read (LEXAI-2034). The graph itself stays in
-- Postgres -- ~26.5M CH edges do not need a graph store, and every serving
-- query here is a primary-key lookup.
--
-- The table is maintained by decision_index_stage as a differential
-- refresh (upsert changed rows, delete rows whose inbound edges are gone),
-- never TRUNCATE+rebuild: a truncate takes ACCESS EXCLUSIVE and blocks the
-- serving reads for the whole rebuild transaction, and a nightly full
-- DELETE would leave ~1.5M dead rows for autovacuum every day for no
-- benefit -- the delta only moves a few thousand rows a night.
--
-- Only decisions WITH inbound citations get a row: an absent row means
-- "never cited", and keeping the other ~1M zero-rows would triple the table
-- for a value the reader can already infer from absence.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.ch_decision_index (
    ecli               text PRIMARY KEY,
    cited_by_count     integer NOT NULL,
    citing_courts      integer NOT NULL,      -- count(DISTINCT from_court)
    first_citing_date  date,                  -- min/max from_date over the
    last_citing_date   date,                  -- inbound edges; NULL when no
                                              -- citing decision carries a date
    refreshed_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ch_decision_index IS
    'Inbound-citation aggregates per cited decision, computed from resolved '
    'non-self ch_case_citations edges by decision_index_stage (differential '
    'refresh in the nightly delta). A decision with no row has never been '
    'cited. Serves ch_check_precedent_status / ch_get_citation_graph.';
