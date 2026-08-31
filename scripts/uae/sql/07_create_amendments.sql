\set ON_ERROR_STOP on

-- Publication and status facts the downloadable PDFs never carried.
ALTER TABLE ae_legislation ADD COLUMN IF NOT EXISTS issue_date date;
ALTER TABLE ae_legislation ADD COLUMN IF NOT EXISTS effective_date date;
ALTER TABLE ae_legislation ADD COLUMN IF NOT EXISTS gazette_date date;
ALTER TABLE ae_legislation ADD COLUMN IF NOT EXISTS gazette_number text;
ALTER TABLE ae_legislation ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE ae_legislation ADD COLUMN IF NOT EXISTS status_ar text;
ALTER TABLE ae_legislation ADD COLUMN IF NOT EXISTS last_update date;
ALTER TABLE ae_legislation ADD COLUMN IF NOT EXISTS amendments_count int;

CREATE INDEX IF NOT EXISTS idx_ae_leg_status ON ae_legislation (status);
CREATE INDEX IF NOT EXISTS idx_ae_leg_issue_date ON ae_legislation (issue_date DESC);

-- One row per amending act, in the acts it amends.
CREATE TABLE IF NOT EXISTS ae_legislation_amendments (
    amendment_id     text PRIMARY KEY,
    law_id           int NOT NULL,
    modification_id  int,
    amend_date       date,
    amend_year       int,
    amend_date_raw   text,
    amending_title   text,
    amending_law_id  int,          -- resolved against ae_legislation where possible
    amending_pdf_url text,
    articles_changed int,
    imported_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ae_amend_law ON ae_legislation_amendments (law_id, amend_date);
CREATE INDEX IF NOT EXISTS idx_ae_amend_date ON ae_legislation_amendments (amend_date DESC);
CREATE INDEX IF NOT EXISTS idx_ae_amend_source_law ON ae_legislation_amendments (amending_law_id);

-- One row per article an amendment touched: the new text beside the old one.
CREATE TABLE IF NOT EXISTS ae_legislation_article_changes (
    change_id         text PRIMARY KEY,
    amendment_id      text NOT NULL REFERENCES ae_legislation_amendments(amendment_id)
                          ON DELETE CASCADE,
    law_id            int NOT NULL,
    seq               int,
    article_label     text,
    article_no        text,
    new_text          text,
    previous_text     text,
    new_sha256        text,
    previous_sha256   text,
    previous_versions int,
    text_changed      boolean,
    imported_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ae_change_law_article
    ON ae_legislation_article_changes (law_id, article_no);
CREATE INDEX IF NOT EXISTS idx_ae_change_amendment
    ON ae_legislation_article_changes (amendment_id);
CREATE INDEX IF NOT EXISTS idx_ae_change_fts_ar
    ON ae_legislation_article_changes
    USING gin (to_tsvector('arabic', coalesce(new_text, '')))
    WHERE new_text IS NOT NULL;

-- What each article looks like now and what it looked like before, in one place.
CREATE OR REPLACE VIEW ae_legislation_article_history AS
SELECT c.law_id,
       l.title           AS law_title,
       c.article_no,
       c.article_label,
       a.amend_date,
       a.amending_title,
       c.previous_text   AS text_before,
       c.new_text        AS text_after,
       c.text_changed
FROM ae_legislation_article_changes c
JOIN ae_legislation_amendments a USING (amendment_id)
LEFT JOIN ae_legislation l ON l.law_id = c.law_id
ORDER BY c.law_id, c.article_no, a.amend_date;
