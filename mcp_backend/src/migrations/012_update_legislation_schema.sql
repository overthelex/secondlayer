-- Update legislation tables to match RadaLegislationAdapter expectations
-- This migration adds missing columns and updates the schema

-- First, check if we need to migrate existing data
-- Legislation table updates
ALTER TABLE legislation
  ADD COLUMN IF NOT EXISTS short_title TEXT,
  ADD COLUMN IF NOT EXISTS full_url TEXT,
  ADD COLUMN IF NOT EXISTS effective_date DATE,
  ADD COLUMN IF NOT EXISTS last_amended_date DATE,
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS total_articles INTEGER,
  ADD COLUMN IF NOT EXISTS total_sections INTEGER,
  ADD COLUMN IF NOT EXISTS structure_metadata JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Drop old full_text column if it exists (we store full text in articles now)
ALTER TABLE legislation DROP COLUMN IF EXISTS full_text;

-- Legislation articles table updates
ALTER TABLE legislation_articles
  ADD COLUMN IF NOT EXISTS section_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS chapter_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS full_text TEXT,
  ADD COLUMN IF NOT EXISTS full_text_html TEXT,
  ADD COLUMN IF NOT EXISTS part_number INTEGER,
  ADD COLUMN IF NOT EXISTS paragraph_number INTEGER,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS version_date TIMESTAMP DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS byte_size INTEGER,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Migrate existing content column to full_text if content exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'legislation_articles' AND column_name = 'content'
  ) THEN
    EXECUTE 'UPDATE legislation_articles SET full_text = content WHERE full_text IS NULL AND content IS NOT NULL';
    -- Drop old content column
    ALTER TABLE legislation_articles DROP COLUMN content;
  END IF;
END $$;

-- Make full_text NOT NULL after migration (only if it exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'legislation_articles' AND column_name = 'full_text'
  ) THEN
    ALTER TABLE legislation_articles ALTER COLUMN full_text SET NOT NULL;
  END IF;
END $$;

-- Drop old rada_id column from articles (we get it from legislation table via foreign key)
-- Note: PostgreSQL doesn't support IF NOT EXISTS with DROP COLUMN, checking existence first
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'legislation_articles' AND column_name = 'rada_id'
  ) THEN
    ALTER TABLE legislation_articles DROP COLUMN rada_id;
  END IF;
END $$;

-- Drop old constraints that might conflict
ALTER TABLE legislation_articles DROP CONSTRAINT IF EXISTS legislation_articles_legislation_id_article_number_key;

-- Add unique constraint for (legislation_id, article_number, version_date)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legislation_articles_legislation_id_article_number_version_date_key') THEN
    ALTER TABLE legislation_articles
      ADD CONSTRAINT legislation_articles_legislation_id_article_number_version_date_key
      UNIQUE (legislation_id, article_number, version_date);
  END IF;
END $$;

-- Add indexes for new columns
CREATE INDEX IF NOT EXISTS idx_legislation_short_title ON legislation(short_title);
CREATE INDEX IF NOT EXISTS idx_legislation_status ON legislation(status);
CREATE INDEX IF NOT EXISTS idx_legislation_updated_at ON legislation(updated_at);

CREATE INDEX IF NOT EXISTS idx_legislation_articles_section ON legislation_articles(section_number);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_chapter ON legislation_articles(chapter_number);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_version ON legislation_articles(version_date);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_is_current ON legislation_articles(is_current);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_updated_at ON legislation_articles(updated_at);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_full_text ON legislation_articles USING gin(to_tsvector('simple', full_text));

-- Create legislation_chunks table for vector search
CREATE TABLE IF NOT EXISTS legislation_chunks (
  id SERIAL PRIMARY KEY,
  article_id INTEGER REFERENCES legislation_articles(id) ON DELETE CASCADE,
  legislation_id INTEGER REFERENCES legislation(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  vector_id VARCHAR(255) UNIQUE,
  context_before TEXT,
  context_after TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(article_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_legislation_chunks_article_id ON legislation_chunks(article_id);
CREATE INDEX IF NOT EXISTS idx_legislation_chunks_legislation_id ON legislation_chunks(legislation_id);
CREATE INDEX IF NOT EXISTS idx_legislation_chunks_vector_id ON legislation_chunks(vector_id);
CREATE INDEX IF NOT EXISTS idx_legislation_chunks_text ON legislation_chunks USING gin(to_tsvector('simple', text));

COMMENT ON TABLE legislation_chunks IS 'Stores text chunks of legislation articles for vector search';
