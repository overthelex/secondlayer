-- 022: enforcement_proceedings (АСВП) natural key + implausible opening dates
-- (LEXAI-2144, LEXAI-2163).
--
-- LEXAI-2144. Migration 004 declared proceeding_number UNIQUE, but prod has no
-- unique constraint: the TRUNCATE+INSERT reload drops every index, inserts the
-- file as is and recreates the indexes, and a recreate that fails leaves the
-- table without it. VP_ORDERNUM is the natural key: the source file of
-- 2026-10-29 has 30,758,084 rows, all with distinct non-empty VP_ORDERNUM, and
-- prod on 2026-11-01 has 30,758,083 rows with 0 duplicate proceeding_number.
-- The dedupe below is therefore a no-op on prod today; it stays for databases
-- loaded from older files.
--
-- LEXAI-2163. The source carries mistyped VP_BEGINDATE values
-- ("21.12.2209", "25.05.5005", "29.07.8209", ...). Prod on 2026-11-01: 89 rows
-- dated after today and 3 before 1990 (min 1958-11-06, max 9008-10-01). They
-- sorted first in search_enforcement_proceedings. The importer now drops such
-- dates (utils/enforcement.ts parseOpeningDate); this nulls the stored ones.
--
-- This migration:
--   1. nulls opening_date outside [1990-01-01, today + 1 day] (~92 rows);
--   2. deletes duplicate proceeding_number rows, keeping the lowest id;
--   3. creates UNIQUE NULLS NOT DISTINCT index on (proceeding_number), the
--      form the importer requires for upsertOnReload (proceeding_number is
--      NOT NULL, so NULLS NOT DISTINCT changes nothing else);
--   4. drops the 004 constraint where it still exists and the plain
--      idx_enforce_number index, both redundant with the new index.
-- Run the enforcement_proceedings import after this migration.
--
-- Locking. The migration runner sends the file as one multi-statement query,
-- i.e. one transaction, so locks are held until COMMIT and CREATE INDEX
-- CONCURRENTLY is not possible.
--   - UPDATE/DELETE: ROW EXCLUSIVE + row locks; SELECTs keep working.
--   - CREATE INDEX: SHARE; SELECTs keep working, writes wait (30.8M rows).
--   - DROP CONSTRAINT / DROP INDEX: ACCESS EXCLUSIVE, last, held only until
--     COMMIT.
-- Do not apply while an enforcement_proceedings import is running.
--
-- Idempotent: step 1 touches nothing on a rerun, steps 2-3 are skipped once
-- the index exists, step 4 is guarded.

SET LOCAL statement_timeout = '120min';
SET LOCAL lock_timeout = '5min';

DO $$
BEGIN
  -- 1. Implausible opening dates (uses idx_enforce_date).
  UPDATE enforcement_proceedings
     SET opening_date = NULL
   WHERE opening_date < DATE '1990-01-01'
      OR opening_date > CURRENT_DATE + 1;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'enforcement_proceedings'
      AND indexname = 'enforcement_proceedings_number_uniq'
  ) THEN
    -- 2. Dedupe on the natural key.
    DELETE FROM enforcement_proceedings e
    USING (
      SELECT id
      FROM (
        SELECT id,
               row_number() OVER (PARTITION BY proceeding_number ORDER BY id) AS rn
        FROM enforcement_proceedings
      ) ranked
      WHERE rn > 1
    ) dup
    WHERE e.id = dup.id;

    -- 3. The key index.
    CREATE UNIQUE INDEX IF NOT EXISTS enforcement_proceedings_number_uniq
      ON enforcement_proceedings (proceeding_number) NULLS NOT DISTINCT;
  ELSE
    RAISE NOTICE 'enforcement_proceedings_number_uniq already exists, skipping dedupe and index build';
  END IF;

  -- 4. Legacy 004 constraint (default name) and the plain number index, last.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'enforcement_proceedings'::regclass
      AND conname = 'enforcement_proceedings_proceeding_number_key'
  ) THEN
    ALTER TABLE enforcement_proceedings DROP CONSTRAINT enforcement_proceedings_proceeding_number_key;
  END IF;
  DROP INDEX IF EXISTS idx_enforce_number;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'enforcement_proceedings table does not exist, skipping';
END $$;
