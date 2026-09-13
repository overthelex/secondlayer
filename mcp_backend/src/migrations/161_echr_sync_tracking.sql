-- ECHR sync tracking: log table for synchronization runs + performance indexes on echr_cases

-- 1. Sync log table
CREATE TABLE IF NOT EXISTS echr_sync_log (
  id SERIAL PRIMARY KEY,
  country_code VARCHAR(3) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  new_records INT DEFAULT 0,
  updated_records INT DEFAULT 0,
  texts_downloaded INT DEFAULT 0,
  errors INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'running',
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_echr_sync_log_country ON echr_sync_log(country_code);
CREATE INDEX IF NOT EXISTS idx_echr_sync_log_status ON echr_sync_log(status);

-- 2. Performance indexes on echr_cases. The table was created outside the
-- runner (scripts/hudoc/import-echr-to-pg.ts); on a fresh database it does
-- not exist yet -- migration 215 creates it, with these indexes -- so the
-- statements are guarded rather than left to abort the whole chain.
DO $$
BEGIN
  IF to_regclass('public.echr_cases') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_echr_cases_respondent ON echr_cases(respondent);
    CREATE INDEX IF NOT EXISTS idx_echr_cases_kp_date ON echr_cases(kp_date);
  END IF;
END $$;
