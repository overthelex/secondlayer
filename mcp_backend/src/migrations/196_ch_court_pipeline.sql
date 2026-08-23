-- mcp_backend/src/migrations/196_ch_court_pipeline.sql
-- Queue and provenance columns for the Swiss decisions pipeline.
--
-- Context: as of 2026-08-23 this table holds 678,165 rows, of which only the
-- 165,363 CH_BGer rows carry text and none carry a decision_date. The pipeline
-- re-walks every row, so existing rows are enrolled into the queue here.

ALTER TABLE public.ch_court_decisions
    ADD COLUMN IF NOT EXISTS doc_id            text,
    ADD COLUMN IF NOT EXISTS canton            text,
    ADD COLUMN IF NOT EXISTS html_url          text,
    ADD COLUMN IF NOT EXISTS text_source       text,
    ADD COLUMN IF NOT EXISTS text_quality      real,
    ADD COLUMN IF NOT EXISTS pdf_sha256        text,
    ADD COLUMN IF NOT EXISTS stage             text,
    ADD COLUMN IF NOT EXISTS attempts          smallint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error        text,
    ADD COLUMN IF NOT EXISTS stage_updated_at  timestamptz;

DO $$ BEGIN
    ALTER TABLE public.ch_court_decisions
        ADD CONSTRAINT ch_court_text_source_chk
        CHECK (text_source IS NULL OR text_source IN ('html', 'pdf', 'ocr'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.ch_court_decisions
        ADD CONSTRAINT ch_court_stage_chk
        CHECK (stage IS NULL OR stage IN
               ('indexed','fetched','extracted','ocr_pending','loaded','failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enrol the rows that are already here. A row that already carries real text is
-- done; everything else goes back to the front of the queue. length() > 200 is
-- the same threshold used to measure coverage, so the two numbers agree.
-- CRITICAL: As of 2026-08-23, all 165,363 CH_BGer rows carry mojibake (UTF-8
-- decoded as Latin-1 in the original import). Rows with mojibake must be
-- re-queued for re-fetching, even if length > 200. Only clean text is
-- marked 'loaded'.
--
-- The marker is the PAIR, not the letter. A bare `LIKE '%Â%'` false-positives
-- on legitimate French all-caps -- "LIMITE D'ÂGE DES MAGISTRATS" is ordinary
-- Genevan judgment prose, and a 2,568-character French sample measured 24
-- bare 'Â' with no damage at all. What mojibake actually looks like is a
-- UTF-8 lead byte read as Latin-1 ('Ã' from C3, 'Â' from C2) IMMEDIATELY
-- FOLLOWED by a continuation byte read as Latin-1 (U+0080..U+00BF):
-- 'Graubünden' becomes 'GraubÃ¼nden'. Verified on this database:
--
--   'Graubünden'                    ~ '[\u00c3\u00c2][\u0080-\u00bf]'  -> false
--   'LIMITE D''ÂGE DES MAGISTRATS'  ~ ...                              -> false
--   'La società è più'              ~ ...                              -> false
--   'GraubÃ¼nden'                   ~ ...                              -> true
--
-- The same rule lives in chpipe.text_quality.MOJIBAKE_MARKER, so the
-- migration and the extractor agree on what damaged text is. One marker pair
-- is enough to re-queue here: the cost of a false re-queue is one re-fetch,
-- the cost of a false 'loaded' is a corrupted row nobody looks at again.
UPDATE public.ch_court_decisions
   SET stage = CASE
                 WHEN full_text IS NOT NULL
                      AND length(full_text) > 200
                      AND full_text !~ '[\u00c3\u00c2][\u0080-\u00bf]'
                 THEN 'loaded'
                 ELSE 'indexed'
               END,
       stage_updated_at = now()
 WHERE stage IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_court_doc_id
    ON public.ch_court_decisions (doc_id) WHERE doc_id IS NOT NULL;

-- Partial: the queue only ever scans unfinished work, so finished rows (which
-- will be the overwhelming majority) stay out of the index.
CREATE INDEX IF NOT EXISTS idx_ch_court_stage
    ON public.ch_court_decisions (stage, spider)
    WHERE stage IS DISTINCT FROM 'loaded';

CREATE INDEX IF NOT EXISTS idx_ch_court_quality
    ON public.ch_court_decisions (text_quality) WHERE text_quality IS NOT NULL;

COMMENT ON COLUMN public.ch_court_decisions.doc_id IS
    'entscheidsuche document id, e.g. ZG_OG_001_Z1-2020-5_2022-02-18';
COMMENT ON COLUMN public.ch_court_decisions.text_source IS
    'html | pdf | ocr — where full_text actually came from';
COMMENT ON COLUMN public.ch_court_decisions.text_quality IS
    '0..1 from chpipe.text_quality.score(); low means the PDF text layer was junk';
