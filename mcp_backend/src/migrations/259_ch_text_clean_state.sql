-- mcp_backend/src/migrations/259_ch_text_clean_state.sql
-- Per-decision bookkeeping for the clean-text stage, in a narrow side table.
--
-- Why a side table: same reasoning as migration 200 (ch_citation_state).
-- ch_court_decisions is ~33 GB with a 7.6 GB full-text GIN. A stamp column
-- there means a progress write per row, and any column named in an index
-- predicate makes it a non-HOT rewrite that re-inserts the large row into
-- every index, GIN included. The clean-text stage rewrites ~499K decision
-- texts; its own bookkeeping (cleaner_version, raw_sha256, cleaned_at,
-- attempts, last_error) must not add 499K more rewrites on top of the one
-- unavoidable full_text UPDATE per row. ch_text_clean_state is tiny, has one
-- small partial index and no GIN.
--
-- The raw text of these rows exists nowhere else (the source PDFs were
-- deleted after extraction), so the stage archives it to a gzip file before
-- each UPDATE (chpipe/raw_text_archive.py); raw_sha256 here ties the row to
-- that archive file.
--
-- No FK to ch_court_decisions and no seed: the stage seeds rows itself, and
-- keeping this file free of dependencies means it applies on its own.
--
-- SET lock_timeout = '3s' first, as in 199/200: the runner applies a file as
-- one implicit transaction, so fail fast rather than queue behind a lock.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.ch_text_clean_state (
    doc_id          text PRIMARY KEY,
    spider          text NOT NULL,
    cleaner_version smallint,              -- version that produced full_text
    raw_sha256      text,                  -- sha256 of the archived raw text
    cleaned_at      timestamptz,           -- NULL = pending
    attempts        smallint NOT NULL DEFAULT 0,
    last_error      text
);

-- The claim query's whole predicate; partial so it holds only the backlog.
CREATE INDEX IF NOT EXISTS idx_ch_text_clean_pending
    ON public.ch_text_clean_state (spider, doc_id) WHERE cleaned_at IS NULL;
