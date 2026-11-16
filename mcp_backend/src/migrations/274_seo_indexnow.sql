-- Migration 274: URLs already announced to IndexNow (Bing, Yandex, Seznam, Naver).
--
-- Filled daily by services/seo/indexnow.ts, which walks https://legal.org.ua/sitemap.xml
-- and submits only URLs that are new or whose <lastmod> changed since the last submission.

CREATE TABLE IF NOT EXISTS seo_indexnow (
  url          text PRIMARY KEY,
  lastmod      text,
  submitted_at timestamptz NOT NULL DEFAULT now()
);
