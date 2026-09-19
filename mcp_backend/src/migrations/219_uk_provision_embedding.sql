-- 219: content-addressing for UK provision text, so it can be embedded once per
-- distinct wording rather than once per row.
--
-- Measured on the corpus before any of it was embedded (19 Sep 2026):
--
--     rows in uk_legislation_provisions          1,775,894
--     repealed markers ". . . . ."                 260,892   14.7%
--     shorter than 30 characters                    ~20,000
--     exact duplicates of another row              193,881   13.0% of the rest
--     DISTINCT TEXTS WORTH EMBEDDING             1,300,637   -27%
--
-- A single 63-character string — legislation.gov.uk's marker for repealed text —
-- accounts for 260,194 of those rows on its own. Embedded per row it would take
-- 15% of the budget and 15% of the index and come back as the nearest neighbour
-- to every short query. Keyed by content it is one vector, and the filter in
-- scripts/uk/08_export_provision_texts.py drops it.
--
-- Why a map table and not a text_hash column on uk_legislation_provisions:
-- that table carries a 705 MB GIN index over its full text, and adding a column
-- to 1.78M rows rewrites every one of them and thrashes the index. This is
-- insert-only and touches nothing that already exists.
--
-- The text is NOT copied. 1,320 MB of it already lives in
-- uk_legislation_provisions; the map points at it and the exporter joins.

-- Which provision carries which wording. One row per provision, so the same
-- text_hash appears as many times as that wording occurs in the statute book.
CREATE TABLE IF NOT EXISTS uk_provision_text_hash (
    leg_id     text    NOT NULL,
    valid_from date    NOT NULL,
    ord        integer NOT NULL,
    text_hash  bytea   NOT NULL,
    PRIMARY KEY (leg_id, valid_from, ord)
);

-- The lookup the search path needs: a vector hit is a hash, and the answer is
-- every provision that shares that wording.
CREATE INDEX IF NOT EXISTS idx_uk_pth_hash ON uk_provision_text_hash (text_hash);

-- What has been exported and embedded, so a run that dies halfway resumes
-- instead of re-embedding 1.3M texts. chunk_ord is 0 for a text that fits the
-- model's window and 0..n for one that had to be split — 16,732 texts are over
-- 6,000 characters and the largest is 284,369.
CREATE TABLE IF NOT EXISTS uk_embedding_state (
    text_hash   bytea       NOT NULL,
    chunk_ord   integer     NOT NULL DEFAULT 0,
    n_chars     integer     NOT NULL,
    model       text        NOT NULL DEFAULT 'bge-m3',
    exported_at timestamptz,
    embedded_at timestamptz,
    PRIMARY KEY (text_hash, chunk_ord, model)
);

CREATE INDEX IF NOT EXISTS idx_uk_embstate_pending
    ON uk_embedding_state (model) WHERE embedded_at IS NULL;
