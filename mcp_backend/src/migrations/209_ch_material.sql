-- mcp_backend/src/migrations/209_ch_material.sql
-- Legislative materials from the Federal Gazette (BBl / FF): Federal Council
-- dispatches (Botschaften), Federal Council reports and opinions, and
-- parliamentary committee reports -- full text per language (LEXAI-2038,
-- gap plan phase 1b).
--
-- One row per (work, language). Enumerated live on 2026-09-02 by a keyset
-- walk of jolux:Act in /eli/fga/ with typeDocument 23/24/25/30: 3,527 works
-- (Botschaft 2,048, Stellungnahme BR 531, Kommissionsbericht 753, Bericht BR
-- 195), 3,523 of them with a pdf-a manifestation in each of de/fr/it, 1999
-- onwards. NOT the 6,855 a server-side COUNT returns for the same pattern
-- -- chpipe/sparql.py records why aggregates on that endpoint are not to
-- be trusted; opencaselaw's "6,157 Botschaften" is the per-language count.
--
-- Why a side table and not columns on ch_as_act: ch_as_act holds 211K
-- AS/BBl rows of metadata and is joined by ch_act_as_link and
-- ch_article_provenance; growing it by a full_text column and a stage
-- machine would put GIN-indexed 100 KB texts on a table that every
-- provenance query walks (db.py's comment on ch_citation_state makes the
-- same call). as_id is kept as a nullable link.
--
-- bbl_key is the join to the legislation corpus. An expression carries the
-- Gazette citation of its own language edition ("BBl 2001 1433" for de,
-- "FF 2001 1341" for fr, "FF 2001 1247" for it -- three different pages),
-- and ch_article_provenance.bbl_reference (migration 198) carries the same
-- citation as the consolidation footnotes write it, in the footnote's
-- language. Both sides are normalised by chpipe/bbl.py::bbl_key to
-- 'year|volume|page' ('2001||1433'); the volume part is only ever set on the
-- pre-1999 multi-volume citations ("FF 1986 II 360"), which have no Fedlex
-- work and therefore never match -- recorded so the join's ceiling is known.
-- Since 2021 the Gazette cites by document number ("BBl 2021 2318" = the
-- ELI sequence, same in every language) and the expressions carry no
-- historicalLegalId; for that era the key is derived from the ELI.
--
-- Full-text search: 'simple', the repo-wide configuration; the input is cut
-- at 900,000 characters because to_tsvector refuses more than 1 MB and the
-- budget dispatches run to several hundred pages.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.ch_material (
    material_id      bigserial PRIMARY KEY,
    eli_work_uri     text NOT NULL,                -- https://fedlex.data.admin.ch/eli/fga/2001/318
    lang             text NOT NULL CHECK (lang IN ('de', 'fr', 'it')),
    material_type    text NOT NULL CHECK (material_type IN
                         ('botschaft', 'bericht_br', 'stellungnahme_br', 'bericht_kommission')),
    type_uri         text NOT NULL,                -- the jolux:typeDocument IRI, verbatim
    title            text,
    historical_id    text,                         -- 'BBl 2001 1433' / 'FF 2001 1341', as Fedlex writes it
    bbl_key          text,                         -- 'year|volume|page', see chpipe/bbl.py
    memorial_year    integer,
    memorial_page    text,
    date_document    date,
    publication_date date,
    as_id            bigint REFERENCES public.ch_as_act(as_id) ON DELETE SET NULL,
    pdf_url          text NOT NULL,
    stage            text NOT NULL DEFAULT 'discovered'
                         CHECK (stage IN ('discovered', 'parsed', 'failed')),
    attempts         smallint NOT NULL DEFAULT 0,
    last_error       text,
    stage_updated_at timestamptz,
    full_text        text,
    text_quality     real,
    pdf_bytes        integer,
    fetched_at       timestamptz,
    discovered_at    timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (eli_work_uri, lang)
);

-- The claim: stage = 'discovered' rows, oldest publication first.
CREATE INDEX IF NOT EXISTS idx_ch_material_queue
    ON public.ch_material (publication_date, material_id)
    WHERE stage = 'discovered';

-- The article-purpose join and the browse-by-type listing.
CREATE INDEX IF NOT EXISTS idx_ch_material_bbl_key
    ON public.ch_material (bbl_key, lang) WHERE bbl_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ch_material_type_date
    ON public.ch_material (material_type, publication_date DESC);

CREATE INDEX IF NOT EXISTS idx_ch_material_fts
    ON public.ch_material
    USING GIN (to_tsvector('simple',
        left(coalesce(title, '') || ' ' || coalesce(full_text, ''), 900000)));

COMMENT ON TABLE public.ch_material IS
    'Federal Gazette materials (Botschaften, Federal Council reports and opinions, '
    'committee reports), one row per work and language, discovered from Fedlex by '
    'materials_discover_stage and filled with pdftotext output by materials_text_stage. '
    'bbl_key joins ch_article_provenance.bbl_reference (same normalisation). Serves '
    'ch_search_materials / ch_get_material / ch_get_article_purpose.';
