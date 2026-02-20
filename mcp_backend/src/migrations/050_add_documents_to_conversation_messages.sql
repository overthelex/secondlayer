-- Migration 050: Add documents column to conversation_messages
-- Documents (vault files etc.) shown in right panel, analogous to decisions/citations

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS documents jsonb;
