-- Migration 035: Upload recovery columns
-- Adds retry tracking and processing timestamps for stuck session recovery

ALTER TABLE upload_sessions
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMP WITH TIME ZONE;

-- Partial index for finding stuck sessions efficiently
CREATE INDEX IF NOT EXISTS idx_upload_sessions_stuck
  ON upload_sessions (status, updated_at)
  WHERE status IN ('assembling', 'processing');
