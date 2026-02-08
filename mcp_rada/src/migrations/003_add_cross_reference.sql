-- Migration 003: Add cross-reference tables
-- This migration adds tables for linking RADA data with SecondLayer court cases

-- Law citations cross-reference table
CREATE TABLE IF NOT EXISTS law_court_citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RADA side
  law_number VARCHAR(100) NOT NULL,
  law_article VARCHAR(50),

  -- SecondLayer side (external reference)
  court_case_id UUID,
  court_case_number VARCHAR(100),

  -- Citation metadata
  citation_count INTEGER DEFAULT 1,
  last_citation_date DATE,
  citation_context TEXT,

  -- Cross-server sync
  synced_from_secondlayer BOOLEAN DEFAULT false,
  last_sync_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_law_citations_law ON law_court_citations(law_number);
CREATE INDEX IF NOT EXISTS idx_law_citations_article ON law_court_citations(law_article);
CREATE INDEX IF NOT EXISTS idx_law_citations_case ON law_court_citations(court_case_id);
CREATE INDEX IF NOT EXISTS idx_law_citations_case_number ON law_court_citations(court_case_number);
CREATE INDEX IF NOT EXISTS idx_law_citations_sync ON law_court_citations(synced_from_secondlayer);
CREATE INDEX IF NOT EXISTS idx_law_citations_date ON law_court_citations(last_citation_date);

-- Unique constraint to prevent duplicate citations
CREATE UNIQUE INDEX IF NOT EXISTS idx_law_citations_unique
  ON law_court_citations(law_number, COALESCE(law_article, ''), court_case_number);

-- Bill impact analysis (optional future enhancement)
CREATE TABLE IF NOT EXISTS bill_court_impact (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  bill_number VARCHAR(50) NOT NULL,
  related_law_number VARCHAR(100),

  -- Court cases citing the law being amended
  affected_cases_count INTEGER DEFAULT 0,
  affected_cases JSONB DEFAULT '[]',

  -- AI-generated analysis
  impact_analysis TEXT,
  impact_score DECIMAL(3, 2), -- 0.00 to 1.00

  -- Metadata
  analysis_date TIMESTAMP DEFAULT NOW(),
  analyst VARCHAR(100), -- 'gpt-4o', 'claude-sonnet-4.5', etc.

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bill_impact_bill ON bill_court_impact(bill_number);
CREATE INDEX IF NOT EXISTS idx_bill_impact_law ON bill_court_impact(related_law_number);
CREATE INDEX IF NOT EXISTS idx_bill_impact_score ON bill_court_impact(impact_score);

-- Add foreign key to bills table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_bill_impact_bill'
  ) THEN
    ALTER TABLE bill_court_impact
      ADD CONSTRAINT fk_bill_impact_bill
      FOREIGN KEY (bill_number) REFERENCES bills(bill_number)
      ON DELETE CASCADE;
  END IF;
END $$;

-- Deputy activity in court cases (track when deputies are mentioned in cases)
CREATE TABLE IF NOT EXISTS deputy_court_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  deputy_id UUID NOT NULL,
  court_case_id UUID,
  court_case_number VARCHAR(100) NOT NULL,

  -- Mention context
  mention_type VARCHAR(50), -- 'plaintiff', 'defendant', 'witness', 'mentioned', 'author_of_law'
  mention_context TEXT,

  -- Metadata
  synced_from_secondlayer BOOLEAN DEFAULT false,
  last_sync_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deputy_mentions_deputy ON deputy_court_mentions(deputy_id);
CREATE INDEX IF NOT EXISTS idx_deputy_mentions_case ON deputy_court_mentions(court_case_number);
CREATE INDEX IF NOT EXISTS idx_deputy_mentions_type ON deputy_court_mentions(mention_type);

-- Add foreign key to deputies table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_deputy_mentions_deputy'
  ) THEN
    ALTER TABLE deputy_court_mentions
      ADD CONSTRAINT fk_deputy_mentions_deputy
      FOREIGN KEY (deputy_id) REFERENCES deputies(id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- Auto-update trigger for updated_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_law_citations_updated_at'
  ) THEN
    CREATE TRIGGER update_law_citations_updated_at BEFORE UPDATE ON law_court_citations
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_bill_impact_updated_at'
  ) THEN
    CREATE TRIGGER update_bill_impact_updated_at BEFORE UPDATE ON bill_court_impact
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
