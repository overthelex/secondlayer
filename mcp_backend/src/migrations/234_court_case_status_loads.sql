-- LEXAI-2182: the ДСА ZIP of 31.10.2026 had 26 files / 1,301,925 rows instead of 30 /
-- 1,461,483 (Касаційний господарський суд 328 → 0 rows), and the importer swapped it in
-- because its only guard was «≥ 80% of the table's rows». src/scripts/import-court-case-status.ts
-- now records every successful load here and refuses a snapshot with fewer files than the
-- last one (see court-case-status-guards.ts for the per-court checks).
-- Idempotent: CREATE ... IF NOT EXISTS, and the baseline row is inserted only once.

CREATE TABLE IF NOT EXISTS opendata_court_case_status_loads (
  id           SERIAL PRIMARY KEY,
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_name  TEXT,                -- ZIP file name (or directory) the rows came from
  source_date  DATE,                -- snapshot date from «...-vid-DD-MM-YYYY.zip»
  file_count   INTEGER NOT NULL,    -- CSV files read from the snapshot
  total_rows   INTEGER NOT NULL,
  court_counts JSONB NOT NULL,      -- { court_name: rows }
  forced       BOOLEAN NOT NULL DEFAULT false, -- swapped with --force despite failed guards
  note         TEXT                 -- free text, e.g. why a row was seeded by hand
);

-- note was added after the first draft of this migration; keep a table created by it usable.
ALTER TABLE opendata_court_case_status_loads ADD COLUMN IF NOT EXISTS note TEXT;

CREATE INDEX IF NOT EXISTS idx_opendata_court_case_status_loads_loaded_at
  ON opendata_court_case_status_loads (loaded_at DESC);

-- Seeded baseline: the prod table already holds the partial 31.10.2026 load (no
-- Касаційний господарський суд), so without this row the first run after this migration
-- would have neither a file-count baseline nor a per-court one, and could repeat the
-- incident. These are the figures of the last complete export, 30.10.2026 (30 files,
-- 1,461,483 rows); court_counts lists only the five cassation courts counted then, which
-- is enough for the guard because it checks the courts the baseline names.
INSERT INTO opendata_court_case_status_loads
       (loaded_at, source_name, source_date, file_count, total_rows, court_counts, forced, note)
SELECT '2026-10-30 00:00:00+02', 'stan-rozglyadu-sprav-vid-30-10-2026.zip', DATE '2026-10-30', 30, 1461483,
       '{"Касаційний цивільний суд": 794378, "Касаційний кримінальний суд": 304234,
         "Велика Палата Верховного Суду": 30108, "Касаційний господарський суд": 328,
         "Касаційний адміністративний суд": 1147}'::jsonb,
       false, 'seeded baseline (LEXAI-2182): last complete ДСА export before the partial 31.10.2026 load'
 WHERE NOT EXISTS (
   SELECT 1 FROM opendata_court_case_status_loads WHERE note LIKE 'seeded baseline (LEXAI-2182)%'
 );
