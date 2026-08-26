-- mcp_backend/src/migrations/201_ch_cantonal_legislation.sql
-- Cantonal legislation in the same tables as federal law.
--
-- ch_act.jurisdiction: 'CH' for Fedlex, a two-letter canton code for the
-- cantonal collections (Lexwork platform, 19 cantons in phase 1; the other
-- seven are registered from LexFind and get their text in phase 2). The
-- act's identity stays eli_work_uri. sr_number is NOT unique even in the
-- federal corpus (measured on lawrider_prod 2026-08-26: 17,293 acts, 9,054
-- distinct sr_number, 3,924 NULL, "916.361.1" appears 36 times), so no
-- unique index is added here and the tools keep their
-- ORDER BY in_force ... LIMIT 1 when they resolve a number to an act.
--
-- 200 is reserved for ch_citation_state (feat/ch-citation-precision); the
-- gap in numbering is deliberate.

ALTER TABLE public.ch_act ADD COLUMN IF NOT EXISTS jurisdiction text NOT NULL DEFAULT 'CH';

DO $$ BEGIN
    ALTER TABLE public.ch_act
        ADD CONSTRAINT ch_act_jurisdiction_chk
        CHECK (jurisdiction IN ('CH',
            'AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE',
            'NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_ch_act_jur_sr ON public.ch_act (jurisdiction, sr_number)
    WHERE sr_number IS NOT NULL;

-- ch_act_version.source: which pipeline wrote the row and what akn_xml
-- holds. 'fedlex' = Akoma Ntoso XML from Fedlex; 'lexwork' = the raw
-- show_as_json payload of one Lexwork version (every language of that
-- version in one document). Every claim over this queue filters on it, so
-- the two parsers never see each other's payloads: the AKN parser would
-- reject JSON as "not Akoma Ntoso" and fail the row three times before
-- anyone noticed why.
ALTER TABLE public.ch_act_version ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'fedlex';

DO $$ BEGIN
    ALTER TABLE public.ch_act_version
        ADD CONSTRAINT ch_act_version_source_chk
        CHECK (source IN ('fedlex', 'lexwork'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_ch_act_version_source_stage
    ON public.ch_act_version (source, stage) WHERE stage <> 'parsed';

-- The amending act as the canton publishes it ("Verfassung des Kantons
-- Bern (KV) (Änderung vom 27.11.2023)", number 25-022 in the official
-- collection, with a PDF). Fedlex has no equivalent entity (jolux has no
-- "amends" predicate, see migration 198's comments); Lexwork lists them per
-- act and links each row of a version's modification table to one of them
-- through history_information_map. One amending act can touch several
-- acts, hence the UNIQUE includes act_id.
CREATE TABLE IF NOT EXISTS public.ch_act_change_document (
    change_document_id bigserial PRIMARY KEY,
    act_id            bigint NOT NULL REFERENCES public.ch_act(act_id) ON DELETE CASCADE,
    jurisdiction      text NOT NULL,
    source_id         bigint NOT NULL,
    number            text,
    title             text,
    date_publication  date,
    date_decision     date,
    pdf_url           text,
    metadata_json     jsonb,
    imported_at       timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (jurisdiction, source_id, act_id)
);

ALTER TABLE public.ch_article_provenance
    ADD COLUMN IF NOT EXISTS change_document_id bigint
        REFERENCES public.ch_act_change_document(change_document_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ch_article_provenance_change_document
    ON public.ch_article_provenance (change_document_id) WHERE change_document_id IS NOT NULL;

-- LexFind's view of every canton (26), kept as the independent side of the
-- reconciliation gate (Gate F): what Lexwork says exists is compared with
-- what LexFind says exists, and neither side is derived from the other.
-- versions_json is the with-version-groups response flattened to a list;
-- version_count is derived from it at write time.
CREATE TABLE IF NOT EXISTS public.ch_cantonal_registry (
    lexfind_tol_id    bigint PRIMARY KEY,
    canton            text NOT NULL,
    systematic_number text,
    title             text,
    is_active         boolean,
    category          text,
    original_url      text,
    versions_json     jsonb NOT NULL,
    version_count     integer NOT NULL,
    fetched_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ch_cantonal_registry_canton
    ON public.ch_cantonal_registry (canton, systematic_number);

COMMENT ON COLUMN public.ch_act.jurisdiction IS
    'CH for federal (Fedlex) acts, two-letter canton code for cantonal collections. Act identity remains eli_work_uri; (jurisdiction, sr_number) is not unique.';
COMMENT ON COLUMN public.ch_act_version.source IS
    'fedlex: akn_xml holds Akoma Ntoso XML. lexwork: akn_xml holds the raw show_as_json payload of one version.';
COMMENT ON TABLE public.ch_act_change_document IS
    'Amending acts as published by a canton (Lexwork change_documents). Linked from ch_article_provenance.change_document_id.';
COMMENT ON TABLE public.ch_cantonal_registry IS
    'LexFind registry of all cantonal acts and their versions; the independent side of the cantonal reconciliation gate.';
