-- mcp_backend/src/migrations/197_ch_legislation_corpus.sql
-- Swiss federal legislation with its edition history.
--
-- Replaces the shape of migration 135, which could hold exactly one edition per
-- (eli_uri, lang) and therefore no amendment history at all. As of 2026-08-23
-- ch_legislation holds 1,901 acts of the 17,293 Fedlex publishes and 0 of its
-- 56,326 consolidated editions (measured 2026-08-24; see
-- services/ch-pipeline/chpipe/fedlex_queries.py for how, and for why it is a
-- point-in-time snapshot rather than an invariant). ch_legislation itself is
-- kept and becomes a projection of these tables — see 197's companion stage
-- project_legacy_stage.

CREATE TABLE IF NOT EXISTS public.ch_act (
    act_id                  bigserial PRIMARY KEY,
    eli_work_uri            text NOT NULL,
    -- Nullable on purpose: eli/cc/1/116_97_116 and ~4,300 others carry no
    -- id-systematique notation. Deriving one from the ELI path is what made
    -- "SR 220" unfindable in the old table.
    sr_number               text,
    act_type                text,
    abbreviation            text,
    title_de                text,
    title_fr                text,
    title_it                text,
    title_en                text,
    title_rm                text,
    date_document           date,
    date_entry_force        date,
    date_no_longer_in_force date,
    -- Verified vocabulary: 0 = In force, 1 = No longer published in the SR,
    -- 3 = No longer in force. NULL for the ~4,296 works with no status.
    enforcement_status      smallint,
    in_force                boolean GENERATED ALWAYS AS (enforcement_status = 0) STORED,
    taxonomy_path           text,
    metadata_json           jsonb,
    stage                   text NOT NULL DEFAULT 'discovered',
    imported_at             timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_eli ON public.ch_act (eli_work_uri);
CREATE INDEX IF NOT EXISTS idx_ch_act_sr ON public.ch_act (sr_number)
    WHERE sr_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ch_act_in_force ON public.ch_act (in_force);

CREATE TABLE IF NOT EXISTS public.ch_act_version (
    version_id              bigserial PRIMARY KEY,
    act_id                  bigint NOT NULL REFERENCES public.ch_act(act_id) ON DELETE CASCADE,
    eli_consolidation_uri   text NOT NULL,
    lang                    text NOT NULL,
    date_applicability      date NOT NULL,
    date_end_applicability  date,
    -- xml_url only. There is deliberately no html_url/pdf_url pair here:
    -- the VERSIONS query reads the file URL off the XML manifestation, and
    -- nothing in this pipeline fetches, parses or projects any other
    -- format. Two columns nothing writes and nothing reads are not
    -- harmless -- they read as coverage the corpus does not have, which is
    -- the same class of quiet untruth this whole migration exists to
    -- correct. Widening VERSIONS to capture the sibling manifestations was
    -- the alternative and was rejected: it multiplies every discovery
    -- batch's row count by the four other formats Fedlex serves, for URLs
    -- no stage would use. Add them back the day something needs them.
    xml_url                 text,
    akn_xml                 text,
    full_text               text,
    article_count           integer,
    stage                   text NOT NULL DEFAULT 'discovered',
    attempts                smallint NOT NULL DEFAULT 0,
    last_error              text,
    failed_stage            text,
    fetched_at              timestamptz,
    -- The queue's retry-backoff clock, same role as migration 196's column
    -- of the same name on ch_court_decisions: complete_version()/
    -- fail_version() stamp it on every write, and claim_versions() uses it
    -- to space retries out (1, 5, 30 minutes by attempt) so a durably-broken
    -- row does not burn its whole attempt budget inside one stage run.
    stage_updated_at        timestamptz,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_version
    ON public.ch_act_version (eli_consolidation_uri, lang);
CREATE INDEX IF NOT EXISTS idx_ch_act_version_act
    ON public.ch_act_version (act_id, lang, date_applicability);
CREATE INDEX IF NOT EXISTS idx_ch_act_version_stage
    ON public.ch_act_version (stage) WHERE stage <> 'parsed';

CREATE TABLE IF NOT EXISTS public.ch_act_article (
    article_id      bigserial PRIMARY KEY,
    version_id      bigint NOT NULL REFERENCES public.ch_act_version(version_id) ON DELETE CASCADE,
    -- Akoma Ntoso eId. Verified in the real OR XML that these can be paths
    -- ('disp_u17/art_7'), so article_number is NOT unique within a version but
    -- e_id is.
    e_id            text NOT NULL,
    article_number  text,
    marginal_note   text,
    text            text NOT NULL,
    ordinal         integer NOT NULL,
    parent_e_id     text,
    -- Footnotes and amendment-effective-date citations Fedlex embeds inline
    -- as <authorialNote> ("Fassung gemäss ...", "in Kraft seit ...") --
    -- stripped out of `text` so a footnote-only correction does not read as
    -- an amendment to the provision (see chpipe/akn.py), but kept here
    -- rather than discarded: this is the amendment provenance a future
    -- stage needs to explain WHY an article changed, not just that it did.
    notes           text[] NOT NULL DEFAULT '{}'::text[]
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_article
    ON public.ch_act_article (version_id, e_id);
CREATE INDEX IF NOT EXISTS idx_ch_act_article_number
    ON public.ch_act_article (article_number);
CREATE INDEX IF NOT EXISTS idx_ch_act_article_order
    ON public.ch_act_article (version_id, ordinal);

CREATE TABLE IF NOT EXISTS public.ch_act_change (
    change_id           bigserial PRIMARY KEY,
    act_id              bigint NOT NULL REFERENCES public.ch_act(act_id) ON DELETE CASCADE,
    lang                text NOT NULL DEFAULT 'de',
    from_version_id     bigint REFERENCES public.ch_act_version(version_id) ON DELETE CASCADE,
    to_version_id       bigint REFERENCES public.ch_act_version(version_id) ON DELETE CASCADE,
    e_id                text NOT NULL,
    article_number      text,
    change_type         text NOT NULL,
    date_applicability  date NOT NULL,
    CONSTRAINT ch_act_change_type_chk
        CHECK (change_type IN ('added', 'modified', 'repealed'))
);

CREATE INDEX IF NOT EXISTS idx_ch_act_change_act
    ON public.ch_act_change (act_id, date_applicability);
CREATE INDEX IF NOT EXISTS idx_ch_act_change_article
    ON public.ch_act_change (act_id, e_id, date_applicability);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_change
    ON public.ch_act_change (to_version_id, e_id);

DO $$ BEGIN
    ALTER TABLE public.ch_act_version
        ADD CONSTRAINT ch_act_version_failed_stage_chk
        CHECK (failed_stage IS NULL OR failed_stage IN
               ('discovered', 'fetched', 'parsed', 'diff', 'projection'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE public.ch_act_change IS
    'Computed per-article difference between consecutive consolidated editions. '
    'This is the amendment history; Fedlex does not publish it directly.';
COMMENT ON INDEX public.ux_ch_act_change IS
    'Key is (to_version_id, e_id) to enforce one statement per article per edition: '
    'a re-diff must correct a record rather than accumulate contradictions between '
    'different baseline versions. change_type does not belong in the key because an '
    'article cannot be both added and repealed in the same edition.';
COMMENT ON COLUMN public.ch_act.enforcement_status IS
    '0 = in force, 1 = no longer published in the SR, 3 = no longer in force, '
    'NULL = Fedlex publishes no status for this work';
COMMENT ON COLUMN public.ch_act_version.failed_stage IS
    'the stage a failed row was in when it failed; NULL means it never entered '
    'a queue stage. chpipe.db.retry_failed_versions() returns a row to this stage, '
    'so recovery is targeted instead of sending every failure back to the front of '
    'the queue; chpipe.db.failed_by_stage_versions() is the triage query to read '
    'first. NOT db.retry_failed(), which this comment used to name: that one reads '
    'ch_court_decisions and answers 0 against a legislation backlog. '
    'Unlike migration 196, this list includes parsed (a terminal stage here) because '
    'diff and projection operate on parsed rows in place without advancing them further.';

