-- 023: ARMA seized assets — indexes for the LEXAI-2161 columns and filters.
--
-- Separate from 022 so the ALTER TABLEs there commit (and release their
-- ACCESS EXCLUSIVE lock) before these builds start. CREATE INDEX takes a SHARE
-- lock: SELECTs keep working, writes to arma_assets wait until the file
-- commits (~1 min on 725K rows; the table is written only by the importer).
-- The new columns are still NULL until the re-import, so the builds are cheap
-- except the two trigram indexes.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_arma_assets_case_numbers ON arma_assets USING gin(case_numbers);
CREATE INDEX IF NOT EXISTS idx_arma_assets_erdr ON arma_assets(criminal_proceeding_number) WHERE criminal_proceeding_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_arma_assets_region ON arma_assets(region) WHERE region IS NOT NULL;
-- asset_type filter is (asset_type ILIKE '%x%' OR asset_description ILIKE '%x%'):
-- trigram GIN on both columns lets the planner BitmapOr them.
CREATE INDEX IF NOT EXISTS idx_arma_assets_asset_type_trgm ON arma_assets USING gin(asset_type gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_arma_assets_description_trgm ON arma_assets USING gin(asset_description gin_trgm_ops);
