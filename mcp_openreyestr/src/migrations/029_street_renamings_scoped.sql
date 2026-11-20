-- Migration 029: street renamings scoped to a settlement (LEXAI-2309)
-- One row: within settlement_key (graph-norm renamingSettlementKey: settlementKeyOf, a village's
-- postcode cut to three digits), the street old_street_key is now
-- current_street_key. Keys are '<street-type short>|<streetCoreKey>' ('вул|ленина'); the name
-- samples are '<street type> <name>' ('вулиця леніна') and are what the runtime index parses.
-- source: 'edr_history' (scripts/derive-street-renamings.ts), 'osm', 'manual'.

CREATE TABLE IF NOT EXISTS street_renamings_scoped (
    settlement_key      TEXT NOT NULL,
    old_street_key      TEXT NOT NULL,
    old_name_sample     TEXT NOT NULL,
    current_street_key  TEXT NOT NULL,
    current_name_sample TEXT NOT NULL,
    companies           INTEGER NOT NULL DEFAULT 0,
    buildings           INTEGER NOT NULL DEFAULT 0,
    first_seen          DATE,
    last_seen           DATE,
    source              TEXT NOT NULL,
    derived_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (settlement_key, old_street_key, source)
);

DO $$ BEGIN
    ALTER TABLE street_renamings_scoped
        ADD CONSTRAINT street_renamings_scoped_source_check CHECK (source IN ('edr_history', 'osm', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_street_renamings_scoped_current
    ON street_renamings_scoped (settlement_key, current_street_key);
