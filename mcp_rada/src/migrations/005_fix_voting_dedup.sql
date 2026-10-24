-- Migration 005: Fix voting_records duplicates and add dedup constraints
-- Problem: saveVotingRecord uses ON CONFLICT (id) with random UUID, so every
-- re-fetch of the same session date inserts duplicate rows instead of updating.
--
-- The voting_records part of this migration (a ctid DELETE keeping one row per
-- (session_date, question_number) plus a unique index on that pair) was
-- superseded by 010_voting_records_per_event.sql (LEXAI-2094): one question
-- holds several roll-calls, so the key is RADA's id_event. migrate.ts re-runs
-- every file on each deploy, and leaving the DELETE here would wipe all but one
-- roll-call per question every time, so it is gone.

-- Deduplicate deputy_court_mentions — keep the row with the smallest
-- ctid for each (deputy_id, court_case_number, mention_type) triple.
-- Rows where mention_type IS NULL are left as-is.
DELETE FROM deputy_court_mentions
WHERE ctid NOT IN (
  SELECT DISTINCT ON (deputy_id, court_case_number, mention_type) ctid
  FROM deputy_court_mentions
  WHERE mention_type IS NOT NULL
  ORDER BY deputy_id, court_case_number, mention_type, ctid
);

-- Add UNIQUE constraint on (deputy_id, court_case_number, mention_type).
-- Partial index to guard against NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deputy_mentions_unique_key
  ON deputy_court_mentions (deputy_id, court_case_number, mention_type)
  WHERE mention_type IS NOT NULL;
