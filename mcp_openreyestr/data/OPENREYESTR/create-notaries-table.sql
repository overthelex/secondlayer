-- Create notaries table for NAIS Registry
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
    status VARCHAR(100) DEFAULT 'active',
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_source VARCHAR(255) DEFAULT 'NAIS',
    source_file VARCHAR(500)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_notaries_cert ON notaries(certificate_number);
CREATE INDEX IF NOT EXISTS idx_notaries_region ON notaries(region);
CREATE INDEX IF NOT EXISTS idx_notaries_status ON notaries(status);
CREATE INDEX IF NOT EXISTS idx_notaries_name ON notaries USING gin(to_tsvector('ukrainian', full_name));

-- Create trigger function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS \$\$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
\$\$ language 'plpgsql';

-- Create trigger
DROP TRIGGER IF EXISTS update_notaries_updated_at ON notaries;
CREATE TRIGGER update_notaries_updated_at
BEFORE UPDATE ON notaries
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
