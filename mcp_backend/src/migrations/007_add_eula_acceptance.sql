-- Migration: Add EULA acceptance tracking
-- Date: 2026-01-21
-- Description: Track user acceptance of End User License Agreement

-- Table to store EULA acceptance records
CREATE TABLE IF NOT EXISTS eula_acceptances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eula_version VARCHAR(50) NOT NULL DEFAULT '1.0',
  accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT,

  -- Ensure each user can only accept each version once
  UNIQUE(user_id, eula_version)
);

-- Index for quick lookup of user's acceptance status
CREATE INDEX IF NOT EXISTS idx_eula_acceptances_user_id ON eula_acceptances(user_id);
CREATE INDEX IF NOT EXISTS idx_eula_acceptances_accepted_at ON eula_acceptances(accepted_at);

-- Table to store EULA document versions
CREATE TABLE IF NOT EXISTS eula_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  version VARCHAR(50) NOT NULL UNIQUE,
  content TEXT NOT NULL,
  content_type VARCHAR(20) NOT NULL DEFAULT 'markdown', -- 'markdown', 'html', 'plain'
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for active EULA lookup
CREATE INDEX IF NOT EXISTS idx_eula_documents_active ON eula_documents(is_active, effective_date DESC);

-- Insert initial EULA version (placeholder - will be updated with actual content)
INSERT INTO eula_documents (version, content, content_type, is_active, effective_date)
VALUES ('1.0', 'EULA content will be loaded from EULA_manual_license.txt', 'markdown', true, CURRENT_TIMESTAMP)
ON CONFLICT (version) DO NOTHING;

-- Add comments
COMMENT ON TABLE eula_acceptances IS 'Tracks user acceptance of EULA versions';
COMMENT ON TABLE eula_documents IS 'Stores EULA document versions';
COMMENT ON COLUMN eula_acceptances.eula_version IS 'Version of EULA that was accepted';
COMMENT ON COLUMN eula_acceptances.ip_address IS 'IP address of user when accepting EULA';
COMMENT ON COLUMN eula_acceptances.user_agent IS 'User agent string when accepting EULA';
COMMENT ON COLUMN eula_documents.is_active IS 'Whether this EULA version is currently active';
COMMENT ON COLUMN eula_documents.effective_date IS 'Date when this EULA version became effective';
