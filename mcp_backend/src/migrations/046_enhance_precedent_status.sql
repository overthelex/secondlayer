-- Migration 046: Enhance precedent_status for Shepardization
-- Adds columns for case-number-based lookups, affecting decision chain,
-- and creates shepardization_log for audit/analytics.

ALTER TABLE precedent_status
  ADD COLUMN IF NOT EXISTS case_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS target_doc_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS affecting_decisions JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS check_source VARCHAR(50) DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS ttl_expires_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_precedent_case_number ON precedent_status(case_number);
CREATE INDEX IF NOT EXISTS idx_precedent_ttl ON precedent_status(ttl_expires_at);

CREATE TABLE IF NOT EXISTS shepardization_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_number VARCHAR(100) NOT NULL,
  target_doc_id VARCHAR(50),
  status VARCHAR(50),
  confidence FLOAT,
  chain_length INTEGER,
  source VARCHAR(50),
  duration_ms INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shepard_log_case ON shepardization_log(case_number);
CREATE INDEX IF NOT EXISTS idx_shepard_log_created ON shepardization_log(created_at);
