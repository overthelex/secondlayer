-- Migration 278: accumulating history of the ДСА "Інформація щодо стану розгляду справ" open dataset.
--
-- data.gov.ua dataset 0ad60ea9-b029-456d-abc0-8c77a99b205c is republished daily as ONE zip that holds
-- only the latest ~1.5M stage events (export is capped at 30 x 50,000 rows). Older events fall out of
-- each new snapshot, and opendata_court_case_status is replaced wholesale on import, so history is lost.
-- This table keeps every event ever seen; the daily loader upserts into it and bumps last_seen.
--
-- One row = one stage event of one case in one court. participants holds the parties with full names
-- (filled mainly for civil and administrative-offence cases; "-" in criminal ones, stored as NULL).
-- Used by search_case_status_by_party / get_case_status_details.

CREATE TABLE IF NOT EXISTS court_case_status_history (
  id                BIGSERIAL PRIMARY KEY,
  event_key         TEXT NOT NULL,          -- md5(court|case|proc|stage_date|stage_name|type|cause_result)
  court_name        TEXT NOT NULL,
  case_number       TEXT NOT NULL,
  case_proc         TEXT,
  registration_date DATE,
  judge             TEXT,
  judges            TEXT,
  participants      TEXT,
  stage_date        DATE,
  stage_name        TEXT,
  cause_result      TEXT,
  cause_dep         TEXT,
  case_type         TEXT,
  description       TEXT,
  first_seen        DATE NOT NULL,
  last_seen         DATE NOT NULL,
  source_snapshot   TEXT                    -- e.g. stan-rozglyadu-sprav-vid-17-11-2026.zip
)
-- Every daily load rewrites last_seen of all ~1.5M events in the snapshot; free space on each page
-- lets those updates stay HOT (no indexed column changes) instead of growing every index daily.
WITH (fillfactor = 85);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ccsh_event_key ON court_case_status_history (event_key);

CREATE INDEX IF NOT EXISTS idx_ccsh_case_norm
  ON court_case_status_history (lower(regexp_replace(case_number, '\s+', '', 'g')) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_ccsh_court ON court_case_status_history (court_name);

CREATE INDEX IF NOT EXISTS idx_ccsh_registration ON court_case_status_history (registration_date);

CREATE INDEX IF NOT EXISTS idx_ccsh_participants_fts
  ON court_case_status_history USING gin (to_tsvector('simple', participants))
  WHERE participants IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ccsh_participants_trgm
  ON court_case_status_history USING gin (participants gin_trgm_ops)
  WHERE participants IS NOT NULL;

-- Loader bookkeeping: one row per processed snapshot, so a rerun of the same zip is a no-op.
CREATE TABLE IF NOT EXISTS court_case_status_snapshots (
  snapshot_name   TEXT PRIMARY KEY,
  resource_url    TEXT,
  resource_modified TIMESTAMPTZ,
  rows_read       BIGINT,
  rows_inserted   BIGINT,
  rows_updated    BIGINT,
  loaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pricing: same level as search_court_case_status / search_court_hearing_schedule searches.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('search_case_status_by_party', 'backend', 'Пошук справ за стороною', 0.02409639, 0,
   'Стан розгляду справ ДСА (накопичена історія) + розклад засідань, пошук за стороною', 'migration_278'),
  ('get_case_status_details', 'backend', 'Картка справи: стадії розгляду', 0.02409639, 0,
   'Усі стадії, сторони, засідання та рішення у справі за номером', 'migration_278')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
