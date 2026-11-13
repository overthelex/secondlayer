-- 025: ProZorro contracts and winners (LEXAI-2227)
--
-- prozorro_tenders kept only the buyer side; winners and suppliers were
-- dropped by the importer, so "what did company X win" was not answerable.
-- One row per contract. The supplier comes from the contract itself (tenders
-- up to ~2024) or from the award the contract points to (the contracting
-- module stub since ~2025). Contact email/phone are kept because a shared
-- phone or email across "different" suppliers is a fictitious-firm marker.
-- The importers run the same DDL (CONTRACTS_DDL in scripts/lib/prozorro-feed.ts)
-- because migrations are not applied on container start.

CREATE TABLE IF NOT EXISTS prozorro_contracts (
  contract_id          TEXT PRIMARY KEY,
  tender_id            TEXT NOT NULL,
  contract_number      TEXT,
  contract_ua_id       TEXT,
  award_id             TEXT,
  lot_id               TEXT,
  status               TEXT,
  supplier_edrpou      TEXT,
  supplier_scheme      TEXT,
  supplier_name        TEXT,
  supplier_scale       TEXT,
  supplier_region      TEXT,
  supplier_locality    TEXT,
  supplier_address     TEXT,
  supplier_email       TEXT,
  supplier_phone       TEXT,
  supplier_count       SMALLINT,
  amount               NUMERIC(15,2),
  amount_net           NUMERIC(15,2),
  currency             TEXT,
  vat_included         BOOLEAN,
  date_signed          TIMESTAMPTZ,
  period_start         DATE,
  period_end           DATE,
  contract_date        TIMESTAMPTZ,
  tender_date_modified TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_tender   ON prozorro_contracts (tender_id);
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_supplier ON prozorro_contracts (supplier_edrpou) WHERE supplier_edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_email    ON prozorro_contracts (supplier_email) WHERE supplier_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_phone    ON prozorro_contracts (supplier_phone) WHERE supplier_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_signed   ON prozorro_contracts (date_signed);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_name_trgm ON prozorro_contracts USING gin (supplier_name gin_trgm_ops);
