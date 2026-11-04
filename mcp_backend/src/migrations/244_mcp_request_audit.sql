-- Migration 244: audit trail for MCP access (who called, from where, how much was returned)
--
-- cost_tracking already records user, API key, tool, query and cost per MCP tool call,
-- but not the caller's network identity. Without IP / User-Agent we cannot tell when a
-- client hands their key to someone else, and without response size we cannot see bulk
-- extraction. This adds both, plus a log of session opens and refused authentications,
-- and a daily per-key rollup for the usage report (scripts/mcp-key-usage-report.sh).

ALTER TABLE cost_tracking
  ADD COLUMN IF NOT EXISTS client_ip       INET,
  ADD COLUMN IF NOT EXISTS user_agent      TEXT,
  ADD COLUMN IF NOT EXISTS mcp_session_id  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS mcp_transport   VARCHAR(16),
  ADD COLUMN IF NOT EXISTS response_bytes  INTEGER;

CREATE INDEX IF NOT EXISTS idx_cost_tracking_mcp_session
  ON cost_tracking (mcp_session_id) WHERE mcp_session_id IS NOT NULL;

-- One row per MCP session open (outcome = 'session_opened') and per refused
-- authentication. Tool calls themselves live in cost_tracking.
CREATE TABLE IF NOT EXISTS mcp_access_log (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  transport       VARCHAR(16) NOT NULL,
  outcome         VARCHAR(32) NOT NULL,
  auth_method     VARCHAR(16),
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  api_key_id      UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  key_prefix      VARCHAR(16),
  mcp_session_id  VARCHAR(64),
  client_ip       INET,
  user_agent      TEXT,
  detail          TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_access_log_created ON mcp_access_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_access_log_user ON mcp_access_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_access_log_key ON mcp_access_log (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_access_log_prefix ON mcp_access_log (key_prefix, created_at DESC);

COMMENT ON TABLE mcp_access_log IS
  'MCP session opens and refused authentications, with caller IP and User-Agent (migration 244)';

-- Daily per-key rollup of MCP tool calls. client_key holds the API key itself for key
-- auth and the OAuth client id for OAuth, so the join to api_keys is by value.
CREATE OR REPLACE VIEW mcp_key_usage_daily AS
SELECT
  date_trunc('day', ct.created_at)::date                  AS day,
  ct.user_id,
  u.email,
  ak.id                                                    AS api_key_id,
  COALESCE(ak.name, 'oauth:' || ct.client_key)            AS key_name,
  left(ct.client_key, 8)                                   AS key_prefix,
  count(*)                                                 AS calls,
  count(*) FILTER (WHERE ct.status = 'failed')             AS failed_calls,
  count(DISTINCT ct.client_ip)                             AS distinct_ips,
  count(DISTINCT ct.user_agent)                            AS distinct_user_agents,
  count(DISTINCT ct.mcp_session_id)                        AS sessions,
  count(DISTINCT ct.tool_name)                             AS distinct_tools,
  COALESCE(sum(ct.response_bytes), 0)                      AS response_bytes,
  COALESCE(sum(ct.total_cost_usd), 0)                      AS cost_usd,
  array_agg(DISTINCT host(ct.client_ip)) FILTER (WHERE ct.client_ip IS NOT NULL) AS ips,
  min(ct.created_at)                                       AS first_call,
  max(ct.created_at)                                       AS last_call
FROM cost_tracking ct
LEFT JOIN api_keys ak ON ak.key = ct.client_key
LEFT JOIN users u ON u.id = ct.user_id
WHERE ct.request_id LIKE 'mcp-%'
GROUP BY 1, 2, 3, 4, 5, 6;

COMMENT ON VIEW mcp_key_usage_daily IS
  'Per-day, per-key MCP tool usage: calls, distinct IPs/UAs/sessions, bytes returned, cost (migration 244)';
