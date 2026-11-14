-- Migration 263: Grand Chamber (ВП ВС) decisions published as /pozytsiia-vs pages.
--
-- Filled daily by services/seo/vp-refresh.ts from edrsr_documents
-- (court_code 9951, judgment_code 2 = постанова) that have a full text.
-- The page shows the official ЄДРСР text only, nothing generated.

CREATE TABLE IF NOT EXISTS seo_vp_decisions (
  doc_id        bigint PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  cause_num     text NOT NULL,
  adj_date      date NOT NULL,        -- Kyiv date of adjudication
  ft_year       smallint NOT NULL,    -- edrsr_fulltext partition holding the text
  judge         text,
  category_code integer,
  text_length   integer,
  articles_checked_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_vp_adj_date ON seo_vp_decisions (adj_date DESC);

-- Code articles a decision applies (from legislation_citation_links), limited to the /zakon codes.
CREATE TABLE IF NOT EXISTS seo_vp_articles (
  doc_id  bigint NOT NULL REFERENCES seo_vp_decisions (doc_id) ON DELETE CASCADE,
  nreg    text   NOT NULL,
  art_no  text   NOT NULL,
  PRIMARY KEY (doc_id, nreg, art_no)
);
CREATE INDEX IF NOT EXISTS idx_seo_vp_articles_art ON seo_vp_articles (nreg, art_no);
