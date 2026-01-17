-- Migration: Add full_text_html field to documents table
-- This stores the original HTML content from zakononline.ua

ALTER TABLE documents 
  ADD COLUMN IF NOT EXISTS full_text_html TEXT;

-- Add comment for documentation
COMMENT ON COLUMN documents.full_text_html IS 'Original HTML content from zakononline.ua court decision page';

-- Create index for documents with HTML (for monitoring)
CREATE INDEX IF NOT EXISTS idx_documents_has_html ON documents(zakononline_id) 
  WHERE full_text_html IS NOT NULL;

COMMENT ON INDEX idx_documents_has_html IS 'Quick lookup for documents that have HTML stored';
