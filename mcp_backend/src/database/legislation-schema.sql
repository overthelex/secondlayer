-- Legislation documents schema
-- Stores Ukrainian legislation with article-level granularity for efficient retrieval

-- Main legislation table (metadata)
CREATE TABLE IF NOT EXISTS legislation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rada_id VARCHAR(50) UNIQUE NOT NULL,  -- e.g., "1618-15" for CPC
  type VARCHAR(50) NOT NULL,  -- 'code', 'law', 'regulation'
  title TEXT NOT NULL,
  short_title VARCHAR(255),  -- e.g., "ЦПК України"
  full_url TEXT NOT NULL,
  adoption_date DATE,
  effective_date DATE,
  last_amended_date DATE,
  status VARCHAR(50) DEFAULT 'active',  -- 'active', 'amended', 'repealed'
  total_articles INTEGER,
  total_sections INTEGER,
  structure_metadata JSONB DEFAULT '{}',  -- Table of contents, sections hierarchy
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legislation_rada_id ON legislation(rada_id);
CREATE INDEX IF NOT EXISTS idx_legislation_type ON legislation(type);
CREATE INDEX IF NOT EXISTS idx_legislation_status ON legislation(status);
CREATE INDEX IF NOT EXISTS idx_legislation_title ON legislation USING gin(to_tsvector('ukrainian', title));

-- Articles table (granular storage)
CREATE TABLE IF NOT EXISTS legislation_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legislation_id UUID REFERENCES legislation(id) ON DELETE CASCADE,
  article_number VARCHAR(50) NOT NULL,  -- e.g., "354", "354-1"
  section_number VARCHAR(50),  -- e.g., "Розділ IV"
  chapter_number VARCHAR(50),  -- e.g., "Глава 1"
  title TEXT,  -- Article title if exists
  full_text TEXT NOT NULL,
  full_text_html TEXT,  -- Formatted HTML with proper structure
  part_number INTEGER,  -- For articles with multiple parts
  paragraph_number INTEGER,  -- For specific paragraphs
  notes TEXT,  -- Editorial notes, cross-references
  version_date DATE,  -- Date of this version
  is_current BOOLEAN DEFAULT true,
  byte_size INTEGER,  -- Size in bytes for loading optimization
  metadata JSONB DEFAULT '{}',  -- Cross-references, amendments history
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(legislation_id, article_number, version_date)
);

CREATE INDEX IF NOT EXISTS idx_articles_legislation ON legislation_articles(legislation_id);
CREATE INDEX IF NOT EXISTS idx_articles_number ON legislation_articles(article_number);
CREATE INDEX IF NOT EXISTS idx_articles_current ON legislation_articles(legislation_id, is_current) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_articles_section ON legislation_articles(section_number);
CREATE INDEX IF NOT EXISTS idx_articles_fulltext ON legislation_articles USING gin(to_tsvector('ukrainian', full_text));

-- Legislation chunks for vector search (smaller than articles for better retrieval)
CREATE TABLE IF NOT EXISTS legislation_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID REFERENCES legislation_articles(id) ON DELETE CASCADE,
  legislation_id UUID REFERENCES legislation(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,  -- Order within article
  text TEXT NOT NULL,
  vector_id VARCHAR(255) UNIQUE,  -- Qdrant point ID
  context_before TEXT,  -- Previous chunk for context
  context_after TEXT,  -- Next chunk for context
  metadata JSONB DEFAULT '{}',  -- Article number, section, etc.
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(article_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_article ON legislation_chunks(article_id);
CREATE INDEX IF NOT EXISTS idx_chunks_legislation ON legislation_chunks(legislation_id);
CREATE INDEX IF NOT EXISTS idx_chunks_vector ON legislation_chunks(vector_id);

-- Cross-references between legislation and court decisions
CREATE TABLE IF NOT EXISTS legislation_citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legislation_id UUID REFERENCES legislation(id) ON DELETE CASCADE,
  article_id UUID REFERENCES legislation_articles(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,  -- Court decision
  citation_context TEXT,  -- How the article is cited
  interpretation_type VARCHAR(50),  -- 'literal', 'broad', 'restrictive'
  frequency INTEGER DEFAULT 1,  -- How often cited together
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(article_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_citations_legislation ON legislation_citations(legislation_id);
CREATE INDEX IF NOT EXISTS idx_citations_article ON legislation_citations(article_id);
CREATE INDEX IF NOT EXISTS idx_citations_document ON legislation_citations(document_id);

-- Legislation versions (for tracking amendments)
CREATE TABLE IF NOT EXISTS legislation_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legislation_id UUID REFERENCES legislation(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  effective_date DATE NOT NULL,
  amendment_law_id VARCHAR(100),  -- ID of the law that amended this
  amendment_description TEXT,
  changed_articles TEXT[],  -- Array of article numbers that changed
  full_text_snapshot TEXT,  -- Complete text at this version (optional, for major versions)
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(legislation_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_versions_legislation ON legislation_versions(legislation_id);
CREATE INDEX IF NOT EXISTS idx_versions_date ON legislation_versions(effective_date);

-- Materialized view for quick article lookup with legislation context
CREATE MATERIALIZED VIEW IF NOT EXISTS legislation_articles_view AS
SELECT 
  la.id,
  la.article_number,
  la.title as article_title,
  la.full_text,
  la.full_text_html,
  la.section_number,
  la.chapter_number,
  l.rada_id,
  l.title as legislation_title,
  l.short_title,
  l.type as legislation_type,
  l.full_url,
  la.metadata,
  la.byte_size
FROM legislation_articles la
JOIN legislation l ON la.legislation_id = l.id
WHERE la.is_current = true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_articles_id ON legislation_articles_view(id);
CREATE INDEX IF NOT EXISTS idx_mv_articles_rada ON legislation_articles_view(rada_id, article_number);
CREATE INDEX IF NOT EXISTS idx_mv_articles_number ON legislation_articles_view(article_number);
