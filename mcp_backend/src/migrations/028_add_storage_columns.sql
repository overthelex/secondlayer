-- Migration: Add storage columns to documents table
-- Purpose: Support dual storage (vault for parsed docs, minio for binary/media files)
-- Date: 2026-02-09

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'storage_type'
  ) THEN
    ALTER TABLE documents ADD COLUMN storage_type VARCHAR(16) DEFAULT 'vault';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'storage_path'
  ) THEN
    ALTER TABLE documents ADD COLUMN storage_path TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'file_size'
  ) THEN
    ALTER TABLE documents ADD COLUMN file_size BIGINT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'mime_type'
  ) THEN
    ALTER TABLE documents ADD COLUMN mime_type VARCHAR(255);
  END IF;
END $$;

COMMENT ON COLUMN documents.storage_type IS 'vault = parsed+embedded in PG/Qdrant, minio = binary in MinIO';
COMMENT ON COLUMN documents.storage_path IS 'MinIO object key (e.g. user-uuid/2026/02/filename.mp4)';
COMMENT ON COLUMN documents.file_size IS 'Original file size in bytes';
COMMENT ON COLUMN documents.mime_type IS 'MIME type of the original file';
