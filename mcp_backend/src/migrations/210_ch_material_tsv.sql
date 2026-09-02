-- mcp_backend/src/migrations/210_ch_material_tsv.sql
-- A stored tsvector for ch_material (migration 209), replacing the
-- expression index.
--
-- Measured on lawrider-gcp on 2026-09-02, 4,879 parsed materials: a search
-- for "Geldwäscherei" (122 hits) took 5.3 s. The GIN index found the 122
-- rows fast; what cost the seconds was ORDER BY ts_rank(<expression>, ...),
-- which re-parses each hit's full text (up to 900K characters) into a
-- tsvector to rank it. A generated, stored column makes the rank a column
-- read; the index moves onto the column, the expression index goes.
--
-- GENERATED ALWAYS ... STORED rewrites the table once when added (10.5K
-- rows, ~700 MB of text: about a minute) under ACCESS EXCLUSIVE, which
-- blocks the two readers (ch_search_materials, ch_get_*) and the text
-- stage's writes for that minute. That is the deliberate trade against an
-- online path (nullable column + trigger + batched backfill + CONCURRENTLY
-- index, which the migration runner's single transaction cannot host):
-- the table is small, and the tools it serves are days old with no traffic
-- to speak of. The operating rule: merge this AFTER the first materials
-- backfill has finished and the tmux session is gone -- lock_timeout = 3s
-- makes the ALTER fail fast (and the deploy with it, to be re-run) rather
-- than queue behind a running stage and block everything behind itself.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE/DROP INDEX IF (NOT) EXISTS.

SET lock_timeout = '3s';

ALTER TABLE public.ch_material
    ADD COLUMN IF NOT EXISTS tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('simple', left(coalesce(title, '') || ' ' || coalesce(full_text, ''), 900000))
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_ch_material_tsv ON public.ch_material USING GIN (tsv);

DROP INDEX IF EXISTS public.idx_ch_material_fts;

COMMENT ON COLUMN public.ch_material.tsv IS
    'Stored tsvector over title + full_text (first 900K chars), ''simple'' configuration; '
    'generated, so the text stage needs no extra write. ch_search_materials ranks on it.';
