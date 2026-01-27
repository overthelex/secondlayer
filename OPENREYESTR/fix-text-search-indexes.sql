-- Fix Full-Text Search Indexes
-- Replace Ukrainian config with Russian config

-- Drop failed index attempts (if they exist)
DROP INDEX IF EXISTS idx_legal_entities_name;
DROP INDEX IF EXISTS idx_notaries_name;
DROP INDEX IF EXISTS idx_court_experts_name;
DROP INDEX IF EXISTS idx_forensic_methods_name;
DROP INDEX IF EXISTS idx_bankruptcy_debtor;
DROP INDEX IF EXISTS idx_arb_managers_name;
DROP INDEX IF EXISTS idx_legal_acts_title;
DROP INDEX IF EXISTS idx_legal_acts_text;
DROP INDEX IF EXISTS idx_admin_units_name;
DROP INDEX IF EXISTS idx_streets_name;
DROP INDEX IF EXISTS idx_enforcement_debtor;
DROP INDEX IF EXISTS idx_debtors_name;

-- Recreate indexes with Russian text search configuration
CREATE INDEX idx_legal_entities_name ON legal_entities USING gin(to_tsvector('russian', full_name));
CREATE INDEX idx_notaries_name ON notaries USING gin(to_tsvector('russian', full_name));
CREATE INDEX idx_court_experts_name ON court_experts USING gin(to_tsvector('russian', full_name));
CREATE INDEX idx_forensic_methods_name ON forensic_methods USING gin(to_tsvector('russian', method_name));
CREATE INDEX idx_bankruptcy_debtor ON bankruptcy_cases USING gin(to_tsvector('russian', debtor_name));
CREATE INDEX idx_arb_managers_name ON arbitration_managers USING gin(to_tsvector('russian', full_name));
CREATE INDEX idx_legal_acts_title ON legal_acts USING gin(to_tsvector('russian', act_title));
CREATE INDEX idx_legal_acts_text ON legal_acts USING gin(to_tsvector('russian', act_text));
CREATE INDEX idx_admin_units_name ON administrative_units USING gin(to_tsvector('russian', settlement_name));
CREATE INDEX idx_streets_name ON streets USING gin(to_tsvector('russian', street_name));
CREATE INDEX idx_enforcement_debtor ON enforcement_proceedings USING gin(to_tsvector('russian', debtor_name));
CREATE INDEX idx_debtors_name ON debtors USING gin(to_tsvector('russian', debtor_name));

-- Update default text search config for the database
ALTER DATABASE opendata_db SET default_text_search_config = 'pg_catalog.russian';

-- Success message
SELECT 'All text search indexes recreated successfully with Russian configuration!' AS status;
