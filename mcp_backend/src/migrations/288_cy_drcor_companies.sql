-- Migration 288 (LEXAI-2301): Cyprus register of companies, business names and partnerships
-- (Department of Registrar of Companies and Intellectual Property, DRCOR) from data.gov.cy.
--
-- Source: https://www.data.gov.cy/en/dataset/1026 «Μητρώο Εγγεγραμμένων Εταιρειών, Εμπορικών
-- Επωνυμιών και Συνεταιρισμών στην Κύπρο», CC BY 4.0, updated monthly (dct:accrualPeriodicity
-- R/P1M). Three CSV resources (UTF-8 with BOM, CRLF), whose file names change on every update
-- (organisations_103.csv, ...), so scripts/cyprus/load_drcor.py reads them from the DCAT-AP record:
--   organisations          -> cy_companies           (one row per organisation, last name only)
--   registered_office      -> cy_registered_offices  (ADDRESS_SEQ_NO -> street / building / territory)
--   organisation_officials -> cy_officials           (directors, secretaries, owners, partners ...)
-- Officials carry only the name and the position: no dates of appointment, nationality, address or
-- identifiers. Shareholders and beneficial owners are not published.
--
-- Organisation type codes: C Εταιρεία (company, «HE» number), O Αλλοδαπή Εταιρεία (overseas company,
-- «AE»), B Εμπορική Επωνυμία (business name), P Συνεταιρισμός (partnership), N Συνεταιρισμός (BN)
-- (partnership in the old BN register). Registration numbers repeat across types, so the key is
-- (org_type_code, registration_no). registration_code is the Latin «HE123456» / «AE1234» form used to
-- match non-resident founders in ЄДР; it is set for C and O only.
--
-- Each monthly file replaces its table in one transaction; a row is rewritten only when its content
-- changed, so snapshot_date / source_url on a row name the snapshot that last changed it
-- (cy_drcor_snapshots journals every file loaded).

-- ─── Load journal ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cy_drcor_snapshots (
    resource       TEXT NOT NULL,          -- organisations | registered_office | organisation_officials
    file_sha256    TEXT NOT NULL,
    snapshot_date  DATE,                   -- Last-Modified of the published file
    source_url     TEXT,
    file_size      BIGINT,
    rows_parsed    INTEGER,                -- data rows accepted by the parser
    rows_rejected  INTEGER,                -- rows the parser could not repair (no key)
    rows_upserted  INTEGER,
    rows_removed   INTEGER,
    loaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (resource, file_sha256)
);
CREATE INDEX IF NOT EXISTS idx_cy_drcor_snapshots_loaded
    ON cy_drcor_snapshots(resource, loaded_at DESC);

-- ─── Organisations ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cy_companies (
    org_type_code      TEXT NOT NULL,      -- C | O | B | P | N
    registration_no    TEXT NOT NULL,      -- digits as published, no prefix
    registration_code  TEXT,               -- HE<no> for C, AE<no> for O
    name               TEXT NOT NULL,
    org_type           TEXT,               -- Greek label, e.g. Εταιρεία
    org_sub_type       TEXT,               -- Ιδιωτική, Δημόσια, Ομόρρυθμος ...
    name_status_code   TEXT,
    name_status        TEXT,
    registration_date  DATE,
    status             TEXT,               -- Εγγεγραμμένη, Διαγραμμένη, ...
    status_date        DATE,
    address_seq_no     BIGINT,             -- cy_registered_offices.address_seq_no
    snapshot_date      DATE,
    source_url         TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_type_code, registration_no)
);
CREATE INDEX IF NOT EXISTS idx_cy_companies_registration_code
    ON cy_companies(registration_code) WHERE registration_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cy_companies_registration_no ON cy_companies(registration_no);
CREATE INDEX IF NOT EXISTS idx_cy_companies_name_upper ON cy_companies(upper(name));
CREATE INDEX IF NOT EXISTS idx_cy_companies_name_trgm ON cy_companies USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cy_companies_address ON cy_companies(address_seq_no);

-- ─── Registered offices ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cy_registered_offices (
    address_seq_no  BIGINT PRIMARY KEY,
    street          TEXT,
    building        TEXT,
    territory       TEXT,                  -- postcode, area, district, «Κύπρος»
    snapshot_date   DATE,
    source_url      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Officials ─────────────────────────────────────────────────────────────
-- The file repeats some (organisation, person, position) lines verbatim; they are stored once with
-- the number of repeats in occurrences. position is '' when the file leaves it empty.
CREATE TABLE IF NOT EXISTS cy_officials (
    org_type_code    TEXT NOT NULL,
    registration_no  TEXT NOT NULL,
    person_name      TEXT NOT NULL,        -- natural person or corporate official
    position         TEXT NOT NULL DEFAULT '',  -- Διευθυντής, Γραμματέας, Ιδιοκτήτης, ...
    organisation_name TEXT,
    occurrences      INTEGER NOT NULL DEFAULT 1,
    snapshot_date    DATE,
    source_url       TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_type_code, registration_no, person_name, position)
);
CREATE INDEX IF NOT EXISTS idx_cy_officials_person_upper ON cy_officials(upper(person_name));
CREATE INDEX IF NOT EXISTS idx_cy_officials_person_trgm ON cy_officials USING gin (person_name gin_trgm_ops);

-- ─── Convenience view ──────────────────────────────────────────────────────
CREATE OR REPLACE VIEW cy_companies_with_address AS
SELECT c.*, o.street, o.building, o.territory
  FROM cy_companies c
  LEFT JOIN cy_registered_offices o ON o.address_seq_no = c.address_seq_no;

COMMENT ON TABLE cy_companies IS
    'Cyprus DRCOR register (data.gov.cy dataset 1026, CC BY 4.0), monthly; loaded by scripts/cyprus/load_drcor.py';
COMMENT ON TABLE cy_officials IS
    'Cyprus DRCOR officials: name + position only (no dates, nationality or identifiers); no shareholders';
