-- attorney_crm: users, sessions, leads and notes. All idempotent.
-- Design: docs/superpowers/specs/2026-11-07-attorney-crm-design.md

CREATE TABLE IF NOT EXISTS attorney_crm_users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- The cookie carries a random token; only its sha256 is stored here.
CREATE TABLE IF NOT EXISTS attorney_crm_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES attorney_crm_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_sessions_expires ON attorney_crm_sessions (expires_at);

-- One row per advocate the team has touched; keyed on opendata_advocates.source_id.
CREATE TABLE IF NOT EXISTS attorney_crm_leads (
  advocate_source_id TEXT PRIMARY KEY,
  stage              TEXT NOT NULL DEFAULT 'new'
                     CHECK (stage IN ('new','contacted','interested','declined','client')),
  next_contact_at    TIMESTAMPTZ,
  assigned_user_id   INTEGER REFERENCES attorney_crm_users(id),
  manual_practices   TEXT[] NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         INTEGER REFERENCES attorney_crm_users(id)
);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_leads_next_contact ON attorney_crm_leads (next_contact_at);

-- Append-only log of calls, letters and meetings.
CREATE TABLE IF NOT EXISTS attorney_crm_notes (
  id                 BIGSERIAL PRIMARY KEY,
  advocate_source_id TEXT NOT NULL,
  user_id            INTEGER NOT NULL REFERENCES attorney_crm_users(id),
  kind               TEXT NOT NULL CHECK (kind IN ('call','email','meeting','other')),
  body               TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_notes_advocate ON attorney_crm_notes (advocate_source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_notes_created ON attorney_crm_notes (created_at DESC);
