-- ============================================
-- SecondLayer Development Database Migration
-- ============================================
-- This script applies all migrations to the development PostgreSQL database
-- Execute on: secondlayer-postgres-dev container
-- Database: secondlayer_db
-- User: secondlayer
-- ============================================

\echo '================================================'
\echo 'Starting SecondLayer Development DB Migration'
\echo '================================================'
\echo ''

-- ============================================
-- MIGRATION 001: Initial Schema
-- ============================================
\echo 'Applying Migration 001: Initial Schema...'

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Таблица: documents
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  zakononline_id VARCHAR(255) UNIQUE,
  type VARCHAR(50),
  title TEXT,
  date DATE,
  full_text TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_zo_id ON documents(zakononline_id);
CREATE INDEX IF NOT EXISTS idx_date ON documents(date);
CREATE INDEX IF NOT EXISTS idx_type ON documents(type);

-- Таблица: document_sections
CREATE TABLE IF NOT EXISTS document_sections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  section_type VARCHAR(50),
  text TEXT,
  start_index INTEGER,
  end_index INTEGER,
  confidence FLOAT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_doc_sections ON document_sections(document_id);
CREATE INDEX IF NOT EXISTS idx_section_type ON document_sections(section_type);

-- Таблица: legal_patterns
CREATE TABLE IF NOT EXISTS legal_patterns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  intent VARCHAR(255),
  law_articles TEXT[],
  decision_outcome VARCHAR(50),
  frequency INTEGER DEFAULT 0,
  confidence FLOAT,
  example_cases UUID[],
  risk_factors TEXT[],
  success_arguments TEXT[],
  anti_patterns JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_intent ON legal_patterns(intent);
CREATE INDEX IF NOT EXISTS idx_decision_outcome ON legal_patterns(decision_outcome);

-- Таблица: embedding_chunks
CREATE TABLE IF NOT EXISTS embedding_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_section_id UUID REFERENCES document_sections(id) ON DELETE CASCADE,
  vector_id VARCHAR(255),
  text TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vector_id ON embedding_chunks(vector_id);
CREATE INDEX IF NOT EXISTS idx_document_section_id ON embedding_chunks(document_section_id);

-- Таблица: citation_links
CREATE TABLE IF NOT EXISTS citation_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_case_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  to_case_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  citation_type VARCHAR(50),
  context TEXT,
  section_type VARCHAR(50),
  confidence FLOAT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_case_id, to_case_id, citation_type)
);

CREATE INDEX IF NOT EXISTS idx_citation_from ON citation_links(from_case_id);
CREATE INDEX IF NOT EXISTS idx_citation_to ON citation_links(to_case_id);
CREATE INDEX IF NOT EXISTS idx_citation_type ON citation_links(citation_type);

-- Таблица: precedent_status
CREATE TABLE IF NOT EXISTS precedent_status (
  case_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  status VARCHAR(50),
  reversed_by UUID[],
  overruled_by UUID[],
  distinguished_in UUID[],
  last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confidence FLOAT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_precedent_status ON precedent_status(status);
CREATE INDEX IF NOT EXISTS idx_precedent_last_checked ON precedent_status(last_checked);

-- Таблица: events (вместо Kafka)
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type VARCHAR(100),
  payload JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_event_date ON events(created_at);

-- Функция для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Триггеры для автоматического обновления updated_at
DROP TRIGGER IF EXISTS update_documents_updated_at ON documents;
CREATE TRIGGER update_documents_updated_at BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_legal_patterns_updated_at ON legal_patterns;
CREATE TRIGGER update_legal_patterns_updated_at BEFORE UPDATE ON legal_patterns
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_precedent_status_updated_at ON precedent_status;
CREATE TRIGGER update_precedent_status_updated_at BEFORE UPDATE ON precedent_status
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

\echo '✓ Migration 001 completed'
\echo ''

-- ============================================
-- MIGRATION 002: Add HTML Field
-- ============================================
\echo 'Applying Migration 002: Add HTML Field...'

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS full_text_html TEXT;

\echo '✓ Migration 002 completed'
\echo ''

-- ============================================
-- MIGRATION 009: Add Structured Document Metadata
-- ============================================
\echo 'Applying Migration 009: Add Structured Document Metadata...'

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS case_number TEXT,
  ADD COLUMN IF NOT EXISTS court TEXT,
  ADD COLUMN IF NOT EXISTS chamber TEXT,
  ADD COLUMN IF NOT EXISTS dispute_category TEXT,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS deviation_flag BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_documents_case_number ON documents(case_number);
CREATE INDEX IF NOT EXISTS idx_documents_court ON documents(court);
CREATE INDEX IF NOT EXISTS idx_documents_chamber ON documents(chamber);
CREATE INDEX IF NOT EXISTS idx_documents_dispute_category ON documents(dispute_category);
CREATE INDEX IF NOT EXISTS idx_documents_outcome ON documents(outcome);
CREATE INDEX IF NOT EXISTS idx_documents_deviation_flag ON documents(deviation_flag);

\echo '✓ Migration 009 completed'
\echo ''

-- ============================================
-- MIGRATION 003: Add Cost Tracking
-- ============================================
\echo 'Applying Migration 003: Add Cost Tracking...'

-- Main cost tracking table
CREATE TABLE IF NOT EXISTS cost_tracking (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id VARCHAR(255) UNIQUE NOT NULL,

  -- API Provider tracking
  openai_input_tokens INTEGER DEFAULT 0,
  openai_output_tokens INTEGER DEFAULT 0,
  openai_cost_usd NUMERIC(10, 6) DEFAULT 0,

  zakononline_api_calls INTEGER DEFAULT 0,
  zakononline_cost_usd NUMERIC(10, 6) DEFAULT 0,

  -- Total cost
  total_cost_usd NUMERIC(10, 6) DEFAULT 0,

  -- Metadata
  tool_name VARCHAR(100),
  user_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Detailed breakdown
  cost_breakdown JSONB
);

CREATE INDEX IF NOT EXISTS idx_cost_request_id ON cost_tracking(request_id);
CREATE INDEX IF NOT EXISTS idx_cost_tool_name ON cost_tracking(tool_name);
CREATE INDEX IF NOT EXISTS idx_cost_user_id ON cost_tracking(user_id);
CREATE INDEX IF NOT EXISTS idx_cost_created_at ON cost_tracking(created_at);

\echo '✓ Migration 003 completed'
\echo ''

-- ============================================
-- MIGRATION 004: Add SecondLayer Tracking
-- ============================================
\echo 'Applying Migration 004: Add SecondLayer Tracking...'

-- Add SecondLayer MCP cost tracking columns
ALTER TABLE cost_tracking
  ADD COLUMN IF NOT EXISTS secondlayer_scraping_calls INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS secondlayer_processing_calls INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS secondlayer_cost_usd NUMERIC(10, 6) DEFAULT 0;

\echo '✓ Migration 004 completed'
\echo ''

-- ============================================
-- MIGRATION 005: Convert UAH to USD
-- ============================================
\echo 'Applying Migration 005: Convert UAH to USD...'

-- This migration is a no-op for new databases
-- It only affects databases with existing UAH data

\echo '✓ Migration 005 completed (no-op for new DB)'
\echo ''

-- ============================================
-- MIGRATION 006: Add Users Table
-- ============================================
\echo 'Applying Migration 006: Add Users Table...'

-- User authentication table for Google OAuth2
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  google_id VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  picture VARCHAR(500),
  email_verified BOOLEAN DEFAULT false,
  locale VARCHAR(10),
  last_login TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- User sessions table for session management
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  session_token VARCHAR(500) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);

-- Trigger for auto-updating updated_at on users table
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

\echo '✓ Migration 006 completed'
\echo ''

-- ============================================
-- Create migrations tracking table
-- ============================================
\echo 'Creating migrations tracking table...'

CREATE TABLE IF NOT EXISTS migrations (
  id SERIAL PRIMARY KEY,
  migration_name VARCHAR(255) UNIQUE NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Record applied migrations
INSERT INTO migrations (migration_name) VALUES
  ('001_initial_schema'),
  ('002_add_html_field'),
  ('009_add_document_structured_metadata'),
  ('003_add_cost_tracking'),
  ('004_add_secondlayer_tracking'),
  ('005_convert_uah_to_usd'),
  ('006_add_users_table')
ON CONFLICT (migration_name) DO NOTHING;

\echo '✓ Migrations tracking table created'
\echo ''

-- ============================================
-- Final verification
-- ============================================
\echo '================================================'
\echo 'Migration Summary'
\echo '================================================'
\echo ''
\echo 'Tables created:'
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
\echo ''
\echo 'Applied migrations:'
SELECT migration_name, applied_at FROM migrations ORDER BY id;
\echo ''
\echo '================================================'
\echo 'All migrations completed successfully! ✓'
\echo '================================================'
