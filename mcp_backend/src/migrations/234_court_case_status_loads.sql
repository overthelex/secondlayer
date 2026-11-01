-- LEXAI-2182: the ДСА ZIP of 31.10.2026 had 26 files / 1,301,925 rows instead of 30 /
-- 1,461,483 (Касаційний господарський суд 328 → 0 rows), and the importer swapped it in
-- because its only guard was «≥ 80% of the table's rows». src/scripts/import-court-case-status.ts
-- now records every successful load here and refuses a snapshot with fewer files than the
-- last one (see court-case-status-guards.ts for the per-court checks).
-- Idempotent: CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS opendata_court_case_status_loads (
  id           SERIAL PRIMARY KEY,
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_name  TEXT,                -- ZIP file name (or directory) the rows came from
  source_date  DATE,                -- snapshot date from «...-vid-DD-MM-YYYY.zip»
  file_count   INTEGER NOT NULL,    -- CSV files read from the snapshot
  total_rows   INTEGER NOT NULL,
  court_counts JSONB NOT NULL,      -- { court_name: rows }
  forced       BOOLEAN NOT NULL DEFAULT false  -- swapped with --force despite failed guards
);

CREATE INDEX IF NOT EXISTS idx_opendata_court_case_status_loads_loaded_at
  ON opendata_court_case_status_loads (loaded_at DESC);
