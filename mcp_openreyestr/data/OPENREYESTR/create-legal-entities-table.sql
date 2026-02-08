-- Create legal_entities table for NAIS Registry
-- Єдиний державний реєстр юридичних осіб, фізичних осіб-підприємців та громадських формувань

CREATE TABLE IF NOT EXISTS legal_entities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    edrpou VARCHAR(10) UNIQUE NOT NULL, -- ЄДРПОУ код
    full_name TEXT NOT NULL,
    short_name TEXT,
    legal_form VARCHAR(255), -- Organizational form (ТОВ, ПП, ПАТ, etc.)
    status VARCHAR(100), -- Active/inactive/liquidated/bankruptcy
    registration_date DATE,
    termination_date DATE,
    address TEXT, -- Legal address
    region VARCHAR(255), -- Administrative region
    activity_type VARCHAR(500), -- KVED activity codes
    authorized_capital NUMERIC, -- Authorized capital amount
    founders JSONB, -- Structured founder data (array)
    management JSONB, -- Management persons (array)
    raw_data JSONB, -- Complete XML data
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_legal_entities_edrpou ON legal_entities(edrpou);
CREATE INDEX IF NOT EXISTS idx_legal_entities_status ON legal_entities(status);
CREATE INDEX IF NOT EXISTS idx_legal_entities_region ON legal_entities(region);
CREATE INDEX IF NOT EXISTS idx_legal_entities_legal_form ON legal_entities(legal_form);
CREATE INDEX IF NOT EXISTS idx_legal_entities_registration_date ON legal_entities(registration_date);

-- Full-text search index on company name
CREATE INDEX IF NOT EXISTS idx_legal_entities_name ON legal_entities
USING gin(to_tsvector('simple', full_name));

-- JSONB indexes for founders and management
CREATE INDEX IF NOT EXISTS idx_legal_entities_founders ON legal_entities USING gin(founders);
CREATE INDEX IF NOT EXISTS idx_legal_entities_management ON legal_entities USING gin(management);

-- Create trigger function for updated_at if not exists
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger
DROP TRIGGER IF EXISTS update_legal_entities_updated_at ON legal_entities;
CREATE TRIGGER update_legal_entities_updated_at
BEFORE UPDATE ON legal_entities
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Show table structure
\d legal_entities
