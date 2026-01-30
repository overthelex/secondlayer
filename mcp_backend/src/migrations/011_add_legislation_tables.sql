-- Migration 011: Create Legislation Tables
-- Creates the base legislation and legislation_articles tables

-- Create legislation table
CREATE TABLE IF NOT EXISTS legislation (
  id SERIAL PRIMARY KEY,
  rada_id VARCHAR(255) UNIQUE NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'code', 'law', 'regulation'
  title TEXT NOT NULL,
  short_title TEXT,
  full_url TEXT NOT NULL,
  adoption_date DATE,
  effective_date DATE,
  last_amended_date DATE,
  status VARCHAR(50) DEFAULT 'active' NOT NULL, -- 'active', 'amended', 'repealed'
  total_articles INTEGER,
  total_sections INTEGER,
  structure_metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_legislation_rada_id ON legislation(rada_id);
CREATE INDEX IF NOT EXISTS idx_legislation_type ON legislation(type);
CREATE INDEX IF NOT EXISTS idx_legislation_status ON legislation(status);
CREATE INDEX IF NOT EXISTS idx_legislation_title ON legislation USING gin(to_tsvector('simple', title));

COMMENT ON TABLE legislation IS 'Ukrainian legislation from Verkhovna Rada (codes, laws, regulations)';
COMMENT ON COLUMN legislation.rada_id IS 'Unique identifier from zakon.rada.gov.ua';
COMMENT ON COLUMN legislation.type IS 'Document type: code, law, or regulation';

-- Create legislation_articles table
CREATE TABLE IF NOT EXISTS legislation_articles (
  id SERIAL PRIMARY KEY,
  legislation_id INTEGER NOT NULL REFERENCES legislation(id) ON DELETE CASCADE,
  article_number VARCHAR(50) NOT NULL,
  section_number VARCHAR(50),
  chapter_number VARCHAR(50),
  title TEXT,
  full_text TEXT NOT NULL,
  full_text_html TEXT,
  part_number INTEGER,
  paragraph_number INTEGER,
  notes TEXT,
  version_date TIMESTAMP DEFAULT NOW() NOT NULL,
  byte_size INTEGER,
  is_current BOOLEAN DEFAULT true NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(legislation_id, article_number, version_date)
);

CREATE INDEX IF NOT EXISTS idx_legislation_articles_legislation_id ON legislation_articles(legislation_id);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_article_number ON legislation_articles(article_number);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_is_current ON legislation_articles(is_current);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_version_date ON legislation_articles(version_date);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_full_text ON legislation_articles USING gin(to_tsvector('simple', full_text));

COMMENT ON TABLE legislation_articles IS 'Articles and sections from Ukrainian legislation';
COMMENT ON COLUMN legislation_articles.article_number IS 'Article, section, or paragraph identifier (e.g., "Article 124", "Section 1.2")';
COMMENT ON COLUMN legislation_articles.is_current IS 'Whether this is the current version of the article';
COMMENT ON COLUMN legislation_articles.version_date IS 'Date of this version (for tracking amendments)';
