-- Migration 197: record the licence each UK judgment arrived under
--
-- The UK corpus mixes two licences and the product has to be able to tell them
-- apart before it exposes anything:
--
--   OGL-v3.0      legislation.gov.uk. Open Government Licence v3.0, commercial
--                 use permitted with attribution, no separate agreement needed.
--                 Verified 2026-08-22 before the harvest.
--   open-justice  Find Case Law (The National Archives). The Open Justice
--                 Licence covers reading and citing; bulk computational use of
--                 the judgments needs a separate licence from TNA, which is
--                 still outstanding (UKENT-15).
--
-- Every one of the 54,453 rows currently in uk_court_decisions came from Find
-- Case Law (source = 'tna' on 100% of rows, measured), so they are all
-- 'open-justice'. The column exists so that (a) a search result can state its
-- own licence rather than leaving a reader to guess, and (b) an OGL-clean
-- subset can be selected with a predicate the day other sources land, without
-- another migration.
-- ⚠ The backfill below is slow and looks stuck: it rewrites all 54,453 rows of a
-- 2 GB table, and every rewritten row re-enters idx_uk_court_fts, a 705 MB GIN
-- index over the concatenated judgment text. Measured on prod 2026-08-25 at
-- roughly five minutes, emitting "word is too long to be indexed" notices
-- throughout, which are harmless. Do not interrupt it.
ALTER TABLE uk_court_decisions
    ADD COLUMN IF NOT EXISTS licence TEXT;

UPDATE uk_court_decisions
   SET licence = CASE WHEN source = 'tna' THEN 'open-justice' ELSE 'unknown' END
 WHERE licence IS NULL;

-- 'unknown' and not 'open-justice'. Defaulting to a named licence would stamp
-- that licence onto rows from a source that has not been checked yet -- BAILII,
-- Scotland, Northern Ireland -- and a licence filter would then be confidently
-- wrong in the direction that matters. An importer that knows its licence sets
-- it explicitly; anything that does not is flagged as unclassified.
ALTER TABLE uk_court_decisions
    ALTER COLUMN licence SET DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_uk_court_licence ON uk_court_decisions (licence);
