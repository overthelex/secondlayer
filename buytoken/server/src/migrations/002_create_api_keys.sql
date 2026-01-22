-- Migration: Create api_keys table
-- Description: User API keys for programmatic access to MCP backend

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL, -- BCrypt hash of the actual key
    key_prefix VARCHAR(20) NOT NULL, -- First 8-12 chars for display (e.g., "sk_live_abcd1234...")
    name VARCHAR(255) NOT NULL, -- User-defined label for the key
    last_used_at TIMESTAMP,
    revoked_at TIMESTAMP, -- Nullable, set when key is revoked
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_key_prefix ON api_keys(key_prefix);
CREATE INDEX idx_api_keys_revoked ON api_keys(revoked_at) WHERE revoked_at IS NULL; -- Active keys only

COMMENT ON TABLE api_keys IS 'User API keys for programmatic access (replaces static SECONDARY_LAYER_KEYS)';
COMMENT ON COLUMN api_keys.key_hash IS 'BCrypt hash of the full API key (never store plaintext)';
COMMENT ON COLUMN api_keys.key_prefix IS 'First portion of key for display purposes (e.g., sk_live_abcd1234)';
COMMENT ON COLUMN api_keys.name IS 'User-friendly label (e.g., "Production Server", "Local Development")';
COMMENT ON COLUMN api_keys.revoked_at IS 'When the key was revoked (NULL = active)';
