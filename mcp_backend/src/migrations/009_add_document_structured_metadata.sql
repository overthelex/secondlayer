-- Add structured metadata columns to documents table

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS case_number TEXT,
  ADD COLUMN IF NOT EXISTS court TEXT,
  ADD COLUMN IF NOT EXISTS chamber TEXT,
  ADD COLUMN IF NOT EXISTS dispute_category TEXT,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS deviation_flag BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_documents_case_number ON documents(case_number);
CREATE INDEX IF NOT EXISTS idx_documents_court ON documents(court);
CREATE INDEX IF NOT EXISTS idx_documents_chamber ON documents(chamber);
CREATE INDEX IF NOT EXISTS idx_documents_dispute_category ON documents(dispute_category);
CREATE INDEX IF NOT EXISTS idx_documents_outcome ON documents(outcome);
CREATE INDEX IF NOT EXISTS idx_documents_deviation_flag ON documents(deviation_flag);
