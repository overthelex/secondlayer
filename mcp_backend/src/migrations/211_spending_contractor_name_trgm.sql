-- search_public_spending matches a contractor by name with
--   EXISTS (SELECT 1 FROM jsonb_array_elements(contractors) c WHERE c->>'name' ILIKE '%X%')
-- which no index can serve, so every call fell back to a full seq scan plus a sort of
-- the whole table. On spending_addendums (2.1M rows / 1.9 GB) that ran past the tool's
-- 15s budget and the table was dropped from the result as `failed_tables` — the caller
-- got "total: 3" for a contractor that actually has 677 rows there.
--
-- A trigram GIN over the contractor names alone (avg 33 bytes/row against 407 for the
-- whole contractors JSON) makes the ILIKE index-backed. jsonb_path_query_array is
-- IMMUTABLE, so it is legal in an index expression; the query repeats this exact
-- expression as a prefilter and keeps the original EXISTS to preserve semantics.
--
-- CONCURRENTLY, and one statement per file: the runner sends each file as a single
-- simple query, so a multi-statement file would be wrapped in an implicit transaction
-- and CONCURRENTLY would be rejected. Measured build times on prod: addendums 18s,
-- acts (9.4M rows) under two minutes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spending_acts_contractor_names_trgm
  ON spending_acts USING gin ((jsonb_path_query_array(contractors, '$[*].name')::text) gin_trgm_ops);
