-- Migration 039: Add ZakonOnline dictionaries table
-- Stores cached dictionary data from ZakonOnline API (courts, judges, regions, etc.)

CREATE TABLE IF NOT EXISTS zo_dictionaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain VARCHAR(50) NOT NULL,
  dictionary_name VARCHAR(50) NOT NULL,
  data JSONB NOT NULL DEFAULT '[]',
  items_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(domain, dictionary_name)
);

CREATE INDEX IF NOT EXISTS idx_zo_dictionaries_domain ON zo_dictionaries(domain);
CREATE INDEX IF NOT EXISTS idx_zo_dictionaries_name ON zo_dictionaries(dictionary_name);

COMMENT ON TABLE zo_dictionaries IS 'Cached ZakonOnline API dictionaries (courts, judges, regions, etc.)';
COMMENT ON COLUMN zo_dictionaries.domain IS 'ZO API domain: court_decisions, court_sessions, legal_acts, court_practice';
COMMENT ON COLUMN zo_dictionaries.dictionary_name IS 'Dictionary type: courts, instances, judgmentForms, justiceKinds, regions, judges, documentTypes, authors, categories, types';
COMMENT ON COLUMN zo_dictionaries.data IS 'Full dictionary response as JSON array';

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_zo_dictionaries_timestamp ON zo_dictionaries;
CREATE TRIGGER update_zo_dictionaries_timestamp
BEFORE UPDATE ON zo_dictionaries
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
