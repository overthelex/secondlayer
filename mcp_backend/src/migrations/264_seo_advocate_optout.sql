-- Migration 264: advocates who asked for their public /advokat page to be removed.
-- A row here hides the profile (404 + noindex) and drops it from lists and the sitemap.
CREATE TABLE IF NOT EXISTS seo_advocate_optout (
  source_id  text PRIMARY KEY,          -- opendata_advocates.source_id (ЄРАУ id)
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
