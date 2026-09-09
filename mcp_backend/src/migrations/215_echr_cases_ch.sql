-- mcp_backend/src/migrations/215_echr_cases_ch.sql
-- echr_cases on lawrider: the ECtHR documents that matter to a Swiss
-- lawyer (LEXAI-2040, gap plan phase 3), written by services/ch-pipeline
-- echr_import_stage from the HUDOC harvest kept on cthulhu
-- (/mnt/bulk_storage/home-offload/hudoc-storage, metadata + text).
--
-- The table already exists on both production boxes (created outside the
-- migration runner by scripts/hudoc/import-echr-to-pg.ts in 2026-03, then
-- indexed by 161); the CREATE below is the same shape so a fresh database
-- (tests, a rebuilt box) gets it, and IF NOT EXISTS leaves the live one
-- alone. What this migration adds is the stored tsvector the search tool
-- ranks on (the 210 pattern: the rank is a column read, not a re-parse of
-- a 900K-character judgment per hit) and the indexes the Swiss slice
-- filters by. Adding a generated column rewrites the table under ACCESS
-- EXCLUSIVE; on lawrider it is empty at the time of this migration, on
-- legal_prod (0 rows since the AWS box went) the same.
-- Idempotent: IF NOT EXISTS throughout.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.echr_cases (
    id                       SERIAL PRIMARY KEY,
    item_id                  TEXT NOT NULL UNIQUE,      -- HUDOC itemid, "001-123456"
    app_no                   TEXT,                      -- "12345/06;12346/06"
    doc_name                 TEXT,
    doc_type                 TEXT,                      -- HEJUD, HFDEC, CLIN, HJUDGER, ...
    doc_type_branch          TEXT,
    article                  TEXT,
    conclusion               TEXT,
    ecli                     TEXT,
    importance               INTEGER,                   -- 1 key case .. 4 low
    judgment_date            DATE,
    introduction_date        DATE,
    language                 TEXT,
    originating_body         TEXT,
    separate_opinion         BOOLEAN,
    extracted_app_no         TEXT,
    kp_thesaurus             TEXT,
    type_description         TEXT,
    respondent               TEXT,                      -- "CHE" or "CHE;ITA"
    created_at               TIMESTAMPTZ DEFAULT now(),
    language_iso             TEXT,                      -- ENG, FRE, GER, ITA, ...
    kp_date                  TEXT,                      -- HUDOC kpdate, ISO datetime text
    document_collection_id   TEXT,
    document_collection_id2  TEXT,                      -- "CASELAW;JUDGMENTS;CHAMBER;ENG"
    is_placeholder           BOOLEAN,
    full_text_html           TEXT,
    full_text                TEXT
);

CREATE INDEX IF NOT EXISTS idx_echr_cases_item_id       ON public.echr_cases (item_id);
CREATE INDEX IF NOT EXISTS idx_echr_cases_respondent    ON public.echr_cases (respondent);
CREATE INDEX IF NOT EXISTS idx_echr_cases_importance    ON public.echr_cases (importance);
CREATE INDEX IF NOT EXISTS idx_echr_cases_judgment_date ON public.echr_cases (judgment_date);
CREATE INDEX IF NOT EXISTS idx_echr_cases_kp_date       ON public.echr_cases (kp_date);
CREATE INDEX IF NOT EXISTS idx_echr_cases_app_no_btree  ON public.echr_cases (app_no);
CREATE INDEX IF NOT EXISTS idx_echr_cases_doc_type      ON public.echr_cases (doc_type);
CREATE INDEX IF NOT EXISTS idx_echr_cases_language_iso  ON public.echr_cases (language_iso);

-- 'simple': the corpus is English and French with German/Italian
-- translations, one column for all of them, as migration 134 chose for
-- the decisions and 208/210 for the commentaries and materials.
ALTER TABLE public.echr_cases
    ADD COLUMN IF NOT EXISTS tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('simple', left(coalesce(doc_name, '') || ' ' || coalesce(full_text, ''), 900000))
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_echr_cases_tsv ON public.echr_cases USING GIN (tsv);

COMMENT ON TABLE public.echr_cases IS
    'ECtHR documents from HUDOC. On lawrider: every document with Switzerland as respondent '
    '(judgments, decisions, communicated cases, resolutions, reports, Information Note summaries, '
    'translations) plus every Chamber and Grand Chamber judgment of importance 1-3 in English and '
    'French. Written by services/ch-pipeline echr_import_stage (LEXAI-2040).';
COMMENT ON COLUMN public.echr_cases.tsv IS
    'Stored tsvector over doc_name + full_text (first 900K chars), ''simple'' configuration; '
    'ch_search_echr ranks on it.';
