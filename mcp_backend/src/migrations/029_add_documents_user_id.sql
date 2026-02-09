-- Migration 029: Add user_id to documents table for GDPR per-user isolation
-- user_id = NULL means public document (ZakonOnline, legislation) accessible to all

DO $$ BEGIN
  -- Add user_id column if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE documents ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Indexes for user-scoped queries
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_user_id_type ON documents(user_id, type);

-- Backfill: link existing uploaded documents to their uploaders via upload_sessions
UPDATE documents d
SET user_id = us.user_id
FROM upload_sessions us
WHERE d.user_id IS NULL
  AND d.id = us.document_id
  AND us.user_id IS NOT NULL;
