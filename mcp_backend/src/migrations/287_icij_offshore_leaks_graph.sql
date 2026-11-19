-- Migration 287: ICIJ Offshore Leaks database as one node/edge graph (LEXAI-2300)
--
-- Source: https://offshoreleaks-data.icij.org/offshoreleaks/csv/full-oldb.LATEST.zip
-- (nodes-entities, nodes-officers, nodes-intermediaries, nodes-addresses, nodes-others, relationships).
-- Licence: the database is under the Open Database License 1.0, its contents under CC BY-SA 3.0;
-- ICIJ must be cited. ICIJ disclaimer: inclusion of a person or entity does not suggest or imply
-- illegal or improper conduct; many people and entities share names.
--
-- Loaded by scripts/icij/load_icij.py (opendata-sync, monthly; an unchanged archive is skipped).
--
-- What already exists: migration 129 created icij_entities / icij_officers / icij_intermediaries /
-- icij_addresses and icij_relationships. Nothing in the repository loads or reads them; the
-- legal.org.ua database holds a hand load from 16.04.2026. This migration:
--   * adds icij_nodes — every node type in one table, so a graph walk does not need to know which
--     of five tables a node_id lives in (1,139 node_ids are both an officer and an intermediary,
--     hence the key (node_id, node_type)). nodes-others had no table before.
--   * reuses icij_relationships, dropping UNIQUE (node_id_start, node_id_end, rel_type): the
--     archive has 437,545 edges that repeat a triple with a different link/dates (e.g. one officer
--     both «director of» and «shareholder of» the same entity), and the constraint threw them away.
--   * leaves the four per-type node tables of 129 alone (superseded, no reader; dropping them is a
--     separate decision).

-- ─── Load journal ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS icij_snapshots (
    id              SERIAL PRIMARY KEY,
    file_sha256     TEXT NOT NULL UNIQUE,
    source_url      TEXT NOT NULL,
    etag            TEXT,
    last_modified   TEXT,
    file_size       BIGINT,
    generated_on    DATE,              -- from the archive's GENERATED_ON_YYYYMMDD.txt marker
    rows_parsed     JSONB,             -- {"nodes-entities.csv": 814344, ...}
    nodes_loaded    BIGINT,
    relationships_loaded BIGINT,
    loaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Nodes ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS icij_nodes (
    node_id                  TEXT NOT NULL,
    node_type                TEXT NOT NULL CHECK (node_type IN ('entity', 'officer', 'intermediary', 'address', 'other')),
    name                     TEXT,
    name_key                 TEXT,       -- lower-case, diacritics and punctuation stripped (loader)
    original_name            TEXT,
    former_name              TEXT,
    jurisdiction             TEXT,       -- ICIJ jurisdiction code as published (e.g. SAM, BVI, AW)
    jurisdiction_description TEXT,
    country_codes            TEXT[],     -- ISO 3166-1 alpha-3, split on ';'
    countries                TEXT[],
    company_type             TEXT,
    status                   TEXT,
    service_provider         TEXT,
    incorporation_date       DATE,
    inactivation_date        DATE,
    struck_off_date          DATE,
    address                  TEXT,
    source_id                TEXT,       -- sourceID as published, e.g. 'Paradise Papers - Appleby'
    source_leak              TEXT,       -- Panama Papers / Paradise Papers / Pandora Papers / Offshore Leaks / Bahamas Leaks
    valid_until              TEXT,
    note                     TEXT,
    extra                    JSONB,      -- remaining columns and unparsed date strings
    snapshot_id              INTEGER REFERENCES icij_snapshots(id),
    PRIMARY KEY (node_id, node_type)
);

CREATE INDEX IF NOT EXISTS idx_icij_nodes_name_key_trgm ON icij_nodes USING gin (name_key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_icij_nodes_name_key ON icij_nodes (name_key);
CREATE INDEX IF NOT EXISTS idx_icij_nodes_country ON icij_nodes USING gin (country_codes);
CREATE INDEX IF NOT EXISTS idx_icij_nodes_jurisdiction ON icij_nodes (jurisdiction);
CREATE INDEX IF NOT EXISTS idx_icij_nodes_node_id ON icij_nodes (node_id);

-- ─── Relationships (table from migration 129) ────────────────────────────
CREATE TABLE IF NOT EXISTS icij_relationships (
    id SERIAL PRIMARY KEY,
    node_id_start TEXT NOT NULL,
    node_id_end TEXT NOT NULL,
    rel_type TEXT,
    link TEXT,
    start_date DATE,
    end_date DATE,
    source_id TEXT,
    metadata_json JSONB,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE icij_relationships DROP CONSTRAINT IF EXISTS icij_relationships_node_id_start_node_id_end_rel_type_key;
ALTER TABLE icij_relationships ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE icij_relationships ADD COLUMN IF NOT EXISTS source_leak TEXT;
ALTER TABLE icij_relationships ADD COLUMN IF NOT EXISTS snapshot_id INTEGER REFERENCES icij_snapshots(id);

CREATE INDEX IF NOT EXISTS idx_icij_rel_start ON icij_relationships(node_id_start);
CREATE INDEX IF NOT EXISTS idx_icij_rel_end ON icij_relationships(node_id_end);
CREATE INDEX IF NOT EXISTS idx_icij_rel_type ON icij_relationships(rel_type);

COMMENT ON TABLE icij_nodes IS
  'ICIJ Offshore Leaks Database (ODbL 1.0; contents CC BY-SA 3.0; cite ICIJ). Inclusion does not imply wrongdoing.';
COMMENT ON TABLE icij_relationships IS
  'ICIJ Offshore Leaks edges (ODbL 1.0; contents CC BY-SA 3.0; cite ICIJ). Ends join icij_nodes.node_id.';
