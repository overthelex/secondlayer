-- Small Polish open-data files (spreadsheets and CSVs) for lawrider.pl.
--
-- Each source is a full snapshot published as a file: the bailiff list
-- (dane.gov.pl 927, CC0), court contact data and court list (985, CC0), the
-- Council of Ministers legislative work list (gov.pl register CSV, CC BY),
-- and the MSWiA national sanctions list (gov.pl XLSX). A load replaces the
-- source's rows in one transaction; pl_opendata_loads keeps what was loaded,
-- from where, and the file hash, so a changed file is visible and an
-- unchanged one is skipped.
--
-- Rows are jsonb keyed by the file's own header text. Typed views per source
-- can come once tools need them.
--
-- Idempotent: scripts/pl/load_pl_files.py applies this file itself on start.

CREATE TABLE IF NOT EXISTS pl_opendata_rows (
    source      text        NOT NULL,
    sheet       text        NOT NULL DEFAULT '',
    row_no      integer     NOT NULL,
    data        jsonb       NOT NULL,
    source_url  text        NOT NULL,
    loaded_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, sheet, row_no)
);

CREATE INDEX IF NOT EXISTS idx_pl_opendata_rows_fts
    ON pl_opendata_rows USING gin (to_tsvector('simple', data::text));

CREATE TABLE IF NOT EXISTS pl_opendata_loads (
    source      text        NOT NULL,
    source_url  text        NOT NULL,
    published   text,                   -- the publisher's own date or title
    sha256      text        NOT NULL,
    rows        integer     NOT NULL,
    loaded_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, sha256)
);
