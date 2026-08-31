-- Migration 193: per-query ERAU search cache
--
-- The previous cache stored lawyers keyed by surname only, with no freshness check and
-- an exact-surname match that could not reproduce the registry's prefix search
-- ("Мельник" matches "Мельникова" upstream, but not in erau_lawyers). Combined with an
-- un-paginated upstream fetch that only ever read the first ten matches — ordered by
-- ascending registry id, i.e. the oldest admissions — advocates certified in recent
-- years never surfaced in search results.
--
-- This table records which ids a given query actually returned and when, so a result set
-- expires instead of being served indefinitely. It starts empty, which invalidates every
-- truncated result set cached by the old code.

CREATE TABLE IF NOT EXISTS erau_search_cache (
  query_key  TEXT PRIMARY KEY,
  erau_ids   BIGINT[] NOT NULL,
  total      INTEGER NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_erau_search_cache_fetched_at ON erau_search_cache (fetched_at);
