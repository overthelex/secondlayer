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
-- This migration only adds columns and indexes; the corrected importer
-- (scripts/import-arma.ts) refills every row and deletes rows it did not see.
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

COMMENT ON COLUMN arma_assets.owner_name IS 'Not published in ARMA open data (art. 25 para 9); NULL after LEXAI-2161 reload';
COMMENT ON COLUMN arma_assets.owner_edrpou IS 'Not published in ARMA open data (art. 25 para 9); NULL after LEXAI-2161 reload';
COMMENT ON COLUMN arma_assets.asset_type IS 'Asset category derived from description/props by the importer';
COMMENT ON COLUMN arma_assets.status IS 'ARMA action state (source field state), Ukrainian';
COMMENT ON COLUMN arma_assets.region IS 'Region derived from the court seat; NULL for national courts (ВАКС etc.)';
COMMENT ON COLUMN arma_assets.manager IS 'Asset manager / realiser from action details (props_2)';

CREATE INDEX IF NOT EXISTS idx_arma_assets_case_numbers ON arma_assets USING gin(case_numbers);
CREATE INDEX IF NOT EXISTS idx_arma_assets_erdr ON arma_assets(criminal_proceeding_number) WHERE criminal_proceeding_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_arma_assets_region ON arma_assets(region) WHERE region IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_arma_assets_asset_type ON arma_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_arma_assets_asset_id ON arma_assets(asset_id);
CREATE INDEX IF NOT EXISTS idx_arma_assets_description_trgm ON arma_assets USING gin(asset_description gin_trgm_ops);
