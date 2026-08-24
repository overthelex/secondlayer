-- Migration 196: bookkeeping for the UK Changes to Legislation crawl
--
-- Stage 4 fills uk_legislation_effects (migration 195) from
-- /changes/affected/{type}/{year}/data.feed. Unlike stages 2 and 3, the worklist
-- cannot be derived from the rows it produces: an effect carries the affected
-- YEAR and CLASS, never the leg_type of the register, and a (type, year) scope
-- that legitimately holds zero effects is indistinguishable from one that was
-- never fetched. So the scope itself is the unit of progress and needs a row.
--
-- Measured on the live API 2026-08-24, and the reason this is partitioned at all:
--   * /changes/data.feed          -> 504 Gateway Time-out, every page size tried
--   * /changes/affected/ukpga/data.feed
--                                 -> HTTP 200, but totalResults comes back 523,791,
--                                    the GLOBAL figure. Type-level scoping is
--                                    silently ignored by the source; do not use it.
--   * /changes/affected/ukpga/2006/data.feed
--                                 -> HTTP 200, totalResults 22,656, and all 200
--                                    entries on page 1 carry AffectedYear="2006"
--                                    and AffectedClass="UnitedKingdomPublicGeneralAct".
--                                    Year-level scoping is the coarsest one that works.
-- 893 distinct (leg_type, year) pairs exist in uk_legislation, so that is the
-- worklist. results-count=200 is honoured (200 entries, 504 KB) and rel="next"
-- pages with &page=N.
--
-- total_results is stored so a later run can tell a scope that grew from one that
-- was merely re-fetched, and last_modified is the incremental key: the feed sorts
-- by modified, so a refresh can stop early once it reaches a known timestamp.
CREATE TABLE IF NOT EXISTS uk_legislation_effect_scopes (
    leg_type      TEXT NOT NULL,
    year          INTEGER NOT NULL,
    pages         INTEGER NOT NULL DEFAULT 0,
    entries       INTEGER NOT NULL DEFAULT 0,
    total_results INTEGER,
    -- npa.* verdict convention, same as stages 2-3: an HTTP status, or a code above
    -- the HTTP range for a fetch that returned 200 but is unusable.
    --   900 = empty body   901 = 200 but not an Atom feed   599 = gave up retrying
    http_status   INTEGER,
    last_modified TIMESTAMPTZ,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (leg_type, year)
);

CREATE INDEX IF NOT EXISTS idx_uk_eff_scope_bad ON uk_legislation_effect_scopes (leg_type, year)
    WHERE http_status IS DISTINCT FROM 200;
