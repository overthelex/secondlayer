-- Migration 229: per-account limits on tool calls (services/mcp-usage-limits.ts).
--
-- api_keys.rate_limit_per_minute was never enforced and rate_limit_per_day was checked only
-- when an MCP session opened, so calls inside a session and all OAuth sessions ran without a
-- limit. These limits are checked on every tool call (MCP /v1/mcp, /v2/mcp, /sse and the
-- REST /api/tools routes) against the user, whatever key, token or session is used.
-- An account without a row here is not limited by this table. NULL in a column = no limit.

CREATE TABLE IF NOT EXISTS mcp_usage_limits (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_concurrent     INTEGER CHECK (max_concurrent IS NULL OR max_concurrent > 0),
  per_minute         INTEGER CHECK (per_minute IS NULL OR per_minute > 0),
  per_hour           INTEGER CHECK (per_hour IS NULL OR per_hour > 0),
  per_day            INTEGER CHECK (per_day IS NULL OR per_day > 0),
  -- Full court-decision texts per UTC day, counted in documents
  -- (get_court_decision, get_case_documents_chain = 1; load_full_texts = number of doc_ids).
  doc_fetch_per_day  INTEGER CHECK (doc_fetch_per_day IS NULL OR doc_fetch_per_day > 0),
  -- Share of a daily quota after which results carry a warning.
  warn_ratio         NUMERIC(3,2) NOT NULL DEFAULT 0.80 CHECK (warn_ratio > 0 AND warn_ratio <= 1),
  notes              TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- mr.Braun test access (KP of 23.10.2026): two people working through agents at the same
-- time, no bulk download. 6 concurrent = 2 people x 3 parallel tool calls of an agent;
-- 60/min and 600/h cover both agents' bursts; 3000 calls and 500 full texts a day make a
-- bulk download of the corpus impractical.
INSERT INTO mcp_usage_limits (user_id, max_concurrent, per_minute, per_hour, per_day, doc_fetch_per_day, notes)
SELECT id, 6, 60, 600, 3000, 500, 'mr.Braun test access, KP 23.10.2026: 2 concurrent users, anti-bulk-download'
  FROM users
 WHERE email = 'mrbraun013@gmail.com'
ON CONFLICT (user_id) DO NOTHING;
