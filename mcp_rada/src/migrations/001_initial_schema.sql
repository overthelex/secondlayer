-- Migration 001: Initial Schema for RADA MCP Server
-- Core tables for parliament data: deputies, bills, legislation, voting records

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Deputies table (cached from data.rada.gov.ua/ogd/mps)
CREATE TABLE IF NOT EXISTS deputies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core identity
  rada_id VARCHAR(50) UNIQUE NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  short_name VARCHAR(255),

  -- Status
  convocation INTEGER NOT NULL DEFAULT 9,
  active BOOLEAN DEFAULT true,
  status VARCHAR(50),

  -- Political affiliation
  faction_id VARCHAR(100),
  faction_name VARCHAR(255),
  committee_id VARCHAR(100),
  committee_name VARCHAR(255),
  committee_role VARCHAR(100),

  -- Demographics
  gender VARCHAR(1),
  birth_date DATE,
  birth_place TEXT,

  -- Contact
  region VARCHAR(100),
  district VARCHAR(255),
  phone VARCHAR(50),
  email VARCHAR(100),

  -- Metadata
  photo_url TEXT,
  biography TEXT,
  assistant_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',

  -- Cache control
  cached_at TIMESTAMP DEFAULT NOW(),
  cache_expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '7 days',
  last_synced TIMESTAMP DEFAULT NOW(),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deputies_rada_id ON deputies(rada_id);
CREATE INDEX IF NOT EXISTS idx_deputies_active ON deputies(active);
CREATE INDEX IF NOT EXISTS idx_deputies_faction ON deputies(faction_id);
CREATE INDEX IF NOT EXISTS idx_deputies_committee ON deputies(committee_id);
CREATE INDEX IF NOT EXISTS idx_deputies_cache_expires ON deputies(cache_expires_at);
CREATE INDEX IF NOT EXISTS idx_deputies_convocation ON deputies(convocation);
CREATE INDEX IF NOT EXISTS idx_deputies_full_name ON deputies(full_name);

-- Deputy assistants (cached from mps_assistants)
CREATE TABLE IF NOT EXISTS deputy_assistants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deputy_id UUID REFERENCES deputies(id) ON DELETE CASCADE,

  assistant_type VARCHAR(100),
  full_name VARCHAR(255),
  start_date DATE,
  end_date DATE,

  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_assistants_deputy ON deputy_assistants(deputy_id);

-- Bills/законопроекти (hybrid: cache frequently accessed, fetch fresh for real-time)
CREATE TABLE IF NOT EXISTS bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core identity
  bill_number VARCHAR(50) UNIQUE NOT NULL,
  title TEXT NOT NULL,

  -- Status and stage
  registration_date DATE,
  status VARCHAR(100),
  stage VARCHAR(100),

  -- Initiator
  initiator_type VARCHAR(50),
  initiator_names TEXT[],
  initiator_ids UUID[],

  -- Committee
  main_committee_id VARCHAR(100),
  main_committee_name VARCHAR(255),

  -- Subject classification
  subject_area VARCHAR(255),
  law_articles TEXT[],

  -- Full text
  full_text TEXT,
  explanatory_note TEXT,

  -- Metadata
  url TEXT,
  metadata JSONB DEFAULT '{}',

  -- Cache control
  cached_at TIMESTAMP DEFAULT NOW(),
  cache_expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '1 day',

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_bills_number ON bills(bill_number);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_committee ON bills(main_committee_id);
CREATE INDEX idx_bills_registration_date ON bills(registration_date);
CREATE INDEX idx_bills_cache_expires ON bills(cache_expires_at);
CREATE INDEX idx_bills_title ON bills USING gin(to_tsvector('english', title));

-- Legislation texts (cached from zakon.rada.gov.ua)
CREATE TABLE IF NOT EXISTS legislation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core identity
  law_number VARCHAR(100) UNIQUE NOT NULL,
  law_alias VARCHAR(100),

  -- Metadata
  title TEXT NOT NULL,
  law_type VARCHAR(50),
  adoption_date DATE,
  effective_date DATE,
  status VARCHAR(50),

  -- Full text
  full_text_html TEXT,
  full_text_plain TEXT,
  article_count INTEGER,

  -- Structure (for semantic search)
  articles JSONB DEFAULT '[]',
  chapters JSONB DEFAULT '[]',

  -- Metadata
  url TEXT,
  metadata JSONB DEFAULT '{}',

  -- Cache control
  cached_at TIMESTAMP DEFAULT NOW(),
  cache_expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days',

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_legislation_number ON legislation(law_number);
CREATE INDEX idx_legislation_alias ON legislation(law_alias);
CREATE INDEX idx_legislation_type ON legislation(law_type);
CREATE INDEX idx_legislation_cache_expires ON legislation(cache_expires_at);
CREATE INDEX idx_legislation_title ON legislation USING gin(to_tsvector('english', title));
CREATE INDEX idx_legislation_full_text ON legislation USING gin(to_tsvector('english', full_text_plain));

-- Voting records
CREATE TABLE IF NOT EXISTS voting_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Session identification
  session_date DATE NOT NULL,
  session_number INTEGER,
  question_number INTEGER,

  -- Question details
  question_text TEXT,
  bill_number VARCHAR(50),
  question_type VARCHAR(50),

  -- Results
  total_voted INTEGER,
  voted_for INTEGER,
  voted_against INTEGER,
  voted_abstain INTEGER,
  voted_not_present INTEGER,
  result VARCHAR(50),

  -- Individual votes (stored as JSONB for flexibility)
  votes JSONB DEFAULT '{}',

  -- Metadata
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_voting_session_date ON voting_records(session_date);
CREATE INDEX idx_voting_bill_number ON voting_records(bill_number);
CREATE INDEX idx_voting_result ON voting_records(result);
CREATE INDEX idx_voting_question ON voting_records USING gin(to_tsvector('english', question_text));

-- Factions and committees (cached metadata)
CREATE TABLE IF NOT EXISTS factions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faction_id VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  convocation INTEGER DEFAULT 9,
  member_count INTEGER,
  created_date DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_factions_id ON factions(faction_id);
CREATE INDEX idx_factions_convocation ON factions(convocation);

CREATE TABLE IF NOT EXISTS committees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  convocation INTEGER DEFAULT 9,
  chair_deputy_id UUID REFERENCES deputies(id),
  member_count INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_committees_id ON committees(committee_id);
CREATE INDEX idx_committees_convocation ON committees(convocation);
CREATE INDEX idx_committees_chair ON committees(chair_deputy_id);

-- Migrations tracking table
CREATE TABLE IF NOT EXISTS migrations (
  id SERIAL PRIMARY KEY,
  migration_name VARCHAR(255) UNIQUE NOT NULL,
  executed_at TIMESTAMP DEFAULT NOW()
);

-- Auto-update trigger function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables with updated_at
CREATE TRIGGER update_deputies_updated_at BEFORE UPDATE ON deputies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_bills_updated_at BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_legislation_updated_at BEFORE UPDATE ON legislation
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
