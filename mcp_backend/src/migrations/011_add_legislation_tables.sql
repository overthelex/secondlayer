-- DUMMY MIGRATION: Legislation tables creation
-- This migration is intentionally empty because migration 012 handles all legislation schema setup.
-- The legislation and legislation_articles tables are created/updated by migration 012 with the correct schema.
--
-- This migration is kept for backwards compatibility with existing deployments that may have
-- already run it partially. New deployments should rely on migration 012 for the complete schema.

-- No-op to ensure migration is marked as completed
SELECT 1;
