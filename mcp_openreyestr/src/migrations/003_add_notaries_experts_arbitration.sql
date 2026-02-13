-- Migration 003: Add notaries, court experts, and arbitration managers registries
-- Source: NAIS (https://nais.gov.ua/pass_opendata)

-- Auxiliary tables first
CREATE TABLE IF NOT EXISTS registry_metadata (
  id SERIAL PRIMARY KEY,
  registry_id INTEGER UNIQUE,
  registry_name VARCHAR(255),
  registry_title TEXT,
  description TEXT,
  data_format VARCHAR(50),
  update_frequency VARCHAR(100),
  last_update_date DATE,
  official_url TEXT,
  dataset_url TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS import_log (
  id SERIAL PRIMARY KEY,
  registry_name VARCHAR(255),
  file_name VARCHAR(500),
  import_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  import_completed_at TIMESTAMP,
  records_imported INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'in_progress',
  error_message TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_import_log_registry ON import_log(registry_name);
CREATE INDEX IF NOT EXISTS idx_import_log_status ON import_log(status);

-- Notaries Registry
CREATE TABLE IF NOT EXISTS notaries (
  id SERIAL PRIMARY KEY,
  certificate_number VARCHAR(50) UNIQUE NOT NULL,
  full_name VARCHAR(255),
  region VARCHAR(255),
  district VARCHAR(255),
  organization VARCHAR(500),
  address TEXT,
  phone VARCHAR(50),
  email VARCHAR(255),
  certificate_date DATE,
  status VARCHAR(100),
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notaries_certificate ON notaries(certificate_number);
CREATE INDEX IF NOT EXISTS idx_notaries_name ON notaries USING gin(to_tsvector('russian', full_name));
CREATE INDEX IF NOT EXISTS idx_notaries_region ON notaries(region);
CREATE INDEX IF NOT EXISTS idx_notaries_status ON notaries(status);

-- Court Experts Registry
CREATE TABLE IF NOT EXISTS court_experts (
  id SERIAL PRIMARY KEY,
  expert_id VARCHAR(255) UNIQUE NOT NULL,
  full_name VARCHAR(255),
  region VARCHAR(255),
  organization TEXT,
  commission_name TEXT,
  expertise_types TEXT[],
  certificate_number VARCHAR(50),
  certificate_date DATE,
  status VARCHAR(100),
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_experts_id ON court_experts(expert_id);
CREATE INDEX IF NOT EXISTS idx_experts_name ON court_experts USING gin(to_tsvector('russian', full_name));
CREATE INDEX IF NOT EXISTS idx_experts_region ON court_experts(region);
CREATE INDEX IF NOT EXISTS idx_experts_types ON court_experts USING gin(expertise_types);
CREATE INDEX IF NOT EXISTS idx_experts_status ON court_experts(status);

-- Arbitration Managers Registry
CREATE TABLE IF NOT EXISTS arbitration_managers (
  id SERIAL PRIMARY KEY,
  registration_number VARCHAR(50) UNIQUE NOT NULL,
  registration_date DATE,
  full_name VARCHAR(255),
  certificate_number VARCHAR(50),
  certificate_status VARCHAR(100),
  certificate_issue_date DATE,
  certificate_change_date DATE,
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_arb_mgr_reg ON arbitration_managers(registration_number);
CREATE INDEX IF NOT EXISTS idx_arb_mgr_name ON arbitration_managers USING gin(to_tsvector('russian', full_name));
CREATE INDEX IF NOT EXISTS idx_arb_mgr_cert ON arbitration_managers(certificate_number);
CREATE INDEX IF NOT EXISTS idx_arb_mgr_status ON arbitration_managers(certificate_status);

-- Registry metadata
INSERT INTO registry_metadata (registry_id, registry_name, registry_title, data_format, update_frequency, active)
VALUES
  (1, 'legal_entities', 'Єдиний державний реєстр юридичних осіб, ФОП та ГФ', 'XML', 'Every 5 business days', true),
  (2, 'notaries', 'Єдиний реєстр нотаріусів', 'XML', 'Weekly', true),
  (3, 'court_experts', 'Державний реєстр атестованих судових експертів', 'XML', 'Every 5 business days', true),
  (7, 'arbitration_managers', 'Єдиний реєстр арбітражних керуючих України', 'XML', 'Daily', true)
ON CONFLICT DO NOTHING;
