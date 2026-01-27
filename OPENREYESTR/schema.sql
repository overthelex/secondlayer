-- NAIS Open Data Database Schema
-- Database: opendata_db
-- User: opendatauser

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ====================================================================================
-- 1. Єдиний державний реєстр юридичних осіб (Legal Entities Registry)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS legal_entities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    edrpou VARCHAR(10) UNIQUE NOT NULL, -- ЄДРПОУ код
    full_name TEXT NOT NULL,
    short_name TEXT,
    legal_form VARCHAR(255),
    status VARCHAR(100),
    registration_date DATE,
    termination_date DATE,
    address TEXT,
    region VARCHAR(255),
    activity_type VARCHAR(500),
    authorized_capital NUMERIC,
    founders JSONB, -- Structured founder data
    management JSONB, -- Management persons
    raw_data JSONB, -- Full XML data
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE INDEX idx_legal_entities_edrpou ON legal_entities(edrpou);
CREATE INDEX idx_legal_entities_status ON legal_entities(status);
CREATE INDEX idx_legal_entities_region ON legal_entities(region);
CREATE INDEX idx_legal_entities_name ON legal_entities USING gin(to_tsvector('russian', full_name));

-- ====================================================================================
-- 2. Єдиний реєстр нотаріусів (Notaries Registry)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS notaries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    certificate_number VARCHAR(50) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    region VARCHAR(255),
    district VARCHAR(255),
    organization VARCHAR(500),
    address TEXT,
    phone VARCHAR(50),
    email VARCHAR(255),
    certificate_date DATE,
    status VARCHAR(100),
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE INDEX idx_notaries_cert ON notaries(certificate_number);
CREATE INDEX idx_notaries_region ON notaries(region);
CREATE INDEX idx_notaries_status ON notaries(status);
CREATE INDEX idx_notaries_name ON notaries USING gin(to_tsvector('russian', full_name));

-- ====================================================================================
-- 3. Державний реєстр атестованих судових експертів (Court Experts Registry)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS court_experts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    expert_id VARCHAR(50) UNIQUE,
    full_name VARCHAR(255) NOT NULL,
    region VARCHAR(255),
    organization VARCHAR(500),
    commission_name VARCHAR(500),
    expertise_types TEXT[], -- Array of expertise types
    certificate_number VARCHAR(50),
    certificate_date DATE,
    status VARCHAR(100),
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE INDEX idx_court_experts_id ON court_experts(expert_id);
CREATE INDEX idx_court_experts_region ON court_experts(region);
CREATE INDEX idx_court_experts_types ON court_experts USING gin(expertise_types);
CREATE INDEX idx_court_experts_name ON court_experts USING gin(to_tsvector('russian', full_name));

-- ====================================================================================
-- 4. Єдиний реєстр спеціальних бланків (Special Forms Registry)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS special_forms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    series VARCHAR(20),
    form_number VARCHAR(50) NOT NULL,
    issue_date DATE,
    recipient VARCHAR(500),
    usage_info TEXT,
    usage_date DATE,
    document_type VARCHAR(255),
    status VARCHAR(100),
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500),
    UNIQUE(series, form_number)
);

CREATE INDEX idx_special_forms_series ON special_forms(series);
CREATE INDEX idx_special_forms_number ON special_forms(form_number);
CREATE INDEX idx_special_forms_issue_date ON special_forms(issue_date);
CREATE INDEX idx_special_forms_status ON special_forms(status);

-- ====================================================================================
-- 5. Реєстр методик проведення судових експертиз (Forensic Methods Registry)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS forensic_methods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    registration_code VARCHAR(50) UNIQUE NOT NULL,
    expertise_type VARCHAR(500),
    method_name TEXT NOT NULL,
    developer VARCHAR(500),
    year_created INTEGER,
    registration_date DATE,
    registration_info TEXT,
    status VARCHAR(100),
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE INDEX idx_forensic_methods_code ON forensic_methods(registration_code);
CREATE INDEX idx_forensic_methods_type ON forensic_methods(expertise_type);
CREATE INDEX idx_forensic_methods_year ON forensic_methods(year_created);
CREATE INDEX idx_forensic_methods_name ON forensic_methods USING gin(to_tsvector('russian', method_name));

-- ====================================================================================
-- 6. Єдиний реєстр підприємств-банкрутів (Bankruptcy Registry)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS bankruptcy_cases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    registration_number VARCHAR(50) UNIQUE NOT NULL,
    registration_date DATE,
    case_number VARCHAR(100),
    court_decision_date DATE,
    debtor_name TEXT NOT NULL,
    debtor_edrpou VARCHAR(10),
    debtor_type VARCHAR(50), -- legal/individual
    proceeding_status VARCHAR(255),
    court_name VARCHAR(500),
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE INDEX idx_bankruptcy_reg_num ON bankruptcy_cases(registration_number);
CREATE INDEX idx_bankruptcy_edrpou ON bankruptcy_cases(debtor_edrpou);
CREATE INDEX idx_bankruptcy_status ON bankruptcy_cases(proceeding_status);
CREATE INDEX idx_bankruptcy_date ON bankruptcy_cases(registration_date);
CREATE INDEX idx_bankruptcy_debtor ON bankruptcy_cases USING gin(to_tsvector('russian', debtor_name));

-- ====================================================================================
-- 7. Єдиний реєстр арбітражних керуючих (Arbitration Managers Registry)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS arbitration_managers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    registration_number VARCHAR(50) UNIQUE NOT NULL,
    registration_date DATE,
    full_name VARCHAR(255) NOT NULL,
    certificate_number VARCHAR(50),
    certificate_status VARCHAR(100),
    certificate_issue_date DATE,
    certificate_change_date DATE,
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE INDEX idx_arb_managers_reg_num ON arbitration_managers(registration_number);
CREATE INDEX idx_arb_managers_cert ON arbitration_managers(certificate_number);
CREATE INDEX idx_arb_managers_status ON arbitration_managers(certificate_status);
CREATE INDEX idx_arb_managers_name ON arbitration_managers USING gin(to_tsvector('russian', full_name));

-- ====================================================================================
-- 8. Єдиний державний реєстр нормативно-правових актів (Legal Acts Registry)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS legal_acts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    act_id VARCHAR(100) UNIQUE NOT NULL,
    publisher VARCHAR(500), -- Видавник
    act_type VARCHAR(255), -- Вид акта
    act_number VARCHAR(100),
    act_date DATE,
    act_title TEXT NOT NULL,
    act_text TEXT, -- Full text
    registration_number VARCHAR(100),
    registration_date DATE,
    status VARCHAR(100),
    effective_date DATE,
    termination_date DATE,
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE INDEX idx_legal_acts_id ON legal_acts(act_id);
CREATE INDEX idx_legal_acts_type ON legal_acts(act_type);
CREATE INDEX idx_legal_acts_date ON legal_acts(act_date);
CREATE INDEX idx_legal_acts_publisher ON legal_acts(publisher);
CREATE INDEX idx_legal_acts_title ON legal_acts USING gin(to_tsvector('russian', act_title));
CREATE INDEX idx_legal_acts_text ON legal_acts USING gin(to_tsvector('russian', act_text));

-- ====================================================================================
-- 9. Словник адміністративно-територіального устрою (Administrative Dictionary)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS administrative_units (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    koatuu VARCHAR(20) UNIQUE, -- КОАТУУ код
    unit_type VARCHAR(50), -- область, район, місто, село
    region VARCHAR(255),
    district VARCHAR(255),
    settlement_name VARCHAR(500),
    full_name TEXT,
    parent_koatuu VARCHAR(20),
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE TABLE IF NOT EXISTS streets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    street_id VARCHAR(50),
    settlement_koatuu VARCHAR(20),
    street_type VARCHAR(50), -- вулиця, провулок, площа
    street_name VARCHAR(500) NOT NULL,
    full_address TEXT,
    region VARCHAR(255),
    district VARCHAR(255),
    settlement VARCHAR(500),
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500),
    FOREIGN KEY (settlement_koatuu) REFERENCES administrative_units(koatuu)
);

CREATE INDEX idx_admin_units_koatuu ON administrative_units(koatuu);
CREATE INDEX idx_admin_units_type ON administrative_units(unit_type);
CREATE INDEX idx_admin_units_region ON administrative_units(region);
CREATE INDEX idx_admin_units_name ON administrative_units USING gin(to_tsvector('russian', settlement_name));

CREATE INDEX idx_streets_koatuu ON streets(settlement_koatuu);
CREATE INDEX idx_streets_type ON streets(street_type);
CREATE INDEX idx_streets_region ON streets(region);
CREATE INDEX idx_streets_name ON streets USING gin(to_tsvector('russian', street_name));

-- ====================================================================================
-- 10. Інформація з системи виконавчого провадження (Enforcement System)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS enforcement_proceedings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    proceeding_number VARCHAR(100) UNIQUE NOT NULL,
    opening_date DATE,
    proceeding_status VARCHAR(255),
    debtor_name TEXT,
    debtor_type VARCHAR(50), -- individual/legal
    debtor_edrpou VARCHAR(10),
    creditor_name TEXT,
    creditor_type VARCHAR(50),
    creditor_edrpou VARCHAR(10),
    enforcement_agency VARCHAR(500),
    executor_name VARCHAR(255),
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE INDEX idx_enforcement_number ON enforcement_proceedings(proceeding_number);
CREATE INDEX idx_enforcement_status ON enforcement_proceedings(proceeding_status);
CREATE INDEX idx_enforcement_debtor_edrpou ON enforcement_proceedings(debtor_edrpou);
CREATE INDEX idx_enforcement_date ON enforcement_proceedings(opening_date);
CREATE INDEX idx_enforcement_debtor ON enforcement_proceedings USING gin(to_tsvector('russian', debtor_name));

-- ====================================================================================
-- 11. Єдиний реєстр боржників (Debtors Registry)
-- ====================================================================================
CREATE TABLE IF NOT EXISTS debtors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    proceeding_number VARCHAR(100) NOT NULL,
    debtor_name TEXT NOT NULL,
    debtor_type VARCHAR(50), -- individual/legal
    debtor_edrpou VARCHAR(10),
    issuing_authority VARCHAR(500),
    issuing_person VARCHAR(255),
    enforcement_agency VARCHAR(500),
    executor_name VARCHAR(255),
    executor_phone VARCHAR(50),
    executor_email VARCHAR(255),
    collection_category VARCHAR(255), -- аліменти, штраф тощо
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

CREATE INDEX idx_debtors_proceeding ON debtors(proceeding_number);
CREATE INDEX idx_debtors_edrpou ON debtors(debtor_edrpou);
CREATE INDEX idx_debtors_type ON debtors(debtor_type);
CREATE INDEX idx_debtors_category ON debtors(collection_category);
CREATE INDEX idx_debtors_name ON debtors USING gin(to_tsvector('russian', debtor_name));

-- ====================================================================================
-- Metadata and Import Tracking
-- ====================================================================================
CREATE TABLE IF NOT EXISTS import_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    registry_name VARCHAR(255) NOT NULL,
    registry_id INTEGER,
    file_name VARCHAR(500) NOT NULL,
    file_url TEXT,
    file_date DATE,
    import_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    import_completed_at TIMESTAMP,
    records_imported INTEGER DEFAULT 0,
    records_failed INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'in_progress', -- in_progress, completed, failed
    error_message TEXT,
    metadata JSONB
);

CREATE INDEX idx_import_log_registry ON import_log(registry_name);
CREATE INDEX idx_import_log_status ON import_log(status);
CREATE INDEX idx_import_log_date ON import_log(import_started_at);

-- ====================================================================================
-- Registry metadata table
-- ====================================================================================
CREATE TABLE IF NOT EXISTS registry_metadata (
    id SERIAL PRIMARY KEY,
    registry_id INTEGER UNIQUE NOT NULL,
    registry_name VARCHAR(255) NOT NULL,
    registry_title TEXT NOT NULL,
    description TEXT,
    data_format VARCHAR(50), -- XML, CSV
    update_frequency VARCHAR(100),
    last_update_date DATE,
    official_url TEXT,
    dataset_url TEXT,
    schema_url TEXT,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert metadata for all 11 registries
INSERT INTO registry_metadata (registry_id, registry_name, registry_title, data_format, update_frequency, official_url) VALUES
(1, 'legal_entities', 'Єдиний державний реєстр юридичних осіб, фізичних осіб-підприємців та громадських формувань', 'XML', 'Кожні 5 робочих днів', 'https://nais.gov.ua/m/ediniy-derjavniy-reestr-yuridichnih-osib-fizichnih-osib-pidpriemtsiv-ta-gromadskih-formuvan'),
(2, 'notaries', 'Єдиний реєстр нотаріусів', 'XML', 'Щотижня', 'https://nais.gov.ua/m/ediniy-reestr-notariusiv-188'),
(3, 'court_experts', 'Державний реєстр атестованих судових експертів', 'XML', 'Не пізніше 5 робочих днів з дня внесення змін', 'https://nais.gov.ua/m/derjavniy-reestr-atestovanih-sudovih-ekspertiv-189'),
(4, 'special_forms', 'Єдиний реєстр спеціальних бланків нотаріальних документів', 'XML', 'Щотижня', 'https://nais.gov.ua/m/ediniy-reestr-spetsialnih-blankiv-notarialnih-dokumentiv-190'),
(5, 'forensic_methods', 'Реєстр методик проведення судових експертиз', 'XML', 'Щотижня', 'https://nais.gov.ua/m/reestr-metodik-provedennya-sudovih-ekspertiz-192'),
(6, 'bankruptcy_cases', 'Єдиний реєстр підприємств, щодо яких порушено впровадження у справі про банкрутство', 'XML', 'Щодня', 'https://nais.gov.ua/m/ediniy-reestr-pidpriemstv-schodo-yakih-porusheno-vprovadjennya-u-spravi-pro-bankrutstvo'),
(7, 'arbitration_managers', 'Єдиний реєстр арбітражних керуючих України', 'XML', 'Щодня', 'https://nais.gov.ua/m/ediniy-reestr-arbitrajnih-keruyuchih-ukraini'),
(8, 'legal_acts', 'Єдиний державний реєстр нормативно-правових актів', 'XML', 'Щотижня', 'https://nais.gov.ua/m/ediniy-derjavniy-reestr-normativno-pravovih-aktiv-196'),
(9, 'administrative_units', 'Словник адміністративно-територіального устрою України та словник вулиць', 'XML', 'Щотижня', 'https://nais.gov.ua/m/slovnik-administrativno-teritorialnogo-ustroyu-ukraini-slovnik-vulits-naselenih-punktiv-ta-vulits-imenovanih-obektiv'),
(10, 'enforcement_proceedings', 'Інформація з автоматизованої системи виконавчого провадження', 'CSV', 'Щодня', 'https://nais.gov.ua/m/informatsiya-z-avtomatizovanoi-sistemi-vikonavchogo-provadjennya-595'),
(11, 'debtors', 'Єдиний реєстр боржників', 'CSV', 'Щодня', 'https://nais.gov.ua/m/ediniy-reestr-borjnikiv-549')
ON CONFLICT (registry_id) DO NOTHING;

-- ====================================================================================
-- Helper Functions
-- ====================================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to all main tables
CREATE TRIGGER update_legal_entities_updated_at BEFORE UPDATE ON legal_entities FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_notaries_updated_at BEFORE UPDATE ON notaries FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_court_experts_updated_at BEFORE UPDATE ON court_experts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_special_forms_updated_at BEFORE UPDATE ON special_forms FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_forensic_methods_updated_at BEFORE UPDATE ON forensic_methods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_bankruptcy_cases_updated_at BEFORE UPDATE ON bankruptcy_cases FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_arbitration_managers_updated_at BEFORE UPDATE ON arbitration_managers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_legal_acts_updated_at BEFORE UPDATE ON legal_acts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_administrative_units_updated_at BEFORE UPDATE ON administrative_units FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_streets_updated_at BEFORE UPDATE ON streets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_enforcement_proceedings_updated_at BEFORE UPDATE ON enforcement_proceedings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_debtors_updated_at BEFORE UPDATE ON debtors FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_registry_metadata_updated_at BEFORE UPDATE ON registry_metadata FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
