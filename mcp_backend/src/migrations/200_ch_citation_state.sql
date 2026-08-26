-- mcp_backend/src/migrations/200_ch_citation_state.sql
-- Move the citation stage's per-decision bookkeeping OFF ch_court_decisions
-- and into a narrow side table.
--
-- Why (measured on prod, 2026-08-25). Migration 199 put the bookkeeping on
-- the decisions table itself: ch_court_decisions.citations_extracted_at,
-- with a partial index (idx_ch_court_cit_queue) whose predicate names that
-- column. ch_court_decisions is 19 GB with a 7.6 GB full-text GIN on top of
-- it. A column inside an index predicate cannot be updated HOT, so every
-- single stamp and every single unstamp is a full row rewrite that
-- re-inserts the (large) row into EVERY index on the table, the GIN
-- included. Two consequences, both observed:
--
--   * a bulk unstamp of 1.22M rows (the reset for a full re-extraction) ran
--     for 22+ minutes, on a table the live product reads;
--   * the full-text GIN grew 0.6 GB in a day of that churn -- index bloat
--     bought with nothing but a timestamp that has no business living
--     next to the text.
--
-- ch_citation_state is ~40 bytes a row, has one small partial index and no
-- GIN, so the same reset is a seconds-long UPDATE over a table nothing else
-- reads, and a stamp is one narrow HOT update. The citation stages stop
-- writing to ch_court_decisions altogether: they only ever read it (the
-- claim joins it for stage/spider/full_text).
--
-- SET lock_timeout = '3s' is the first statement for the same reason as in
-- 199: the runner applies a whole file as one implicit transaction, so if
-- something here has to wait on ch_court_decisions (the seed's SELECT takes
-- an ACCESS SHARE lock) this file must fail fast and be retried in a quiet
-- window rather than sit in the lock queue holding up everything behind it.
-- The SET is session-local and lasts only for the applying session.
--
-- The seed copies the EXISTING stamps rather than starting everything at
-- NULL: the corpus has already been extracted once, and seeding NULLs would
-- silently enqueue 1.22M decisions for a multi-hour re-extraction the first
-- time the nightly delta ran. It is wrapped in an emptiness guard, so a
-- second application of this file inserts nothing at all -- by then the
-- table is the live queue, and re-running an ON CONFLICT DO NOTHING seed
-- against it would resurrect state rows for decisions the pipeline has since
-- retired, and re-stamp from a column nothing writes any more.
--
-- ch_court_decisions.citations_extracted_at is deliberately LEFT IN PLACE.
-- Nothing reads or writes it after this migration (chpipe/db.py, the
-- citation stages and chpipe/reports_cit.py all move to ch_citation_state),
-- but dropping a column on a 19 GB table takes an ACCESS EXCLUSIVE lock and
-- there is no hurry: it is the only remaining copy of the pre-migration
-- stamps, which is exactly what a rollback would need. A later migration may
-- drop it once this table has been the source of truth for a while. Its
-- partial index goes now, though -- idx_ch_court_cit_queue exists ONLY to
-- serve the claim query this migration retires, and while it exists it is
-- what makes every write to that column a non-HOT row rewrite.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.ch_citation_state (
    ecli         text PRIMARY KEY,
    extracted_at timestamptz,            -- NULL = queued for extraction
    attempts     smallint NOT NULL DEFAULT 0,
    last_error   text,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The claim query's whole predicate. Partial, so it holds only the backlog
-- (a few thousand rows on an ordinary night) rather than an entry per
-- decision in the corpus.
CREATE INDEX IF NOT EXISTS idx_ch_citation_state_pending
    ON public.ch_citation_state (ecli) WHERE extracted_at IS NULL;

-- Seed from the column this table replaces -- once, and only into an empty
-- table. See the header: keeping the stamps is what stops the first delta
-- after this migration from re-extracting the entire corpus.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.ch_citation_state) THEN
        INSERT INTO public.ch_citation_state (ecli, extracted_at)
        SELECT ecli, citations_extracted_at
          FROM public.ch_court_decisions
         WHERE stage = 'loaded'
        ON CONFLICT (ecli) DO NOTHING;
    END IF;
END $$;

-- Retired with the claim query it served. Every write to the column in its
-- predicate had to re-insert the whole 19 GB table's row into every index
-- on that table, this one and the 7.6 GB full-text GIN included.
DROP INDEX IF EXISTS idx_ch_court_cit_queue;

COMMENT ON TABLE public.ch_citation_state IS
    'Per-decision bookkeeping for the citation extraction stage: extracted_at '
    'NULL means queued, non-NULL means the decision text has been scanned and '
    'its edges written. Lives here rather than on ch_court_decisions because '
    'that table is 19 GB with a 7.6 GB full-text GIN, where a stamp is a '
    'non-HOT row rewrite into every index (measured: a 1.22M-row reset took '
    '22+ minutes and grew the GIN by 0.6 GB in a day). Reset for a full '
    're-extraction: UPDATE ch_citation_state SET extracted_at = NULL.';
COMMENT ON COLUMN public.ch_citation_state.attempts IS
    'Failed extraction attempts. The claim skips rows at or above '
    'CHPIPE_MAX_ATTEMPTS so one poison text cannot be re-read every night '
    'forever; last_error carries the reason.';
