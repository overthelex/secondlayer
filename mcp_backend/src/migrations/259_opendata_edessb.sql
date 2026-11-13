-- 259_opendata_edessb.sql
--
-- ЄДЕССБ, Реєстр будівельної діяльності: декларативні та дозвільні документи
-- (повідомлення/дозволи на початок робіт, декларації про готовність,
-- сертифікати, зміни, скасування).
--
-- SOURCE. data.gov.ua package 5255ea7e-6f94-41e4-86eb-ad578aea853c
-- (Мінрозвитку), CC BY 4.0, attribution «Портал ЄДЕССБ». One zip per year,
-- each a JSON array with one record per line. On 13.11.2026 only 2021 and
-- 2026-01..11 exist, plus a 22.02.2022 snapshot (31.12.2021-22.02.2022);
-- 23.02.2022-2025 were requested from the ministry the same day.
-- Applied by hand on legal.org.ua prod (cthulhu) on 13.11.2026 and loaded:
-- 304 311 documents, 1.1 GB (idempotent, so the CI migrate run is a no-op).
-- Loader: scripts/opendata/edessb/import_edessb.py.
--
-- WHY THESE COLUMNS. The use case is checking a counterparty by ЄДРПОУ in any
-- role (customer, general contractor, designer, expertise, issuing body), so
-- every role gets its own scalar column with a btree index and search_registry
-- ORs them (exact_multi). Individuals are masked in the source
-- (ap_edrpou = '***…'), so customer_edrpou is NULL for them.
--
-- Measured coverage (13.11.2026, full files, records with a legal-entity
-- customer): contractor ЄДРПОУ 50% in 2021 but 8% in 2026; designer 82% in
-- both. Absence of a contractor row is therefore NOT evidence of no contractor.

CREATE TABLE IF NOT EXISTS opendata_edessb_documents (
  application_id     TEXT PRIMARY KEY,
  reg_date           DATE,
  service_id         TEXT,
  doc_type           TEXT,
  reg_status         SMALLINT,
  use_status         SMALLINT,
  status_label       TEXT,
  consequence_class  SMALLINT,
  code_dkbs          TEXT,
  build_type         TEXT,
  build_way          TEXT,
  object_name        TEXT,
  region             TEXT,
  gromada            TEXT,
  city               TEXT,
  address            TEXT,
  katottg_city       TEXT,
  lon                DOUBLE PRECISION,
  lat                DOUBLE PRECISION,
  land_number        TEXT,
  land_numbers       TEXT[],
  customer_type      TEXT,
  customer_edrpou    TEXT,
  customer_name      TEXT,
  contractor_edrpou  TEXT,
  contractor_name    TEXT,
  contract_date      DATE,
  designer_edrpou    TEXT,
  designer_name      TEXT,
  expertise_edrpou   TEXT,
  expertise_name     TEXT,
  issuer_edrpou      TEXT,
  issuer_name        TEXT,
  incoming_doc_number TEXT,
  incoming_doc_date  DATE,
  history_ids        TEXT[],
  old_registry_id    TEXT,
  raw                JSONB NOT NULL,
  source_file        TEXT NOT NULL,
  imported_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_edessb_reg_date       ON opendata_edessb_documents (reg_date DESC);
CREATE INDEX IF NOT EXISTS idx_edessb_customer       ON opendata_edessb_documents (customer_edrpou) WHERE customer_edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edessb_contractor     ON opendata_edessb_documents (contractor_edrpou) WHERE contractor_edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edessb_designer       ON opendata_edessb_documents (designer_edrpou) WHERE designer_edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edessb_expertise      ON opendata_edessb_documents (expertise_edrpou) WHERE expertise_edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edessb_issuer         ON opendata_edessb_documents (issuer_edrpou);
CREATE INDEX IF NOT EXISTS idx_edessb_land_number    ON opendata_edessb_documents (land_number) WHERE land_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edessb_katottg        ON opendata_edessb_documents (katottg_city);
CREATE INDEX IF NOT EXISTS idx_edessb_incoming_no    ON opendata_edessb_documents (incoming_doc_number) WHERE incoming_doc_number IS NOT NULL;
