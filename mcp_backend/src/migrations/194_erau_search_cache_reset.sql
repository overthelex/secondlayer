-- Migration 194: discard ERAU search results captured by the first pagination attempt
--
-- Migration 193 shipped alongside a proxy that read the registry's `total` only when it
-- arrived as a JSON number. ERAU reports it as a string ("291"), so the count collapsed
-- to zero, paging stopped after the first page, and searches were cached holding 200
-- rows instead of the full set. Those entries carry a 24-hour TTL, so without this they
-- would outlive the fix by a day.

TRUNCATE TABLE erau_search_cache;
