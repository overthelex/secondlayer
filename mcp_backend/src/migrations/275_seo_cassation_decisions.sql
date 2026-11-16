-- Migration 275: most-cited cassation decisions (КГС, КАС, КЦС, ККС ВС) published as /praktyka-vs pages.
--
-- Filled weekly by services/seo/cassation-refresh.ts: постанови (judgment_code 2) of courts
-- 9911/9921/9931/9941 with a full text, ranked by how many ЄДРСР decisions cite their case
-- (case_citation_links). The set is capped (SEO_CASSATION_CAP); published slugs are permanent.
-- The page shows the official ЄДРСР text only, nothing generated.

CREATE TABLE IF NOT EXISTS seo_cassation_decisions (
  doc_id        bigint PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  court_code    integer NOT NULL,
  cause_num     text NOT NULL,
  adj_date      date NOT NULL,        -- Kyiv date of adjudication
  ft_year       smallint NOT NULL,    -- edrsr_fulltext partition holding the text
  judge         text,
  category_code integer,
  text_length   integer,
  cited_by      integer NOT NULL DEFAULT 0,  -- distinct ЄДРСР decisions citing the case (not self)
  articles_checked_at timestamptz,
  links_checked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_cass_adj_date ON seo_cassation_decisions (adj_date DESC);
CREATE INDEX IF NOT EXISTS idx_seo_cass_cause ON seo_cassation_decisions (cause_num);
CREATE INDEX IF NOT EXISTS idx_seo_cass_cited ON seo_cassation_decisions (cited_by DESC);

-- Code articles a decision applies (from legislation_citation_links), limited to the /zakon codes.
CREATE TABLE IF NOT EXISTS seo_cassation_articles (
  doc_id  bigint NOT NULL REFERENCES seo_cassation_decisions (doc_id) ON DELETE CASCADE,
  nreg    text   NOT NULL,
  art_no  text   NOT NULL,
  PRIMARY KEY (doc_id, nreg, art_no)
);
CREATE INDEX IF NOT EXISTS idx_seo_cass_articles_art ON seo_cassation_articles (nreg, art_no);

-- Cases a published decision (cassation or Grand Chamber) cites, from case_citation_links.
-- Resolved to published pages at read time, so new pages pick up old links.
CREATE TABLE IF NOT EXISTS seo_cassation_links (
  from_doc_id bigint NOT NULL,
  to_cause    text   NOT NULL,
  PRIMARY KEY (from_doc_id, to_cause)
);
CREATE INDEX IF NOT EXISTS idx_seo_cass_links_to ON seo_cassation_links (to_cause);

-- Grand Chamber decisions whose outgoing citations have been loaded into seo_cassation_links.
ALTER TABLE seo_vp_decisions ADD COLUMN IF NOT EXISTS links_checked_at timestamptz;
