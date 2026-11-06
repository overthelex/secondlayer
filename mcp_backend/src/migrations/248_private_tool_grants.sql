-- Private MCP toolsets (mcp_backend/src/api/private-tools): which accounts may see and
-- call which toolset. Grants are inserted by hand on the box, never by a migration,
-- because the repository is public and a grant names a person.
CREATE TABLE IF NOT EXISTS private_tool_grants (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  toolset    TEXT        NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  note       TEXT,
  PRIMARY KEY (user_id, toolset)
);
