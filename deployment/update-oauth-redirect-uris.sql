-- Update OAuth client redirect URIs to include Claude.ai callback
UPDATE oauth_clients
SET redirect_uris = '[
  "https://claude.ai/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/aip/callback",
  "http://localhost:3000/callback"
]'::jsonb
WHERE client_id = 'chatgpt_mcp_client';

-- Verify the update
SELECT
  client_id,
  name,
  redirect_uris,
  created_at
FROM oauth_clients
WHERE client_id = 'chatgpt_mcp_client';
