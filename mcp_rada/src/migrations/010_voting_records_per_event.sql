-- Migration 010: one voting_records row per roll-call (LEXAI-2094)
--
-- A plenary "question" in data.rada.gov.ua/ogd/zal/ppz carries several
-- roll-calls (each amendment, first reading, as a whole), each with its own
-- id_event and per-deputy result_by_name. Keying rows on
-- (session_date, question_number) kept only the last roll-call of each
-- question. The key is now event_id; rows for questions without any
-- roll-call keep the old pair as their key.
--
-- Idempotent: migrate.ts re-runs every file on each deploy.

ALTER TABLE voting_records ADD COLUMN IF NOT EXISTS event_id INTEGER;

-- Existing roll-call rows already carry their id_event in metadata.
UPDATE voting_records
SET event_id = (metadata -> 'event' -> 'result_event' -> 0 ->> 'id_event')::int
WHERE event_id IS NULL
  AND (metadata -> 'event' -> 'result_event' -> 0 ->> 'id_event') ~ '^[0-9]+$';

DROP INDEX IF EXISTS idx_voting_records_natural_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_voting_records_event_id
  ON voting_records (event_id)
  WHERE event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_voting_records_question_key
  ON voting_records (session_date, question_number)
  WHERE question_number IS NOT NULL AND event_id IS NULL;

-- analyze_voting_record filters on `votes ? '<rada_id>'`
CREATE INDEX IF NOT EXISTS idx_voting_records_votes
  ON voting_records USING gin (votes);
