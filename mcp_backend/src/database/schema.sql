-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zakononline_id VARCHAR(255) UNIQUE NOT NULL,
  type VARCHAR(50) NOT NULL,
  title TEXT,
  date DATE,
  case_number TEXT,
  court TEXT,
  chamber TEXT,
  dispute_category TEXT,
  outcome TEXT,
  deviation_flag BOOLEAN,
  full_text TEXT,
  full_text_html TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zo_id ON documents(zakononline_id);
CREATE INDEX IF NOT EXISTS idx_date ON documents(date);
CREATE INDEX IF NOT EXISTS idx_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_case_number ON documents(case_number);
CREATE INDEX IF NOT EXISTS idx_documents_court ON documents(court);
CREATE INDEX IF NOT EXISTS idx_documents_chamber ON documents(chamber);
CREATE INDEX IF NOT EXISTS idx_documents_dispute_category ON documents(dispute_category);
CREATE INDEX IF NOT EXISTS idx_documents_outcome ON documents(outcome);
CREATE INDEX IF NOT EXISTS idx_documents_deviation_flag ON documents(deviation_flag);
CREATE INDEX IF NOT EXISTS idx_documents_has_html ON documents(zakononline_id) WHERE full_text_html IS NOT NULL;

-- Document sections table
CREATE TABLE IF NOT EXISTS document_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  section_type VARCHAR(50) NOT NULL,
  text TEXT NOT NULL,
  start_index INTEGER,
  end_index INTEGER,
  confidence FLOAT DEFAULT 0.0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_sections ON document_sections(document_id);
CREATE INDEX IF NOT EXISTS idx_section_type ON document_sections(section_type);

-- Legal patterns table
CREATE TABLE IF NOT EXISTS legal_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent VARCHAR(255) NOT NULL,
  law_articles TEXT[] DEFAULT '{}',
  decision_outcome VARCHAR(50),
  frequency INTEGER DEFAULT 0,
  confidence FLOAT DEFAULT 0.0,
  example_cases UUID[] DEFAULT '{}',
  risk_factors TEXT[] DEFAULT '{}',
  success_arguments TEXT[] DEFAULT '{}',
  anti_patterns JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intent ON legal_patterns(intent);
CREATE INDEX IF NOT EXISTS idx_outcome ON legal_patterns(decision_outcome);

-- Embedding chunks table
CREATE TABLE IF NOT EXISTS embedding_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_section_id UUID REFERENCES document_sections(id) ON DELETE CASCADE,
  vector_id VARCHAR(255) UNIQUE NOT NULL,
  text TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vector_id ON embedding_chunks(vector_id);
CREATE INDEX IF NOT EXISTS idx_section_chunk ON embedding_chunks(document_section_id);

-- Citation links table
CREATE TABLE IF NOT EXISTS citation_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_case_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  to_case_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  citation_type VARCHAR(50) NOT NULL,
  context TEXT,
  section_type VARCHAR(50),
  confidence FLOAT DEFAULT 0.0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(from_case_id, to_case_id, citation_type)
);

CREATE INDEX IF NOT EXISTS idx_citation_from ON citation_links(from_case_id);
CREATE INDEX IF NOT EXISTS idx_citation_to ON citation_links(to_case_id);
CREATE INDEX IF NOT EXISTS idx_citation_type ON citation_links(citation_type);

-- Precedent status table
CREATE TABLE IF NOT EXISTS precedent_status (
  case_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL,
  reversed_by UUID[] DEFAULT '{}',
  overruled_by UUID[] DEFAULT '{}',
  distinguished_in UUID[] DEFAULT '{}',
  last_checked TIMESTAMP DEFAULT NOW(),
  confidence FLOAT DEFAULT 0.0,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_precedent_status ON precedent_status(status);

-- Events table (instead of Kafka)
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(100) NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_event_date ON events(created_at);
