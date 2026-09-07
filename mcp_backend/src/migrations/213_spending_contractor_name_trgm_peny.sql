-- Companion to 211: same trigram GIN on spending_peny. One CREATE INDEX CONCURRENTLY
-- per file, because the migration runner cannot wrap it in a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spending_peny_contractor_names_trgm
  ON spending_peny USING gin ((jsonb_path_query_array(contractors, '$[*].name')::text) gin_trgm_ops);
