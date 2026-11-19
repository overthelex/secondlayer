-- Migration 286 (LEXAI-2298): ДПС licence registers (alcohol, tobacco, e-cigarette liquids, fuel)
-- from data.gov.ua (publisher «Державна податкова служба України», organization `tax`).
--
-- Each data.gov.ua resource (one CSV) is a full snapshot of one register as of the date in its
-- file name (e.g. register4-3_2022-02-23.csv) or, for the undated files, as of its last CKAN
-- modification. scripts/dps-licences/load_dps_licences.py loads one resource per transaction:
-- it replaces that resource's rows in dps_licences and journals the file in dps_licence_snapshots
-- (sha256, snapshot date, source URL). A file already journalled is skipped.
--
-- Licensees: a legal entity comes with its ЄДРПОУ (8 digits, zero-padded). For a ФОП the
-- register publishes «*» in place of the РНОКПП; only the name is stored, never an ID number.
--
-- The registers stopped being updated after 23.02.2022 (martial law) and are marked «Більше не
-- оновлюється» since КМУ resolution No 1151 of 10.09.2025 / Law No 3817-IX, so the table is a
-- historical view: licence periods tell whether a licence was valid at a given date.

CREATE TABLE IF NOT EXISTS dps_licence_snapshots (
    resource_id    TEXT NOT NULL,          -- CKAN resource id (or file:<name> for a local file)
    file_sha256    TEXT NOT NULL,
    dataset_id     TEXT,                   -- CKAN package id at load time (ids move; kept for audit)
    register_code  TEXT NOT NULL,          -- e.g. 'register4-3', 'ecig_retail'
    file_name      TEXT,
    snapshot_date  DATE,                   -- date in the file name, else CKAN last_modified
    source_url     TEXT,
    file_size      BIGINT,
    encoding       TEXT,                   -- utf-8 | cp1251
    rows_parsed    INTEGER,
    rows_skipped   INTEGER,
    rows_loaded    INTEGER,
    rows_removed   INTEGER,
    loaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (resource_id, file_sha256)
);
CREATE INDEX IF NOT EXISTS idx_dps_licence_snapshots_loaded
    ON dps_licence_snapshots (resource_id, loaded_at DESC);

CREATE TABLE IF NOT EXISTS dps_licences (
    id                   BIGSERIAL PRIMARY KEY,
    resource_id          TEXT NOT NULL,    -- the snapshot (resource) this row belongs to
    row_no               INTEGER NOT NULL, -- 1-based data row in that file
    register_code        TEXT NOT NULL,
    licence_type         TEXT NOT NULL,    -- вид діяльності (VDNM) or the register's own type
    licence_category     TEXT,             -- alcohol | cider_perry | tobacco | ecig_liquid | fuel | spirit | other
    activity             TEXT,             -- production | wholesale | retail | storage | other
    licence_number       TEXT,             -- as published, without the leading «№»
    edrpou               CHAR(8),          -- legal entities only; NULL for ФОП and masked codes
    licensee_type        TEXT NOT NULL,    -- legal_entity | fop | unknown
    licensee_name        TEXT NOT NULL,
    premises_address     TEXT,             -- місце торгівлі / зберігання / виробництва, raw
    premises_address_norm TEXT,            -- upper-cased, punctuation and spaces collapsed (joins)
    licensing_authority  TEXT,
    licensing_authority_address TEXT,
    valid_from           DATE,
    valid_to             DATE,
    status               TEXT,             -- as published, when the register has the column
    revocation_date      DATE,
    revocation_reason    TEXT,
    snapshot_date        DATE,
    source_url           TEXT,
    loaded_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (resource_id, row_no)
);

CREATE INDEX IF NOT EXISTS idx_dps_licences_edrpou
    ON dps_licences (edrpou) WHERE edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dps_licences_address_norm
    ON dps_licences (premises_address_norm) WHERE premises_address_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dps_licences_number
    ON dps_licences (licence_number);
CREATE INDEX IF NOT EXISTS idx_dps_licences_register
    ON dps_licences (register_code, valid_to);

COMMENT ON TABLE dps_licences IS
    'ДПС licence registers from data.gov.ua (LEXAI-2298); one row per register row per snapshot '
    '(resource). ФОП licensees: name only (the register masks the РНОКПП). Loaded by '
    'scripts/dps-licences/load_dps_licences.py.';
COMMENT ON COLUMN dps_licences.premises_address_norm IS
    'Normalised premises address for "same address" joins; not a geocoded address.';
