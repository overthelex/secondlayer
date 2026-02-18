-- Migration 008: Add content_hash column for diff-based import
-- Used by DatabaseImporter to skip unchanged entities via MD5 hash comparison

ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS content_hash VARCHAR(32);
ALTER TABLE individual_entrepreneurs ADD COLUMN IF NOT EXISTS content_hash VARCHAR(32);
ALTER TABLE public_associations ADD COLUMN IF NOT EXISTS content_hash VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_legal_entities_content_hash ON legal_entities(content_hash);
CREATE INDEX IF NOT EXISTS idx_individual_entrepreneurs_content_hash ON individual_entrepreneurs(content_hash);
CREATE INDEX IF NOT EXISTS idx_public_associations_content_hash ON public_associations(content_hash);
