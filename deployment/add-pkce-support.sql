-- Add PKCE support to OAuth authorization codes
-- PKCE (Proof Key for Code Exchange) is required for Claude.ai Custom Connector

ALTER TABLE oauth_authorization_codes
ADD COLUMN IF NOT EXISTS code_challenge VARCHAR(255),
ADD COLUMN IF NOT EXISTS code_challenge_method VARCHAR(10);

COMMENT ON COLUMN oauth_authorization_codes.code_challenge IS 'PKCE code challenge (base64url-encoded SHA256 of code_verifier)';
COMMENT ON COLUMN oauth_authorization_codes.code_challenge_method IS 'PKCE challenge method (S256 or plain)';

-- Verify the changes
\d oauth_authorization_codes
