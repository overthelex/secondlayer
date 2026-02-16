-- Add full-text search index on creditor_name for enforcement_proceedings
-- Enables fast text search via to_tsvector/plainto_tsquery (matches existing debtor_name index pattern)
CREATE INDEX IF NOT EXISTS idx_enforce_creditor ON enforcement_proceedings USING gin (to_tsvector('russian', creditor_name));
