-- 020: UNIQUE natural key on debtors (LEXAI-2130).
--
-- Migration 004 declared UNIQUE (proceeding_number, debtor_name, debtor_edrpou),
-- but prod debtors has no such constraint: the TRUNCATE+INSERT reload drops all
-- indexes, inserts the file as is and recreates them, and the ЄРБ file carries
-- exact duplicate rows, so the UNIQUE recreate fails and the table is left
-- without it. Prod on 2026-10-29: 10,550,506 rows, 87 duplicate key groups,
-- 90 surplus rows (every group is a byte-identical copy of the same row).
--
-- This migration:
--   1. deletes duplicate rows, keeping the lowest id per key;
--   2. creates a UNIQUE NULLS NOT DISTINCT index on the key (PostgreSQL 15+);
--   3. drops the 004 constraint where it still exists (NULLs distinct, so it
--      cannot dedupe individuals, whose debtor_edrpou is NULL).
-- Legacy "gen_<n>" values in debtor_edrpou are left as they are: rewriting
-- ~9.7M rows here would bloat the table, and the next TRUNCATE reload replaces
-- them with NULL anyway. Run the debtors import right after this migration.
-- The importer (RegistryConfig.upsertOnReload) keeps this index during the
-- reload, upserts with ON CONFLICT (proceeding_number, debtor_name,
-- debtor_edrpou), and refuses to TRUNCATE if the index is missing.
--
-- Locking. The migration runner sends the file as one multi-statement query,
-- i.e. one transaction, so every lock below is held until COMMIT, and
-- CREATE INDEX CONCURRENTLY is not possible here.
--   - DELETE: ROW EXCLUSIVE + row locks; SELECTs keep working.
--   - CREATE INDEX: SHARE; SELECTs keep working, writes wait.
--   - DROP CONSTRAINT: ACCESS EXCLUSIVE, blocks SELECTs too. It is the last
--     statement, so it is held only from the drop to COMMIT; and it is a no-op
--     on prod, where the constraint is already gone.
-- Writes are blocked for the whole migration; the only writer is the daily
-- importer. Do not apply while a debtors import is running.
--
-- Idempotent: steps 1-2 are skipped once the index exists; step 3 is guarded.

SET LOCAL statement_timeout = '120min';
SET LOCAL lock_timeout = '5min';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'debtors'
      AND indexname = 'debtors_natural_key_uniq'
  ) THEN
    -- 1. Dedupe on the natural key; PARTITION BY treats NULLs as equal, as the
    --    NULLS NOT DISTINCT index will.
    DELETE FROM debtors d
    USING (
      SELECT id
      FROM (
        SELECT id,
               row_number() OVER (
                 PARTITION BY proceeding_number, debtor_name, debtor_edrpou
                 ORDER BY id
               ) AS rn
        FROM debtors
      ) ranked
      WHERE rn > 1
    ) dup
    WHERE d.id = dup.id;

    -- 2. The key index, built while the old constraint (if any) still stands.
    CREATE UNIQUE INDEX IF NOT EXISTS debtors_natural_key_uniq
      ON debtors (proceeding_number, debtor_name, debtor_edrpou) NULLS NOT DISTINCT;
  ELSE
    RAISE NOTICE 'debtors_natural_key_uniq already exists, skipping dedupe and index build';
  END IF;

  -- 3. Legacy 004 constraint (default name), last: its ACCESS EXCLUSIVE lock
  --    is held only until COMMIT.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'debtors'::regclass
      AND conname = 'debtors_proceeding_number_debtor_name_debtor_edrpou_key'
  ) THEN
    ALTER TABLE debtors DROP CONSTRAINT debtors_proceeding_number_debtor_name_debtor_edrpou_key;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'debtors table does not exist, skipping';
END $$;
