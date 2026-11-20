-- 033: relationship graph (030) — edge source 'prozorro' (LEXAI-2317).
--
-- registered_at edges from the supplier addresses of prozorro_contracts, for the addresses the
-- ЄДР dumps since 2021 no longer carry (services/graph/prozorro-addresses.ts). source_ref.prozorro
-- names the contracts (table, first/last contract date, contract ids). The builder recreates
-- graph.edge from its staging DDL (builder.ts stageDdl, which includes this source); the
-- constraint below keeps a database built before 033 consistent.
DO $$ BEGIN
  IF to_regclass('graph.edge') IS NOT NULL THEN
    ALTER TABLE graph.edge DROP CONSTRAINT IF EXISTS edge_source_check;
    ALTER TABLE graph.edge ADD CONSTRAINT edge_source_check
      CHECK (source IN ('edr_hist', 'edr_current', 'edrsr', 'prozorro'));
  END IF;
END $$;
