-- UAE federal legislation, harvested from uaelegislation.gov.ae.
-- Text comes from OCR: the portal's PDFs ship fonts with broken ToUnicode maps,
-- so the embedded text layer loses glyphs and reorders lam-alef ligatures.
CREATE TABLE IF NOT EXISTS ae_legislation (
    doc_id          text PRIMARY KEY,      -- uaeleg:<portal id>
    jurisdiction    text,
    law_id          integer,
    title           text,
    law_type        text,                  -- federal_law | federal_decree_law | cabinet_resolution | ...
    law_number      text,
    law_year        integer,
    language        text,
    full_text       text,
    text_source     text,                  -- ocr
    source_url      text,
    pdf_url         text,
    content_sha256  text,
    metadata_json   jsonb,
    imported_at     timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ae_leg_year      ON ae_legislation (law_year);
CREATE INDEX IF NOT EXISTS idx_ae_leg_type      ON ae_legislation (law_type);
CREATE INDEX IF NOT EXISTS idx_ae_leg_lawid     ON ae_legislation (law_id);
CREATE INDEX IF NOT EXISTS idx_ae_leg_title_trgm ON ae_legislation USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ae_leg_meta      ON ae_legislation USING gin (metadata_json jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_ae_leg_fts_ar    ON ae_legislation
    USING gin (to_tsvector('arabic', COALESCE(title,'') || ' ' || COALESCE(full_text,'')))
    WHERE full_text IS NOT NULL;
COMMENT ON TABLE ae_legislation IS 'UAE federal legislation (uaelegislation.gov.ae); full_text is OCR - the portal PDFs have an unusable text layer';
