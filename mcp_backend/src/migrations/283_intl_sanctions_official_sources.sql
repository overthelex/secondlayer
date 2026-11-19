-- Migration 283 (LEXAI-2299): EU, UK and US (OFAC) sanctions lists from the official publishers.
--
-- eu_sanctions (128) and us_ofac_sanctions (148) existed but were empty on the cthulhu prod: they
-- were filled on the AWS prod by hand-run loaders (mcp_backend/src/scripts/import-*-sanctions.ts,
-- reading files downloaded out of band) and were left out of the UA-slice copy. Nothing scheduled
-- them. scripts/sanctions/load_sanctions.py now downloads each list, upserts it as one snapshot and
-- removes entries the publisher has delisted; opendata-sync runs it daily.
--
-- Sources (none of them OpenSanctions, whose licence is CC BY-NC):
--   OFAC SDN + Consolidated (non-SDN)  sanctionslistservice.ofac.treas.gov  -> us_ofac_sanctions
--   UK Sanctions List (FCDO)           sanctionslist.fcdo.gov.uk            -> uk_sanctions (new)
--     The OFSI Consolidated List closed on 28.01.2026; the UK Sanctions List is the only UK list.
--   EU Financial Sanctions Files 1.1   webgate.ec.europa.eu/fsd/fsf          -> eu_sanctions
--     The URL carries a public token; the loader reads it from the data.europa.eu dataset record.

-- ─── Load journal ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS intl_sanctions_snapshots (
    list_name      TEXT NOT NULL,          -- ofac_sdn | ofac_consolidated | uk_fcdo | eu_fsf
    file_sha256    TEXT NOT NULL,
    snapshot_date  DATE,                   -- publication date stated in the file
    source_url     TEXT,                   -- download URL without access tokens
    file_size      BIGINT,
    rows_parsed    INTEGER,
    rows_upserted  INTEGER,
    rows_removed   INTEGER,
    loaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (list_name, file_sha256)
);
CREATE INDEX IF NOT EXISTS idx_intl_sanctions_snapshots_loaded
    ON intl_sanctions_snapshots(list_name, loaded_at DESC);

-- ─── US OFAC ───────────────────────────────────────────────────────────────
-- SDN and the Consolidated (non-SDN) list share the OFAC uid space, and 93 entries are on both
-- lists with different programmes, so the key becomes (uid, entry_type).
ALTER TABLE us_ofac_sanctions
    ADD COLUMN IF NOT EXISTS first_name      TEXT,
    ADD COLUMN IF NOT EXISTS last_name       TEXT,
    ADD COLUMN IF NOT EXISTS programs        TEXT[],
    ADD COLUMN IF NOT EXISTS dates_of_birth  JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS places_of_birth JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS nationalities   TEXT[],
    ADD COLUMN IF NOT EXISTS citizenships    TEXT[],
    ADD COLUMN IF NOT EXISTS snapshot_date   DATE,
    ADD COLUMN IF NOT EXISTS source_url      TEXT,
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();

DO $$
DECLARE
    pk_name TEXT;
    pk_cols TEXT;
BEGIN
    SELECT c.conname, string_agg(a.attname, ',' ORDER BY a.attnum)
      INTO pk_name, pk_cols
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'us_ofac_sanctions'::regclass AND c.contype = 'p'
     GROUP BY c.conname;
    IF pk_cols IS DISTINCT FROM 'uid,entry_type' THEN
        IF pk_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE us_ofac_sanctions DROP CONSTRAINT %I', pk_name);
        END IF;
        ALTER TABLE us_ofac_sanctions ADD CONSTRAINT us_ofac_sanctions_pkey PRIMARY KEY (uid, entry_type);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_us_ofac_uid ON us_ofac_sanctions(uid);
CREATE INDEX IF NOT EXISTS idx_us_ofac_programs ON us_ofac_sanctions USING GIN (programs);

-- ─── EU FSF ────────────────────────────────────────────────────────────────
ALTER TABLE eu_sanctions
    ADD COLUMN IF NOT EXISTS eu_reference_number TEXT,
    ADD COLUMN IF NOT EXISTS un_reference_number TEXT,
    ADD COLUMN IF NOT EXISTS regulations         JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS snapshot_date       DATE,
    ADD COLUMN IF NOT EXISTS source_url          TEXT;

CREATE INDEX IF NOT EXISTS idx_eu_sanctions_euref ON eu_sanctions(eu_reference_number);
CREATE INDEX IF NOT EXISTS idx_eu_sanctions_aliases ON eu_sanctions USING GIN (name_aliases);

-- ─── UK Sanctions List (FCDO) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS uk_sanctions (
    unique_id             TEXT PRIMARY KEY,     -- e.g. RUS0001
    ofsi_group_id         TEXT,
    un_reference_number   TEXT,
    entity_type           TEXT NOT NULL,        -- Individual | Entity | Ship
    name                  TEXT NOT NULL,        -- primary name
    name_aliases          TEXT[],               -- every other name, non-Latin scripts included
    names                 JSONB DEFAULT '[]',   -- [{name, type, strength}]
    non_latin_names       JSONB DEFAULT '[]',   -- [{name, script, language}]
    regime_name           TEXT,
    designation_source    TEXT,                 -- UK | UN
    sanctions_imposed     TEXT,
    sanctions_indicators  JSONB,                -- {AssetFreeze: true, TravelBan: false, ...}
    date_designated       DATE,
    last_updated          DATE,
    dates_of_birth        TEXT[],               -- as published, e.g. 'dd/mm/1945'
    birth_places          JSONB DEFAULT '[]',   -- [{town, country}]
    nationalities         TEXT[],
    genders               TEXT[],
    positions             TEXT[],
    titles                TEXT[],
    addresses             JSONB DEFAULT '[]',
    identifications       JSONB DEFAULT '[]',   -- passports, national ids, registration numbers, IMO
    contacts              JSONB,                -- {phones, emails, websites}
    entity_details        JSONB,                -- types, parent companies, subsidiaries
    ship_details          JSONB,
    other_information     TEXT,
    statement_of_reasons  TEXT,
    snapshot_date         DATE,
    source_url            TEXT,
    imported_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uk_sanctions_type ON uk_sanctions(entity_type);
CREATE INDEX IF NOT EXISTS idx_uk_sanctions_regime ON uk_sanctions(regime_name);
CREATE INDEX IF NOT EXISTS idx_uk_sanctions_designated ON uk_sanctions(date_designated);
CREATE INDEX IF NOT EXISTS idx_uk_sanctions_ofsi_group ON uk_sanctions(ofsi_group_id);
CREATE INDEX IF NOT EXISTS idx_uk_sanctions_aliases ON uk_sanctions USING GIN (name_aliases);
CREATE INDEX IF NOT EXISTS idx_uk_sanctions_fts ON uk_sanctions
    USING GIN (to_tsvector('simple', coalesce(name, '')));
