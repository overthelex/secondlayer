-- Drop and recreate full-text search index with 'simple' config
DROP INDEX IF EXISTS idx_notaries_name;
CREATE INDEX idx_notaries_name ON notaries USING gin(to_tsvector('simple', full_name));

-- Create trigger function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger
DROP TRIGGER IF EXISTS update_notaries_updated_at ON notaries;
CREATE TRIGGER update_notaries_updated_at
BEFORE UPDATE ON notaries
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
