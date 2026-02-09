-- Migration: Add upload_sessions table for chunked file uploads
-- Purpose: Track multi-chunk file upload sessions with resume support
-- Date: 2026-02-09

CREATE TABLE IF NOT EXISTS upload_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name VARCHAR(512) NOT NULL,
  file_size BIGINT NOT NULL,
  mime_type VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  total_chunks INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  uploaded_chunks INTEGER[] DEFAULT '{}',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  doc_type VARCHAR(64) NOT NULL DEFAULT 'other',
  relative_path TEXT,
  metadata JSONB DEFAULT '{}',
  document_id UUID,
  error_message TEXT,
  expires_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_id ON upload_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions(status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires_at ON upload_sessions(expires_at);

COMMENT ON TABLE upload_sessions IS 'Tracks chunked file upload sessions with resume support';
COMMENT ON COLUMN upload_sessions.uploaded_chunks IS 'Array of chunk indices that have been successfully uploaded';
COMMENT ON COLUMN upload_sessions.status IS 'pending | uploading | assembling | processing | completed | failed | cancelled | expired';
COMMENT ON COLUMN upload_sessions.expires_at IS 'Session auto-expires after 24 hours of inactivity';
