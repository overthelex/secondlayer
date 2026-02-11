-- Migration 036: Add indexes for folder path navigation
-- Enables efficient folder-based document filtering and listing

CREATE INDEX IF NOT EXISTS idx_documents_folder_path
  ON documents ((metadata ->> 'folderPath'))
  WHERE metadata ->> 'folderPath' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_folder_path_pattern
  ON documents USING btree ((metadata ->> 'folderPath') text_pattern_ops)
  WHERE metadata ->> 'folderPath' IS NOT NULL;
