-- Initial schema for SecondLayer MCP
-- Создание всех таблиц согласно архитектуре MVP

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
CREATE TRIGGER update_documents_updated_at BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_legal_patterns_updated_at BEFORE UPDATE ON legal_patterns
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_precedent_status_updated_at BEFORE UPDATE ON precedent_status
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
