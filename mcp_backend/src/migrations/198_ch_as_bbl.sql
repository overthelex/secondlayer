-- mcp_backend/src/migrations/198_ch_as_bbl.sql
-- Official Compilation (AS/RO) and Federal Gazette (BBl/FF), plus the amendment
-- provenance that Fedlex does NOT publish as a relation.
--
-- Verified 2026-08-23: neither jolux:Act nor jolux:ConsolidationAbstract carries
-- an "amends" predicate. jolux:basicAct (69,190 occurrences) points from a
-- Classified Compilation entry to the Official Compilation act that established
-- it -- that is establishment, not amendment. jolux:rectifies (343 occurrences)
-- and jolux:isFollowingAct (414 occurrences) are the only other structured
-- links there are. None of the three gives us an amendment chain: that comes
-- from the computed edition diff (migration 197's ch_act_change) and, per
-- article, from the Akoma Ntoso footnotes -- see ch_article_provenance.

CREATE TABLE IF NOT EXISTS public.ch_as_act (
    as_id            bigserial PRIMARY KEY,
    eli_uri          text NOT NULL,
    collection       text NOT NULL,
    publication_date date,
    date_document    date,
    date_entry_force date,
    -- No title_de/title_fr/title_it, no xml_url/pdf_url: task 4's AS_ACTS query
    -- selects only ?act ?dateDocument ?publicationDate ?dateEntryForce
    -- ?typeDocument, so those five would ship as columns nothing ever writes.
    -- Same reasoning migration 197 applied to ch_act_version's html_url/pdf_url
    -- (see the comment on xml_url there): a column nothing writes and nothing
    -- reads reads as coverage the corpus does not have. Add them back the day
    -- a separate titles walk over the Official Compilation entries exists to
    -- fill them.
    document_type    text,
    metadata_json    jsonb,
    imported_at      timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ch_as_act_collection_chk CHECK (collection IN ('AS', 'BBl'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_as_act_eli ON public.ch_as_act (eli_uri);
CREATE INDEX IF NOT EXISTS idx_ch_as_act_published
    ON public.ch_as_act (collection, publication_date);

CREATE TABLE IF NOT EXISTS public.ch_act_amendment_link (
    link_id       bigserial PRIMARY KEY,
    act_id        bigint NOT NULL REFERENCES public.ch_act(act_id) ON DELETE CASCADE,
    as_id         bigint NOT NULL REFERENCES public.ch_as_act(as_id) ON DELETE CASCADE,
    -- 'basic_act'  : jolux:basicAct, the act that established this CC entry
    -- 'rectifies'  : jolux:rectifies
    -- 'follows'    : jolux:isFollowingAct
    relation_type text NOT NULL,
    CONSTRAINT ch_amendment_relation_chk
        CHECK (relation_type IN ('basic_act', 'rectifies', 'follows'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_amendment_link
    ON public.ch_act_amendment_link (act_id, as_id, relation_type);

CREATE TABLE IF NOT EXISTS public.ch_article_provenance (
    provenance_id   bigserial PRIMARY KEY,
    version_id      bigint NOT NULL REFERENCES public.ch_act_version(version_id)
                        ON DELETE CASCADE,
    e_id            text NOT NULL,
    -- Parsed from prose, so it is a best effort. raw_note is kept so a wrong
    -- parse stays detectable instead of becoming invisible fact.
    action          text,
    as_reference    text,
    bbl_reference   text,
    effective_date  date,
    source_act_date date,
    raw_note        text NOT NULL,
    CONSTRAINT ch_provenance_action_chk
        CHECK (action IS NULL OR action IN ('inserted', 'amended', 'repealed'))
);

CREATE INDEX IF NOT EXISTS idx_ch_provenance_version
    ON public.ch_article_provenance (version_id, e_id);
CREATE INDEX IF NOT EXISTS idx_ch_provenance_as
    ON public.ch_article_provenance (as_reference)
    WHERE as_reference IS NOT NULL;

COMMENT ON TABLE public.ch_as_act IS
    'Official Compilation (AS/RO) and Federal Gazette (BBl/FF) entries, keyed by '
    'ELI URI. collection distinguishes the two; there is no third value.';
COMMENT ON TABLE public.ch_act_amendment_link IS
    'Structured links from a Classified Compilation act (ch_act) to the Official '
    'Compilation entry (ch_as_act) that relates to it. This is establishment and '
    'rectification provenance, not an amendment relation -- Fedlex publishes none.';
COMMENT ON TABLE public.ch_article_provenance IS
    'Amendment provenance recovered from Akoma Ntoso authorialNote prose, e.g. '
    '"Eingefuegt durch Ziff. I des BG vom 5. Okt. 1990, in Kraft seit 1. Juli 1991 '
    '(AS 1991 846; BBl 1986 II 354)". Fedlex publishes no amends relation.';
