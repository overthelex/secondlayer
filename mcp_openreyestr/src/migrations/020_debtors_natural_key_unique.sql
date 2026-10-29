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
--   1. drops the 004 constraint where it still exists (NULLs distinct, so it
--      cannot dedupe individuals, whose debtor_edrpou is NULL since LEXAI-2120);
--   2. deletes duplicate rows, keeping the lowest id per key, with legacy
--      "gen_<n>" surrogates counted as NULL;
--   3. creates a UNIQUE NULLS NOT DISTINCT index on the key (PostgreSQL 15+).
-- The importer (RegistryConfig.upsertOnReload) keeps this index during the
-- reload and upserts with ON CONFLICT (proceeding_number, debtor_name,
-- debtor_edrpou), and refuses to TRUNCATE if the index is missing.
--
-- Not CONCURRENTLY: the migration runner sends each file as one multi-statement
-- query, which runs in a transaction block where CREATE INDEX CONCURRENTLY is
-- not allowed. A plain CREATE INDEX takes a SHARE lock: SELECTs from the API
-- keep working, only writes wait, and the only writer is the daily importer
-- (which itself rebuilds every debtors index non-concurrently on each run).
-- Do not apply while a debtors import is running.
--
-- Idempotent: every step is skipped once the index exists.

SET LOCAL statement_timeout = '60min';
SET LOCAL lock_timeout = '5min';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'debtors'
      AND indexname = 'debtors_natural_key_uniq'
  ) THEN
    RAISE NOTICE 'debtors_natural_key_uniq already exists, skipping';
    RETURN;
  END IF;

  -- 1. Legacy 004 constraint (default name), if a past reload did not lose it.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'debtors'::regclass
      AND conname = 'debtors_proceeding_number_debtor_name_debtor_edrpou_key'
  ) THEN
    ALTER TABLE debtors DROP CONSTRAINT debtors_proceeding_number_debtor_name_debtor_edrpou_key;
  END IF;

  -- 2. Dedupe on the natural key; NULLs (and gen_<n> surrogates) compare equal,
  --    as they will in the NULLS NOT DISTINCT index.
  DELETE FROM debtors d
  USING (
    SELECT id
    FROM (
      SELECT id,
             row_number() OVER (
               PARTITION BY proceeding_number,
                            debtor_name,
                            CASE WHEN debtor_edrpou ~ '^gen_[0-9]+$' THEN NULL ELSE debtor_edrpou END
               ORDER BY id
             ) AS rn
      FROM debtors
    ) ranked
    WHERE rn > 1
  ) dup
  WHERE d.id = dup.id;

  -- 3. The key index. Distinct gen_<n> values that survive step 2 cannot
  --    collide: rows equal on the raw key are equal on the normalized one.
  CREATE UNIQUE INDEX IF NOT EXISTS debtors_natural_key_uniq
    ON debtors (proceeding_number, debtor_name, debtor_edrpou) NULLS NOT DISTINCT;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'debtors table does not exist, skipping';
END $$;
