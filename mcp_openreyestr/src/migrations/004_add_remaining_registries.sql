-- Migration 004: Add remaining NAIS registries (8 of 11)
-- Source: NAIS (https://nais.gov.ua/pass_opendata)
-- Adds: special_forms, forensic_methods, bankruptcy_cases, legal_acts,
--        administrative_units, streets, enforcement_proceedings, debtors

-- Special Forms Registry (Єдиний реєстр спеціальних бланків нотаріальних документів)
CREATE TABLE IF NOT EXISTS special_forms (
  id SERIAL PRIMARY KEY,
  series VARCHAR(20) NOT NULL,
  form_number VARCHAR(50) NOT NULL,
  issue_date DATE,
  recipient VARCHAR(500),
  usage_info TEXT,
  usage_date DATE,
  document_type VARCHAR(255),
  status VARCHAR(100),
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (series, form_number)
);

CREATE INDEX IF NOT EXISTS idx_special_forms_series ON special_forms(series);
CREATE INDEX IF NOT EXISTS idx_special_forms_number ON special_forms(form_number);
CREATE INDEX IF NOT EXISTS idx_special_forms_status ON special_forms(status);
CREATE INDEX IF NOT EXISTS idx_special_forms_issue_date ON special_forms(issue_date);

-- Forensic Methods Registry (Реєстр методик проведення судових експертиз)
CREATE TABLE IF NOT EXISTS forensic_methods (
  id SERIAL PRIMARY KEY,
  registration_code VARCHAR(50) UNIQUE NOT NULL,
  expertise_type VARCHAR(500),
  method_name TEXT,
  developer VARCHAR(500),
  year_created INTEGER,
  registration_date DATE,
  registration_info TEXT,
  status VARCHAR(100),
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_forensic_methods_code ON forensic_methods(registration_code);
CREATE INDEX IF NOT EXISTS idx_forensic_methods_type ON forensic_methods(expertise_type);
CREATE INDEX IF NOT EXISTS idx_forensic_methods_name ON forensic_methods USING gin(to_tsvector('russian', method_name));
CREATE INDEX IF NOT EXISTS idx_forensic_methods_year ON forensic_methods(year_created);

-- Bankruptcy Cases Registry (Реєстр підприємств у справах про банкрутство)
CREATE TABLE IF NOT EXISTS bankruptcy_cases (
  id SERIAL PRIMARY KEY,
  registration_number VARCHAR(50) UNIQUE NOT NULL,
  registration_date DATE,
  case_number VARCHAR(100),
  court_decision_date DATE,
  debtor_name TEXT,
  debtor_edrpou VARCHAR(10),
  debtor_type VARCHAR(50),
  proceeding_status VARCHAR(255),
  court_name VARCHAR(500),
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bankruptcy_reg ON bankruptcy_cases(registration_number);
CREATE INDEX IF NOT EXISTS idx_bankruptcy_debtor ON bankruptcy_cases USING gin(to_tsvector('russian', debtor_name));
CREATE INDEX IF NOT EXISTS idx_bankruptcy_edrpou ON bankruptcy_cases(debtor_edrpou);
CREATE INDEX IF NOT EXISTS idx_bankruptcy_status ON bankruptcy_cases(proceeding_status);
CREATE INDEX IF NOT EXISTS idx_bankruptcy_date ON bankruptcy_cases(registration_date);

-- Legal Acts Registry (Єдиний державний реєстр нормативно-правових актів)
CREATE TABLE IF NOT EXISTS legal_acts (
  id SERIAL PRIMARY KEY,
  act_id VARCHAR(100) UNIQUE NOT NULL,
  publisher VARCHAR(500),
  act_type VARCHAR(255),
  act_number VARCHAR(100),
  act_date DATE,
  act_title TEXT,
  act_text TEXT,
  registration_number VARCHAR(100),
  registration_date DATE,
  status VARCHAR(100),
  effective_date DATE,
  termination_date DATE,
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_legal_acts_id ON legal_acts(act_id);
CREATE INDEX IF NOT EXISTS idx_legal_acts_publisher ON legal_acts(publisher);
CREATE INDEX IF NOT EXISTS idx_legal_acts_type ON legal_acts(act_type);
CREATE INDEX IF NOT EXISTS idx_legal_acts_date ON legal_acts(act_date);
CREATE INDEX IF NOT EXISTS idx_legal_acts_title ON legal_acts USING gin(to_tsvector('russian', act_title));
CREATE INDEX IF NOT EXISTS idx_legal_acts_status ON legal_acts(status);

-- Administrative Units Dictionary (Словник адміністративно-територіального устрою)
CREATE TABLE IF NOT EXISTS administrative_units (
  id SERIAL PRIMARY KEY,
  koatuu VARCHAR(20) UNIQUE NOT NULL,
  unit_type VARCHAR(50),
  region VARCHAR(255),
  district VARCHAR(255),
  settlement_name VARCHAR(500),
  full_name TEXT,
  parent_koatuu VARCHAR(20),
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_units_koatuu ON administrative_units(koatuu);
CREATE INDEX IF NOT EXISTS idx_admin_units_type ON administrative_units(unit_type);
CREATE INDEX IF NOT EXISTS idx_admin_units_region ON administrative_units(region);
CREATE INDEX IF NOT EXISTS idx_admin_units_name ON administrative_units USING gin(to_tsvector('russian', settlement_name));
CREATE INDEX IF NOT EXISTS idx_admin_units_parent ON administrative_units(parent_koatuu);

-- Streets Dictionary (Словник вулиць населених пунктів)
CREATE TABLE IF NOT EXISTS streets (
  id SERIAL PRIMARY KEY,
  street_id VARCHAR(50),
  settlement_koatuu VARCHAR(20),
  street_type VARCHAR(50),
  street_name VARCHAR(500),
  full_address TEXT,
  region VARCHAR(255),
  district VARCHAR(255),
  settlement VARCHAR(500),
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (settlement_koatuu, street_name, street_type)
);

CREATE INDEX IF NOT EXISTS idx_streets_koatuu ON streets(settlement_koatuu);
CREATE INDEX IF NOT EXISTS idx_streets_type ON streets(street_type);
CREATE INDEX IF NOT EXISTS idx_streets_name ON streets USING gin(to_tsvector('russian', street_name));
CREATE INDEX IF NOT EXISTS idx_streets_region ON streets(region);

-- Enforcement Proceedings (Автоматизована система виконавчого провадження) — CSV format
CREATE TABLE IF NOT EXISTS enforcement_proceedings (
  id SERIAL PRIMARY KEY,
  proceeding_number VARCHAR(100) UNIQUE NOT NULL,
  opening_date DATE,
  proceeding_status VARCHAR(255),
  debtor_name TEXT,
  debtor_type VARCHAR(50),
  debtor_edrpou VARCHAR(10),
  creditor_name TEXT,
  creditor_type VARCHAR(50),
  creditor_edrpou VARCHAR(10),
  enforcement_agency VARCHAR(500),
  executor_name VARCHAR(255),
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_enforce_number ON enforcement_proceedings(proceeding_number);
CREATE INDEX IF NOT EXISTS idx_enforce_debtor ON enforcement_proceedings USING gin(to_tsvector('russian', debtor_name));
CREATE INDEX IF NOT EXISTS idx_enforce_debtor_edrpou ON enforcement_proceedings(debtor_edrpou);
CREATE INDEX IF NOT EXISTS idx_enforce_status ON enforcement_proceedings(proceeding_status);
CREATE INDEX IF NOT EXISTS idx_enforce_date ON enforcement_proceedings(opening_date);

-- Debtors Registry (Єдиний реєстр боржників) — CSV format
CREATE TABLE IF NOT EXISTS debtors (
  id SERIAL PRIMARY KEY,
  proceeding_number VARCHAR(100),
  debtor_name TEXT,
  debtor_type VARCHAR(50),
  debtor_edrpou VARCHAR(10),
  issuing_authority VARCHAR(500),
  issuing_person VARCHAR(255),
  enforcement_agency VARCHAR(500),
  executor_name VARCHAR(255),
  executor_phone VARCHAR(50),
  executor_email VARCHAR(255),
  collection_category VARCHAR(255),
  raw_data JSONB,
  data_source VARCHAR(255) DEFAULT 'NAIS',
  source_file VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (proceeding_number, debtor_name, debtor_edrpou)
);

CREATE INDEX IF NOT EXISTS idx_debtors_proceeding ON debtors(proceeding_number);
CREATE INDEX IF NOT EXISTS idx_debtors_name ON debtors USING gin(to_tsvector('russian', debtor_name));
CREATE INDEX IF NOT EXISTS idx_debtors_edrpou ON debtors(debtor_edrpou);
CREATE INDEX IF NOT EXISTS idx_debtors_type ON debtors(debtor_type);
CREATE INDEX IF NOT EXISTS idx_debtors_category ON debtors(collection_category);

-- Insert remaining registry_metadata rows
INSERT INTO registry_metadata (registry_id, registry_name, registry_title, data_format, update_frequency, active)
VALUES
  (4, 'special_forms', 'Єдиний реєстр спеціальних бланків нотаріальних документів', 'XML', 'Weekly', true),
  (5, 'forensic_methods', 'Реєстр методик проведення судових експертиз', 'XML', 'Weekly', true),
  (6, 'bankruptcy_cases', 'Реєстр підприємств у справах про банкрутство', 'XML', 'Daily', true),
  (8, 'legal_acts', 'Єдиний державний реєстр нормативно-правових актів', 'XML', 'Weekly', true),
  (9, 'administrative_units', 'Словник адміністративно-територіального устрою України', 'XML', 'Weekly', true),
  (10, 'streets', 'Словник вулиць населених пунктів', 'XML', 'Weekly', true),
  (11, 'enforcement_proceedings', 'Інформація з автоматизованої системи виконавчого провадження', 'CSV', 'Daily', true),
  (12, 'debtors', 'Єдиний реєстр боржників', 'CSV', 'Daily', true)
ON CONFLICT DO NOTHING;
