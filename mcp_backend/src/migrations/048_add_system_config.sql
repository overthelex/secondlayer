-- Migration 048: System Configuration Table
-- Stores runtime configuration overrides (DB > env > default)

CREATE TABLE IF NOT EXISTS system_config (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  description TEXT,
  is_secret BOOLEAN DEFAULT false,
  value_type VARCHAR(20) DEFAULT 'string',
  default_value TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_config_category ON system_config(category);

DROP TRIGGER IF EXISTS update_system_config_updated_at ON system_config;
CREATE TRIGGER update_system_config_updated_at
  BEFORE UPDATE ON system_config
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
