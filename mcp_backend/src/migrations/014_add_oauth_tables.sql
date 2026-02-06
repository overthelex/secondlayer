-- Migration 014: Add OAuth 2.0 Tables for ChatGPT Integration
-- Creates tables for OAuth clients, authorization codes, and access tokens

-- 1. Create oauth_clients table
CREATE TABLE IF NOT EXISTS oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id VARCHAR(255) UNIQUE NOT NULL,
  client_secret VARCHAR(255) NOT NULL,
  redirect_uris JSONB NOT NULL, -- Array of allowed redirect URIs
  name VARCHAR(255) NOT NULL, -- Client application name
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);

COMMENT ON TABLE oauth_clients IS 'OAuth 2.0 registered clients (e.g., ChatGPT)';
COMMENT ON COLUMN oauth_clients.client_id IS 'Unique client identifier';
COMMENT ON COLUMN oauth_clients.client_secret IS 'Client secret for authentication';
COMMENT ON COLUMN oauth_clients.redirect_uris IS 'Array of allowed redirect URIs';

-- 2. Create oauth_authorization_codes table
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(255) UNIQUE NOT NULL,
  client_id VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scope VARCHAR(255) DEFAULT 'mcp' NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT false NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_code ON oauth_authorization_codes(code);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client_id ON oauth_authorization_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_user_id ON oauth_authorization_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires_at ON oauth_authorization_codes(expires_at);

COMMENT ON TABLE oauth_authorization_codes IS 'Temporary authorization codes for OAuth flow';
COMMENT ON COLUMN oauth_authorization_codes.code IS 'Authorization code (short-lived)';
COMMENT ON COLUMN oauth_authorization_codes.expires_at IS 'Code expiration time (typically 10 minutes)';
COMMENT ON COLUMN oauth_authorization_codes.used IS 'Whether code has been exchanged for token';

-- 3. Create oauth_access_tokens table
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token VARCHAR(255) UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope VARCHAR(255) DEFAULT 'mcp' NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access_token ON oauth_access_tokens(access_token);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client_id ON oauth_access_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires_at ON oauth_access_tokens(expires_at);

COMMENT ON TABLE oauth_access_tokens IS 'OAuth 2.0 access tokens for API authentication';
COMMENT ON COLUMN oauth_access_tokens.access_token IS 'Bearer token for API requests';
COMMENT ON COLUMN oauth_access_tokens.expires_at IS 'Token expiration time (typically 30 days)';
COMMENT ON COLUMN oauth_access_tokens.scope IS 'Granted permissions';

-- 4. Add password_hash column to users table (if not exists)
-- This allows users to authenticate with email/password for OAuth flow
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

COMMENT ON COLUMN users.password_hash IS 'Hashed password for OAuth authentication (optional, can use Google OAuth instead)';

-- 5. Create default ChatGPT OAuth client
-- This client is pre-registered for ChatGPT integration
INSERT INTO oauth_clients (client_id, client_secret, redirect_uris, name)
VALUES (
  'chatgpt_mcp_client',
  'REDACTED_OAUTH_CLIENT_SECRET',
  '["https://chatgpt.com/aip/callback", "http://localhost:3000/callback"]',
  'ChatGPT MCP Client'
)
ON CONFLICT (client_id) DO NOTHING;

-- 6. Create cleanup function for expired data
CREATE OR REPLACE FUNCTION cleanup_expired_oauth_data()
RETURNS void AS $$
BEGIN
  -- Delete expired authorization codes
  DELETE FROM oauth_authorization_codes WHERE expires_at < NOW();

  -- Delete expired access tokens
  DELETE FROM oauth_access_tokens WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_expired_oauth_data IS 'Cleanup expired OAuth codes and tokens (should be run periodically)';

-- 7. Grant permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_clients TO secondlayer_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_authorization_codes TO secondlayer_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_access_tokens TO secondlayer_app;
