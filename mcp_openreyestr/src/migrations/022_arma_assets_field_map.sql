-- 022: ARMA seized assets — columns for the real source fields (LEXAI-2161).
--
-- The first importer mapped the data.gov.ua fields onto the wrong columns:
--   owner_name   ← name     (ARMA action: «Заходи з реалізації», «Оцінка»)
--   owner_edrpou ← numerdr  (17-digit ЄРДР criminal proceeding number)
--   asset_type   ← dectypename (court decision type)
--   manager      ← judge from props_1
--   arrest_date  ← dateaction (ARMA action date)
-- The open dataset carries no owner name / ЄДРПОУ at all (excluded by
-- art. 25 para 9 of the ARMA Law), and no region field.
--
-- This migration only adds columns (indexes: 023); the corrected importer
-- (services/arma-import.ts) refills every row, stamps it with import_run_id
-- and, after a clean complete run, deletes rows carrying another run id.
-- All statements are idempotent.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS asset_id TEXT;
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS case_numbers TEXT[];
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS criminal_proceeding_number TEXT;
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS judge_name TEXT;
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS investigation_body TEXT;
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS decision_type TEXT;
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS asset_props TEXT;
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS action_name TEXT;
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS action_date DATE;
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS action_details TEXT;
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS action_income_sum NUMERIC;
-- Set by every importer run; rows with another run id are deleted after a clean run.
ALTER TABLE arma_assets ADD COLUMN IF NOT EXISTS import_run_id TEXT;

COMMENT ON COLUMN arma_assets.owner_name IS 'Not published in ARMA open data (art. 25 para 9); NULL after LEXAI-2161 reload';
COMMENT ON COLUMN arma_assets.owner_edrpou IS 'Not published in ARMA open data (art. 25 para 9); NULL after LEXAI-2161 reload';
COMMENT ON COLUMN arma_assets.asset_type IS 'Asset category derived from description/props by the importer';
COMMENT ON COLUMN arma_assets.status IS 'ARMA action state (source field state), Ukrainian';
COMMENT ON COLUMN arma_assets.region IS 'Region derived from the court seat; NULL for national courts (ВАКС etc.)';
COMMENT ON COLUMN arma_assets.manager IS 'Asset manager / realiser from action details (props_2)';

-- Indexes nothing uses any more (prod 2026-11-01: 20 MB + 12 MB + 1.4 MB):
-- owner_* are not in the open data and stay NULL; case_number search goes
-- through case_numbers (GIN, 023). DROP INDEX is catalog-only here.
DROP INDEX IF EXISTS idx_arma_assets_case_number;
DROP INDEX IF EXISTS idx_arma_assets_owner_name;
DROP INDEX IF EXISTS idx_arma_assets_owner_edrpou;

-- Indexes are in 023_arma_assets_indexes.sql: the runner sends each file as
-- one transaction, so building them here would hold the ACCESS EXCLUSIVE lock
-- of the ALTERs above for the whole index build.
