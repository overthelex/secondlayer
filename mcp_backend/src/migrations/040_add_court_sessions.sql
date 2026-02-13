-- Migration 040: Add court_sessions table
-- Stores court session metadata from ZakonOnline API

CREATE TABLE IF NOT EXISTS court_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  zakononline_id VARCHAR(255) UNIQUE,
  case_number VARCHAR(255),
  court_name TEXT,
  judge_name TEXT,
  session_date DATE,
  session_time VARCHAR(50),
  session_form VARCHAR(100),
  justice_kind VARCHAR(255),
  involved_parties TEXT,
  session_place TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_court_sessions_zo_id ON court_sessions(zakononline_id);
CREATE INDEX IF NOT EXISTS idx_court_sessions_case ON court_sessions(case_number);
CREATE INDEX IF NOT EXISTS idx_court_sessions_date ON court_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_court_sessions_court ON court_sessions USING gin(to_tsvector('russian', court_name));
CREATE INDEX IF NOT EXISTS idx_court_sessions_parties ON court_sessions USING gin(to_tsvector('russian', involved_parties));
