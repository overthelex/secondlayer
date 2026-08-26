-- Companion to migrations 190/191. NOT run by mcp_backend/src/migrations/migrate.ts.
--
-- migrate.ts executes each file as one db.query(), i.e. inside one implicit
-- transaction, and CREATE INDEX CONCURRENTLY cannot run in a transaction. The
-- established convention is to park those builds here and apply them by hand;
-- the precedent is scripts/nl/179b_nl_decisions_indexes_concurrently.sql.
--
-- Apply on prod:
--   docker cp scripts/pl/192_pl_indexes_concurrently.sql secondlayer-postgres-prod:/tmp/
--   docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod \
--       -f /tmp/192_pl_indexes_concurrently.sql
--
-- Then ALWAYS check for a build that was interrupted, which leaves an INVALID
-- index that silently does not serve queries:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;

-- ---------------------------------------------------------------------------
-- pl_court_decisions is 2,864,093 rows / 105 GB. Every index on it must be
-- CONCURRENTLY or the table is locked for the duration.
-- ---------------------------------------------------------------------------

-- The dedup and idempotency key. Built as a plain index first: the table today
-- has 2.86M rows with judgment_id NULL, and a UNIQUE index over them is fine
-- (NULLs do not collide in Postgres), but the backfill in 40_repair_legacy.py
-- must run before anything relies on uniqueness being meaningful.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_pl_court_judgment_id
    ON pl_court_decisions (judgment_id) WHERE judgment_id IS NOT NULL;

-- Incremental passes and the substrate /changes feed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pl_court_updated_at
    ON pl_court_decisions (updated_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pl_court_text_status
    ON pl_court_decisions (text_status) WHERE text_status IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Legislation.
-- ---------------------------------------------------------------------------

-- Polish stemming: Postgres ships no 'polish' text search configuration by
-- default, and the existing idx_pl_court_fts (migration 151) silently uses
-- 'simple', i.e. no morphology at all - the same defect the Dutch corpus had
-- until 179b replaced 'simple' with 'dutch'.
--
-- Check what this cluster actually has BEFORE running the FTS index below:
--   SELECT cfgname FROM pg_ts_config ORDER BY 1;
-- If a 'polish' config exists, change 'simple' to 'polish' in the two statements
-- below and in the pl_court_decisions rebuild at the bottom. If it does not,
-- installing it needs a hunspell pl_PL dictionary in the image, which is a
-- deployment change and therefore a separate decision - record which branch was
-- taken here rather than leaving the choice implicit.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pl_articles_fts
    ON pl_act_articles USING GIN (to_tsvector('simple', text));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pl_acts_title_trgm
    ON pl_acts USING GIN (title gin_trgm_ops);

-- Article ordering for structural navigation: 304^4 sorts after 304 and before 305.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pl_articles_sort
    ON pl_act_articles (act_eli, art_sort_1, art_sort_2);

-- ---------------------------------------------------------------------------
-- Deferred: the pl_court_decisions FTS rebuild.
--
-- idx_pl_court_fts is a GIN index on to_tsvector('simple', ...) over 105 GB of
-- text. Rebuilding it with a real Polish configuration is a multi-hour build and
-- a large amount of new disk, so it is deliberately NOT in this file. Do it as
-- its own scheduled operation once the corpus is repaired and deduplicated -
-- rebuilding it now would index rows that 40_repair_legacy.py is about to
-- collapse.
--
--   CREATE INDEX CONCURRENTLY idx_pl_court_fts_pl ON pl_court_decisions
--       USING GIN (to_tsvector('polish', coalesce(parties,'') || ' ' ||
--                              coalesce(abstract,'') || ' ' || coalesce(full_text,'')));
--   DROP INDEX CONCURRENTLY idx_pl_court_fts;
-- ---------------------------------------------------------------------------
