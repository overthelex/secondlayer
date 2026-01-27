-- Add legislation tables for storing Ukrainian legislation data
-- These tables support the legislation search and retrieval features

CREATE TABLE IF NOT EXISTS legislation (
  id SERIAL PRIMARY KEY,
  rada_id VARCHAR(50) UNIQUE NOT NULL,
  title TEXT NOT NULL,
  type VARCHAR(100),
  adoption_date DATE,
  full_text TEXT,
  metadata JSONB DEFAULT '{}',
  last_synced_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legislation_rada_id ON legislation(rada_id);
CREATE INDEX IF NOT EXISTS idx_legislation_title ON legislation USING gin(to_tsvector('simple', title));
CREATE INDEX IF NOT EXISTS idx_legislation_type ON legislation(type);

CREATE TABLE IF NOT EXISTS legislation_articles (
  id SERIAL PRIMARY KEY,
  legislation_id INTEGER REFERENCES legislation(id) ON DELETE CASCADE,
  rada_id VARCHAR(50) NOT NULL,
  article_number VARCHAR(50) NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  parent_article_id INTEGER REFERENCES legislation_articles(id) ON DELETE CASCADE,
  level INTEGER DEFAULT 0,
  position INTEGER DEFAULT 0,
  is_current BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(legislation_id, article_number)
);

CREATE INDEX IF NOT EXISTS idx_legislation_articles_rada_id ON legislation_articles(rada_id);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_article_number ON legislation_articles(article_number);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_content ON legislation_articles USING gin(to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS idx_legislation_articles_legislation_id ON legislation_articles(legislation_id);
CREATE INDEX IF NOT EXISTS idx_legislation_articles_parent ON legislation_articles(parent_article_id);

COMMENT ON TABLE legislation IS 'Stores Ukrainian legislation (laws, codes, constitutions)';
COMMENT ON TABLE legislation_articles IS 'Stores individual articles and sections of legislation';
