-- mcp_backend/src/migrations/208_ch_commentary.sql
-- Open-access legal commentaries on Swiss federal acts, one row per
-- commentary per language (LEXAI-2037, gap plan phase 1a).
--
-- First and so far only source: onlinekommentar.ch, whose API serves 391
-- commentaries in each of de/fr/it/en (measured 2026-09-02; every
-- translation has its own uuid, so `source_id` is per language and the
-- natural key is (source, source_id)). Licence CC BY 4.0, stated at
-- https://onlinekommentar.ch/de/creative-commons-license -- recorded per
-- row in `licence` because the next source (openlegalcommentary.ch) is
-- CC BY-SA and the two must not be conflated when the text is re-served.
--
-- sr_number is RESOLVED, not copied: the source names the act by an
-- internal uuid and an English title, and the commentary title carries the
-- language's own abbreviation ("Art. 1b BankG" / "Art. 1b LB" / "Art. 1b
-- LBCR"). commentary_stage maps the uuid through a verified table and falls
-- back to ch_act_alias (migration 199/206); a commentary it cannot place
-- keeps sr_number NULL and is counted in the stage report rather than
-- dropped -- the text is still searchable, only the act join is missing.
--
-- article_number is NULL for the ~10 commentaries per language that are
-- not about one article ("Vorb. zu Art. 13-14a StHG", "Einleitung KGTG",
-- transitional provisions); `kind` says which shape the title had.
--
-- Full-text search uses the 'simple' configuration, the same choice
-- migration 134 made for ch_court_decisions: the corpus is four languages
-- in one column and a per-language stemmer would have to be chosen per row.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.ch_commentary (
    id                 bigserial PRIMARY KEY,
    source             text NOT NULL,                -- 'onlinekommentar'
    source_id          text NOT NULL,                -- the source's own id, per language
    lang               text NOT NULL CHECK (lang IN ('de', 'fr', 'it', 'en')),
    kind               text NOT NULL CHECK (kind IN ('article', 'preliminary', 'introduction', 'other')),
    sr_number          text,                         -- resolved; NULL when the act could not be placed
    act_uuid           text,                         -- the source's act id, language-independent
    act_title          text,                         -- the source's act title (English at onlinekommentar)
    abbr               text,                         -- as written in the title: BankG, LB, LBCR, BA
    article_number     text,                         -- '1b', '119a'; NULL for kind <> 'article'
    title              text NOT NULL,
    authors            text[] NOT NULL DEFAULT '{}',
    editors            text[] NOT NULL DEFAULT '{}',
    version_date       date,                         -- the source's `date` (last edition of the text)
    suggested_citation text,
    content_html       text NOT NULL,
    content_text       text NOT NULL,
    legal_text         text,                         -- the commented provision, as the source quotes it
    licence            text NOT NULL,
    source_url         text NOT NULL,
    pdf_url            text,
    content_hash       text NOT NULL,                -- sha256 over content_html
    fetched_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_ch_commentary_act
    ON public.ch_commentary (sr_number, article_number, lang);

CREATE INDEX IF NOT EXISTS idx_ch_commentary_fts
    ON public.ch_commentary
    USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content_text, '')));

COMMENT ON TABLE public.ch_commentary IS
    'Open-access commentaries on Swiss federal acts (onlinekommentar.ch, CC BY 4.0), '
    'one row per commentary per language, written by commentary_stage. sr_number is '
    'resolved from the source''s act id / the title abbreviation and is NULL when '
    'that failed; licence is recorded per row. Serves ch_get_commentary / '
    'ch_search_commentary.';
