-- Migration 262: precomputed data for the public /sud and /suddia SEO pages.
--
-- Per-court and per-judge decision counts are aggregated from the
-- edrsr_documents partitions by services/seo/courts-refresh.ts (daily cron),
-- because counting on page request takes seconds for a large court.
-- Slugs are generated once and stored: they are permanent URLs.

CREATE TABLE IF NOT EXISTS seo_court_stats (
  court_code     integer  NOT NULL,
  year           smallint NOT NULL,
  justice_kind   smallint NOT NULL DEFAULT 0,
  decisions      integer  NOT NULL,
  last_decision  date,
  PRIMARY KEY (court_code, year, justice_kind)
);

-- judge_key = lower("surname ІБ") built from the decision's judge field, so
-- "К.М. Недашківська" and "Недашківська К. М." land on the same key.
CREATE TABLE IF NOT EXISTS seo_judge_stats (
  court_code     integer  NOT NULL,
  judge_key      text     NOT NULL,
  year           smallint NOT NULL,
  justice_kind   smallint NOT NULL DEFAULT 0,
  decisions      integer  NOT NULL,
  PRIMARY KEY (court_code, judge_key, year, justice_kind)
);
CREATE INDEX IF NOT EXISTS idx_seo_judge_stats_key ON seo_judge_stats (judge_key);

-- Which partition years are final (aggregated after the year ended).
CREATE TABLE IF NOT EXISTS seo_stats_years (
  year         smallint PRIMARY KEY,
  final        boolean NOT NULL DEFAULT false,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seo_courts (
  court_code  integer PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seo_judges (
  dossier_number varchar(50) PRIMARY KEY,
  slug           text NOT NULL UNIQUE,
  court_code     integer,            -- current court, resolved by the refresh job
  judge_key      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_judges_court ON seo_judges (court_code);

-- "К.М. Недашківська" | "Недашківська К. М." | "Недашківська Катерина Миколаївна"
--   → "недашківська км". NULL for anything else (several judges in one field, etc.).
CREATE OR REPLACE FUNCTION seo_judge_key(name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(CASE
    WHEN n ~ '^(\S)\.\s*(\S)\.\s*(\S+)$' THEN regexp_replace(n, '^(\S)\.\s*(\S)\.\s*(\S+)$', '\3 \1\2')
    WHEN n ~ '^(\S+)\s+(\S)\.\s*(\S)\.?$' THEN regexp_replace(n, '^(\S+)\s+(\S)\.\s*(\S)\.?$', '\1 \2\3')
    WHEN n ~ '^(\S+)\s+(\S)\S+\s+(\S)\S+$' THEN regexp_replace(n, '^(\S+)\s+(\S)\S+\s+(\S)\S+$', '\1 \2\3')
  END)
  FROM (SELECT btrim(regexp_replace(replace(replace(coalesce(name, ''), '’', ''''), 'ʼ', ''''), '\s+', ' ', 'g')) AS n) t
$$;

-- Court name as judges_current and edrsr_courts can both be reduced to:
-- "міста" → "м.", region suffix of a city court dropped, apostrophes unified.
CREATE OR REPLACE FUNCTION seo_court_norm(name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN n ~ ' м\. ' THEN regexp_replace(n, ' \S+ області$', '') ELSE n END
  FROM (SELECT btrim(regexp_replace(replace(replace(replace(lower(coalesce(name, '')), 'міста ', 'м. '), '’', ''''), 'ʼ', ''''), '\s+', ' ', 'g')) AS n) t
$$;
