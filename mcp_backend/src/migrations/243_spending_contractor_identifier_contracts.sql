-- Companion to 240 (LEXAI-2191): contractor identifier GIN on spending_contracts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spending_contracts_contractor_identifier
  ON spending_contracts USING gin ((jsonb_path_query_array(contractors, '$[*].identifier')) jsonb_path_ops);
