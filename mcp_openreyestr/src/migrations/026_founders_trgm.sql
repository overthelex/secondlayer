-- 026_founders_trgm.sql
-- Trigram index for search_founders: reverse lookup by founder name or by the
-- "резиденство:/громадянство: <країна>" marker inside founder_info (ILIKE and ~*).
-- founders is ~2.9M rows / ~860 MB on prod. The migration runner sends the file
-- as one query, so CONCURRENTLY is not possible here: on prod the index was built
-- by hand with CREATE INDEX CONCURRENTLY under this same name, and IF NOT EXISTS
-- makes this a no-op there. On a fresh database the table is small.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_founders_info_trgm
    ON founders USING gin (founder_info gin_trgm_ops);
