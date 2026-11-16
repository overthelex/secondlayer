-- Migration 276: /zakon now publishes 100 laws next to the 13 codes (PR #2753), and the
-- Grand Chamber and cassation refreshes now link decisions to articles of all of them.
-- Clear the "articles checked" marks once so existing decisions are re-linked on the
-- next refresh (inserts are ON CONFLICT DO NOTHING, so code links are not duplicated).

UPDATE seo_vp_decisions SET articles_checked_at = NULL WHERE articles_checked_at IS NOT NULL;
UPDATE seo_cassation_decisions SET articles_checked_at = NULL WHERE articles_checked_at IS NOT NULL;
