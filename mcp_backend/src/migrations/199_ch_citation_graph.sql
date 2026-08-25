-- mcp_backend/src/migrations/199_ch_citation_graph.sql
-- Swiss citation graph: case-to-case and case-to-legislation citations
-- extracted from ch_court_decisions full text.
--
-- APPLY THIS OUTSIDE THE 07:15 UTC DELTA WINDOW.
--
-- The migration runner applies a whole file as ONE implicit transaction, so
-- every lock this file takes is held until its last statement commits. The
-- ALTER TABLE below takes an ACCESS EXCLUSIVE lock on ch_court_decisions
-- (1.22M rows) -- which blocks every reader and writer of that table -- and
-- the two ch_court_decisions indexes after it are then built while that lock
-- is still held. Those builds are tens of seconds on the production table,
-- and that is how long the whole table is unavailable. Run against the delta
-- and the delta's own writes queue behind it.
--
-- SET lock_timeout = '3s' is the first statement for the same reason: if
-- ch_court_decisions is already busy, this file must fail fast and be
-- retried in a quiet window rather than sit in the lock queue holding up
-- everything that arrives behind it. The SET is session-local and lasts
-- only for the session applying the migration.
--
-- ch_act_alias maps the abbreviation a decision actually writes ("OR", "CO",
-- "Cst.", "StGB") to the SR number the legislation corpus (migration 197)
-- keys on -- one abbreviation can mean different acts across languages
-- (source distinguishes fedlex_abbreviation / title_paren / curated
-- provenance), so this is a lookup table, not a 1:1 rename.
--
-- ch_legislation_citations.UNIQUE NULLS NOT DISTINCT (from_ecli, abbr_raw,
-- article, paragraph): paragraph is frequently absent ("art. 336 OR" cites
-- the whole article, no specific paragraph), and plain UNIQUE treats every
-- NULL as distinct from every other NULL -- so without NULLS NOT DISTINCT,
-- the same paragraph-less citation extracted twice (e.g. on a re-run of the
-- extractor) would insert as two rows instead of colliding into one.
-- NULLS NOT DISTINCT requires PostgreSQL 15+; prod runs PostgreSQL 16.
--
-- The CHECK constraints below are inline in each CREATE TABLE (not wrapped
-- in the DO $$ ... EXCEPTION WHEN duplicate_object pattern migrations 197/198
-- use for constraints added to a pre-existing table): the CREATE TABLE
-- itself is already guarded by IF NOT EXISTS, so on a second run the whole
-- statement -- CHECK included -- is skipped rather than re-attempted.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.ch_act_alias (
    abbr        text NOT NULL,          -- as written in texts: OR, CO, Cst., StGB
    lang        text NOT NULL,          -- de | fr | it | any
    sr_number   text NOT NULL,
    source      text NOT NULL,          -- fedlex_abbreviation | title_paren | curated
    PRIMARY KEY (abbr, lang, sr_number)
);

CREATE TABLE IF NOT EXISTS public.ch_case_citations (
    id               bigserial PRIMARY KEY,
    from_ecli        text NOT NULL,
    to_raw           text NOT NULL,      -- canonical: 'BGE 142 III 102' | '4A_22/2017' | 'ECLI:CH:...'
    cite_kind        text NOT NULL CHECK (cite_kind IN ('bge','docket','ecli')),
    to_ecli          text,
    resolved         boolean NOT NULL DEFAULT false,
    match_method     text,               -- docket_exact | ecli_exact
    citation_context text,               -- +/-120 chars around the first occurrence
    from_date        date,
    from_court       text,
    UNIQUE (from_ecli, to_raw)
);
CREATE INDEX IF NOT EXISTS idx_ch_case_cit_to ON public.ch_case_citations (to_ecli) WHERE to_ecli IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ch_case_cit_unres ON public.ch_case_citations (cite_kind) WHERE NOT resolved;

CREATE TABLE IF NOT EXISTS public.ch_legislation_citations (
    id               bigserial PRIMARY KEY,
    from_ecli        text NOT NULL,
    abbr_raw         text NOT NULL,      -- 'OR', 'CO', 'Cst.', 'LTF'
    article          text NOT NULL,      -- '336', '336a', '8'
    paragraph        text,               -- '1', NULL
    lang             text,               -- language the pattern matched in: de | fr | it
    sr_number        text,
    act_id           bigint,
    version_id       bigint,
    article_id       bigint,
    resolved         boolean NOT NULL DEFAULT false,   -- article_id IS NOT NULL
    match_method     text,               -- edition_at_date | latest_edition | act_only | unresolved_abbr
    citation_context text,
    from_date        date,
    UNIQUE NULLS NOT DISTINCT (from_ecli, abbr_raw, article, paragraph)
);
CREATE INDEX IF NOT EXISTS idx_ch_leg_cit_article ON public.ch_legislation_citations (article_id) WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ch_leg_cit_act ON public.ch_legislation_citations (act_id, article) WHERE act_id IS NOT NULL;
-- citations_resolve_stage's step 1/4 entry points both scan
-- "WHERE match_method IS NULL" -- every row citations_stage has extracted
-- and nothing has ever tried to resolve. Without this, that scan is
-- sequential over the whole table on every resolve run, not just the first.
CREATE INDEX IF NOT EXISTS idx_ch_leg_cit_pending ON public.ch_legislation_citations (id) WHERE match_method IS NULL;
CREATE INDEX IF NOT EXISTS idx_ch_case_cit_pending ON public.ch_case_citations (id) WHERE match_method IS NULL;

ALTER TABLE public.ch_court_decisions ADD COLUMN IF NOT EXISTS citations_extracted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_ch_court_cit_queue ON public.ch_court_decisions (spider, doc_id)
    WHERE stage = 'loaded' AND citations_extracted_at IS NULL;
-- citations_resolve_stage's step 4 (case resolution) matches to_raw against
-- ch_court_decisions.docket_number for both the 'bge' and 'docket'
-- cite_kinds -- the lookup this stage runs most, over the whole corpus.
CREATE INDEX IF NOT EXISTS idx_ch_court_docket ON public.ch_court_decisions (docket_number) WHERE docket_number IS NOT NULL;

-- citations_resolve_stage's step 3 (article resolution) looks an article up
-- by (version_id, article_number). Migration 197 gives ch_act_article an
-- index on article_number alone (every edition's article 8, across the whole
-- corpus) and one on (version_id, ordinal) -- neither serves that lookup.
-- Measured 6.6x on the composite. It lives here rather than in 197 because
-- it exists for this stage: 197's own readers walk an edition by ordinal.
CREATE INDEX IF NOT EXISTS idx_ch_act_article_version_number ON public.ch_act_article (version_id, article_number);

COMMENT ON TABLE public.ch_act_alias IS
    'Maps the abbreviation a decision actually writes (OR, CO, Cst., StGB) to the '
    'SR number ch_act keys on. One abbreviation can name different acts across '
    'languages or eras, so this is a lookup, not a 1:1 rename; source records where '
    'the mapping came from (fedlex_abbreviation | title_paren | curated).';
COMMENT ON TABLE public.ch_case_citations IS
    'Case-to-case citations extracted from ch_court_decisions full text. to_ecli/'
    'resolved/match_method are filled in by a resolution pass; extraction alone '
    'leaves them NULL/false.';
COMMENT ON TABLE public.ch_legislation_citations IS
    'Case-to-legislation citations extracted from ch_court_decisions full text. '
    'UNIQUE NULLS NOT DISTINCT on (from_ecli, abbr_raw, article, paragraph): most '
    'citations carry no paragraph, and plain UNIQUE would treat every NULL '
    'paragraph as distinct, letting the same citation duplicate on re-extraction.';
