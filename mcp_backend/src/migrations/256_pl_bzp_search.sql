-- Full-text search over the buyer and subject of BZP notices, for pl_search_procurement.
-- On pg-lawrider the index was built by hand with CREATE INDEX CONCURRENTLY, because this table
-- holds 2.9M rows; IF NOT EXISTS makes this a no-op there.
CREATE INDEX IF NOT EXISTS idx_pl_bzp_fts ON pl_bzp_notices
  USING gin (to_tsvector('simple'::regconfig, coalesce(organization_name, '') || ' ' || coalesce(order_object, '')));
