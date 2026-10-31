-- 021: single tax payers — ЄДРПОУ leading zeros, truncation flag, registry row (LEXAI-2159).
--
-- The table was loaded once by hand from the DPS 2019 file, where ЄДРПОУ is a
-- number: "05391695" is stored as "5391695", so a lookup by the real code finds
-- nothing. Prod on 2026-11-01: 167,007 rows, 4,291 all-digit tins of 1-7
-- digits; none of them pads to the same value as another row (no collisions).
--
-- This migration:
--   1. left-pads 1-7 digit tins to 8 digits. A row is padded only if no other
--      row normalises to the same 8-digit value, whether that row is already
--      8 digits ("00000123") or another short form ("123" and "0123"); such
--      groups are left as they are for the next reload to collapse;
--   2. builds a UNIQUE NULLS NOT DISTINCT index on tin under a temporary name,
--      the form the TRUNCATE + upsert reload requires (unique-key-load.ts);
--      tin is NOT NULL, so this changes no semantics;
--   3. registers single_tax_payers in registry_metadata (id 13), so the weekly
--      sync records its last import instead of re-importing it every week;
--   4. adds activity_codes_truncated (DPS cuts the activity-code list at ~239
--      characters; the importer sets the flag, NULL means "loaded before"),
--      then drops the old index and renames the new one into its place.
--
-- Locking. The migration runner sends the file as one multi-statement query,
-- i.e. one transaction, so every lock is held until COMMIT.
--   - UPDATE: ROW EXCLUSIVE + row locks; SELECTs keep working.
--   - CREATE INDEX (step 2): SHARE; SELECTs keep working, writes wait. 167K
--     rows, seconds.
--   - ADD COLUMN, DROP INDEX, ALTER INDEX RENAME (step 4): ACCESS EXCLUSIVE,
--     which blocks SELECTs too. They are the last statements and none of them
--     rewrites the table, so the exclusive lock is held only for the
--     catalog changes and the COMMIT.
-- The only writer is the registry importer; do not apply during an import.
--
-- Idempotent: step 1 matches no rows once applied; step 2 and the swap in
-- step 4 are skipped once idx_single_tax_tin has NULLS NOT DISTINCT; step 3 is
-- ON CONFLICT DO NOTHING; ADD COLUMN IF NOT EXISTS.

SET LOCAL statement_timeout = '10min';
SET LOCAL lock_timeout = '1min';

-- 1. Pad short ЄДРПОУ, skipping every group that would collide.
WITH norm AS (
  SELECT id, tin,
         CASE WHEN tin ~ '^[0-9]{1,7}$' THEN lpad(tin, 8, '0') ELSE tin END AS padded
    FROM single_tax_payers
), colliding AS (
  SELECT padded FROM norm GROUP BY padded HAVING count(*) > 1
)
UPDATE single_tax_payers s
   SET tin = n.padded,
       updated_at = CURRENT_TIMESTAMP
  FROM norm n
 WHERE s.id = n.id
   AND n.tin <> n.padded
   AND NOT EXISTS (SELECT 1 FROM colliding c WHERE c.padded = n.padded);

-- 2. New key index under a temporary name, while the old one keeps serving.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'single_tax_payers'
       AND indexname = 'idx_single_tax_tin'
       AND indexdef ~* 'NULLS NOT DISTINCT'
  ) THEN
    DROP INDEX IF EXISTS idx_single_tax_tin_nnd;
    CREATE UNIQUE INDEX idx_single_tax_tin_nnd ON single_tax_payers (tin) NULLS NOT DISTINCT;
  END IF;
END $$;

-- 3. Registry metadata row for the weekly sync.
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

-- 4. ACCESS EXCLUSIVE statements last: new column, index swap.
ALTER TABLE single_tax_payers ADD COLUMN IF NOT EXISTS activity_codes_truncated BOOLEAN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'single_tax_payers' AND indexname = 'idx_single_tax_tin_nnd'
  ) THEN
    DROP INDEX IF EXISTS idx_single_tax_tin;
    ALTER INDEX idx_single_tax_tin_nnd RENAME TO idx_single_tax_tin;
  END IF;
END $$;
