-- Companion to 240 (LEXAI-2191): contractor identifier GIN on spending_addendums.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spending_addendums_contractor_identifier
  ON spending_addendums USING gin ((jsonb_path_query_array(contractors, '$[*].identifier')) jsonb_path_ops);
