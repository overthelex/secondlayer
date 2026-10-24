-- 019_entity_short_name_fts.sql
-- search_entities (LEXAI-2098) also matches the short name: АТ "УКРЗАЛІЗНИЦЯ" is
-- only findable by «Укрзалізниця» through short_name (the full name is
-- АКЦІОНЕРНЕ ТОВАРИСТВО "УКРАЇНСЬКА ЗАЛІЗНИЦЯ"). Without an index the OR branch
-- seq-scans ~2M legal_entities rows (~2.4 s per query).
-- The expression must stay identical to the one in OpenReyestrTools.searchEntityTable.

CREATE INDEX IF NOT EXISTS idx_legal_entities_short_name_fts
    ON legal_entities USING gin (to_tsvector('simple', coalesce(short_name, '')));

CREATE INDEX IF NOT EXISTS idx_public_associations_short_name_fts
    ON public_associations USING gin (to_tsvector('simple', coalesce(short_name, '')));
