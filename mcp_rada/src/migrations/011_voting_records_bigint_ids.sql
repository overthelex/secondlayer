-- Migration 011: RADA question/event ids do not fit INTEGER (LEXAI-2094)
--
-- id_question is date-based: 2026032620 still fits INTEGER, but from 2021
-- it carries a three-digit suffix (20210519121), past INTEGER's 2147483647,
-- so the 2019-08-29.. backfill stopped at 19.05.2021. Widen both ids.
--
-- Idempotent: migrate.ts re-runs every file on each deploy, so only alter a
-- column that is still INTEGER (the table is small; the rewrite is quick).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'voting_records'
      AND column_name = 'question_number'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE voting_records ALTER COLUMN question_number TYPE BIGINT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'voting_records'
      AND column_name = 'event_id'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE voting_records ALTER COLUMN event_id TYPE BIGINT;
  END IF;
END $$;
