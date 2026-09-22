-- Text recovered from acts that exist only as scans, kept apart from the text
-- that came from the statute book.
--
-- 108,983 of 238,936 UK acts have no provision text: the CLML collections do
-- not carry them and the crawl cannot produce them, because at source they are
-- page images. The only way to make them searchable is to read the pictures.
--
-- Why this is not uk_legislation_provisions
-- -----------------------------------------
-- That table is the authoritative point-in-time text. Citations come out of it,
-- uk_provision_text_hash is a content map over it, and several invariants in
-- verify_uk_corpus.py are defined against it. OCR text cannot join that set.
-- Measured on Victorian type on 2026-09-22, the best configuration available
-- still misreads a two-line drop cap, mangles small caps in running headers,
-- and can turn 1886 into 1836 in ordinary body type without any drop in
-- reported confidence. Text that can silently corrupt a date is good enough to
-- find a document and not good enough to quote from one.
--
-- Keeping it in its own table makes that distinction structural rather than a
-- convention someone has to remember: a search can union both, and nothing that
-- builds a citation can reach this by accident.

CREATE TABLE IF NOT EXISTS uk_legislation_ocr (
  leg_id      text    NOT NULL REFERENCES uk_legislation(id) ON DELETE CASCADE,
  page_no     integer NOT NULL,
  -- 'text-layer' when the PDF already carried extractable text and no OCR ran;
  -- 'ocr' when the page was rasterised and read. Mixed documents are normal:
  -- roughly two thirds of the scanned-only backlog has a text layer on at
  -- least some pages, and reading those costs nothing and loses nothing.
  source      text    NOT NULL CHECK (source IN ('text-layer', 'ocr')),
  text        text    NOT NULL,
  n_chars     integer NOT NULL,
  -- Tesseract's mean word confidence for the page. Recorded for triage, NOT
  -- used as a correctness filter: on the measured page a correct "1886" scored
  -- 96.6 while a correct "1884" scored 56.7, so any threshold produces false
  -- alarms without catching the real errors.
  mean_conf   real,
  -- Four-digit years on the page that cannot be right — later than the act
  -- itself, or before the statute book begins. Cheap and sound. It does NOT
  -- catch a slip to an earlier plausible year (1886 -> 1836); that needs a
  -- cross-check against the register and is deliberately not done here.
  bad_years   integer[],
  engine      text    NOT NULL,
  ocr_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (leg_id, page_no)
);

-- The whole point of the table. english, matching idx_uk_prov_fts, so a search
-- can pose one query against both and get comparable ranking.
CREATE INDEX IF NOT EXISTS idx_uk_ocr_fts
  ON uk_legislation_ocr USING gin (to_tsvector('english', text));

CREATE INDEX IF NOT EXISTS idx_uk_ocr_suspect
  ON uk_legislation_ocr (leg_id) WHERE bad_years IS NOT NULL;

-- One row per act attempted, so a 40-hour run can be stopped and resumed, and
-- so an act that has no PDF at all is recorded as answered rather than retried
-- on every pass. Mirrors uk_pit_load_state.
CREATE TABLE IF NOT EXISTS uk_ocr_state (
  leg_id        text    NOT NULL PRIMARY KEY REFERENCES uk_legislation(id) ON DELETE CASCADE,
  pdf_url       text,
  n_pages       integer,
  pages_ocr     integer NOT NULL DEFAULT 0,
  pages_text    integer NOT NULL DEFAULT 0,
  -- 200 when the act was read. Anything else is a fact about the attempt:
  -- 404 no PDF published, 903 the PDF would not rasterise, 900 the source
  -- refused us. An act with a non-200 verdict has no rows in the OCR table.
  http_status   integer,
  engine        text,
  ocr_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uk_ocr_state_bad
  ON uk_ocr_state (http_status) WHERE http_status IS NOT NULL AND http_status <> 200;
