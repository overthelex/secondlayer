-- 021: single tax payers — ЄДРПОУ leading zeros, truncation flag, registry row (LEXAI-2159).
--
-- The table was loaded once by hand from the DPS 2019 file, where ЄДРПОУ is a
-- number: "05391695" is stored as "5391695", so a lookup by the real code finds
-- nothing. Prod on 2026-10-31: 167,007 rows, 4,307 with a 5-7 digit tin, none of
-- which collides with an existing 8-digit tin.
--
-- This migration:
--   1. adds activity_codes_truncated (DPS cuts the activity-code list at ~239
--      characters; the importer sets the flag, NULL means "loaded before");
--   2. left-pads 1-7 digit tins to 8 digits, skipping any that would collide;
--   3. rebuilds the tin index as UNIQUE NULLS NOT DISTINCT, the form the
--      TRUNCATE + upsert reload requires;
--   4. registers single_tax_payers in registry_metadata (id 13), so the weekly
--      sync records its last import instead of re-importing it every week.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; step 2 matches no rows once applied;
-- step 3 is skipped once the index has NULLS NOT DISTINCT; step 4 is
-- ON CONFLICT DO NOTHING.

SET LOCAL statement_timeout = '10min';
SET LOCAL lock_timeout = '1min';

ALTER TABLE single_tax_payers ADD COLUMN IF NOT EXISTS activity_codes_truncated BOOLEAN;

UPDATE single_tax_payers s
   SET tin = lpad(s.tin, 8, '0'),
       updated_at = CURRENT_TIMESTAMP
 WHERE s.tin ~ '^[0-9]{1,7}$'
   AND NOT EXISTS (
     SELECT 1 FROM single_tax_payers o WHERE o.tin = lpad(s.tin, 8, '0')
   );

-- The importer reloads with TRUNCATE + ON CONFLICT (tin) and keeps only a
-- UNIQUE NULLS NOT DISTINCT index on the key (unique-key-load.ts); it refuses
-- to TRUNCATE without one. tin is NOT NULL, so this changes no semantics.
-- 167K rows: the rebuild takes seconds under a SHARE lock (reads keep working).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'single_tax_payers'
       AND indexname = 'idx_single_tax_tin'
       AND indexdef ~* 'NULLS NOT DISTINCT'
  ) THEN
    DROP INDEX IF EXISTS idx_single_tax_tin;
    CREATE UNIQUE INDEX idx_single_tax_tin ON single_tax_payers (tin) NULLS NOT DISTINCT;
  END IF;
END $$;

INSERT INTO registry_metadata (registry_id, registry_name, registry_title, data_format, update_frequency, dataset_url, active)
VALUES (
  13,
  'single_tax_payers',
  'Реєстр платників єдиного податку (ДПС)',
  'CSV',
  'Weekly',
  'https://data.gov.ua/dataset/559bbd39-e820-41f9-b779-dad7320e2c7b',
  true
)
ON CONFLICT (registry_id) DO NOTHING;
