-- Migration 278: normalized key figures of Ukrainian financial statements.
--
-- One row per company (ЄДРПОУ), year, reporting period, form and source. Forms:
-- '1' (Форма № 1, баланс), '2' (Форма № 2, фінрезультати), '1-m' (Ф. № 1-м/2-м,
-- мале підприємство: balance and results in one filing), '1-ms' (Ф. № 1-мс/2-мс,
-- мікропідприємство). Sources:
--   dssu     opendata_financial_statements (data.gov.ua package 7436ae83, filings of
--            2021 onwards as XML); source_id = opendata_financial_statements.id
--   dps2020  ДПС, statements for 2020 filed with the tax returns (package 24069422,
--            pokaznyk_fin.zvit.zip, CSV); source_ref = file name
--   smida    НКЦПФР SMIDA (issuers' reports 2013-2019), reserved, not loaded yet
--
-- cur / prev map the form's line code ('1300', '2000', ...) to the value in тис. грн:
-- cur is the reporting period (balance at its end, income for the period), prev the
-- comparative column (balance at the start, income for the same period last year).
-- The summary columns come from cur: assets 1300 (else 1900), equity 1495,
-- liabilities 1900 - 1495, revenue 2000, net_profit 2350 - 2355 (loss negative).
-- When a company refiled, the later filing (filed_on, then doc_stan) is kept.
--
-- Codes longer than 8 digits (personal tax numbers of sole traders) are not loaded.
-- Filled by src/scripts/backfill-financial-figures.ts and
-- src/scripts/import-dps2020-financial-figures.ts. Idempotent.

CREATE TABLE IF NOT EXISTS financial_figures (
    id           BIGSERIAL PRIMARY KEY,
    edrpou       TEXT     NOT NULL,
    year         SMALLINT NOT NULL,
    period       SMALLINT NOT NULL,          -- month the period ends: 3, 6, 9, 12
    form         TEXT     NOT NULL,
    source       TEXT     NOT NULL,
    name         TEXT,
    kved         TEXT,
    filed_on     DATE,                       -- D_FILL / D_GET
    doc_stan     SMALLINT,                   -- C_DOC_STAN when present
    report_date  DATE,                       -- MY_DATE, the balance date
    period_name  TEXT,                       -- REP_PERNM as filed
    cur          JSONB    NOT NULL,
    prev         JSONB,
    assets       NUMERIC,
    equity       NUMERIC,
    liabilities  NUMERIC,
    revenue      NUMERIC,
    net_profit   NUMERIC,
    source_ref   TEXT,
    source_id    BIGINT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT financial_figures_key UNIQUE (edrpou, year, period, form, source)
);

DO $$ BEGIN
  ALTER TABLE financial_figures
    ADD CONSTRAINT financial_figures_form_chk CHECK (form IN ('1', '2', '1-m', '1-ms'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE financial_figures
    ADD CONSTRAINT financial_figures_source_chk CHECK (source IN ('dssu', 'dps2020', 'smida'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_finfig_edrpou_year ON financial_figures (edrpou, year);
-- search_registry(financial_statements) finds the figures of a filing by its id.
CREATE INDEX IF NOT EXISTS idx_finfig_dssu_source_id ON financial_figures (source_id) WHERE source = 'dssu';

-- Resumable batch jobs: the last processed opendata_financial_statements.id and the
-- start of the last completed run (rows re-imported after it are processed again).
CREATE TABLE IF NOT EXISTS financial_figures_progress (
    job                 TEXT PRIMARY KEY,
    last_id             BIGINT NOT NULL DEFAULT 0,
    last_run_started_at TIMESTAMPTZ,
    rows_written        BIGINT NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- get_financial_statements: one indexed read of a company's statements. 1,00 грн at the
-- NBU rate of migration 266 (45,4274 грн/$), the price of one registry search.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('get_financial_statements', 'backend', 'Фінансова звітність за ЄДРПОУ', 0.02201315, 0,
   '1,00 грн: ключові показники Ф1/Ф2 (1-м, 1-мс) за роками', 'migration_278')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
