-- Migration: Add user request preferences for cost control
-- Purpose: Allow users to control request parameters that affect costs
-- Author: SecondLayer Team
-- Date: 2026-01-29

-- Create user_request_preferences table
CREATE TABLE IF NOT EXISTS user_request_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Reasoning/Analysis Settings
  default_reasoning_budget VARCHAR(20) DEFAULT 'standard',
  -- Options: 'quick' (lowest cost), 'standard' (balanced), 'deep' (highest quality)

  -- Document Retrieval Limits
  max_search_results INTEGER DEFAULT 10,
  -- Maximum documents to retrieve in search (1-50), affects ZakonOnline API calls

  max_analysis_depth INTEGER DEFAULT 2,
  -- How deep to analyze documents (1-5), affects OpenAI token usage

  max_practice_cases INTEGER DEFAULT 15,
  -- Maximum practice cases to analyze (3-25), affects both API calls and tokens

  max_practice_depth INTEGER DEFAULT 2,
  -- Depth of practice case expansion (1-5), affects OpenAI token usage

  -- Cost vs Quality Trade-off
  quality_preference VARCHAR(20) DEFAULT 'balanced',
  -- Options: 'economy' (minimize cost), 'balanced', 'quality' (maximize accuracy)

  -- Caching Settings
  aggressive_caching BOOLEAN DEFAULT true,
  -- Use aggressive caching to reduce API calls (may use slightly outdated data)

  -- Feature Toggles
  enable_semantic_search BOOLEAN DEFAULT true,
  -- Use embeddings for semantic search (costs OpenAI, but better results)

  enable_auto_citations BOOLEAN DEFAULT true,
  -- Automatically validate and enhance citations (costs extra OpenAI calls)

  enable_legal_patterns BOOLEAN DEFAULT false,
  -- Extract and store legal reasoning patterns (experimental, adds cost)

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Ensure one preference set per user
  UNIQUE(user_id)
);

-- Create index for fast user lookups
CREATE INDEX IF NOT EXISTS idx_user_request_preferences_user_id
  ON user_request_preferences(user_id);

-- Add constraints for valid values (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_reasoning_budget') THEN
    ALTER TABLE user_request_preferences
    ADD CONSTRAINT check_reasoning_budget
      CHECK (default_reasoning_budget IN ('quick', 'standard', 'deep'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_quality_preference') THEN
    ALTER TABLE user_request_preferences
    ADD CONSTRAINT check_quality_preference
      CHECK (quality_preference IN ('economy', 'balanced', 'quality'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_max_search_results') THEN
    ALTER TABLE user_request_preferences
    ADD CONSTRAINT check_max_search_results
      CHECK (max_search_results >= 1 AND max_search_results <= 50);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_max_analysis_depth') THEN
    ALTER TABLE user_request_preferences
    ADD CONSTRAINT check_max_analysis_depth
      CHECK (max_analysis_depth >= 1 AND max_analysis_depth <= 5);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_max_practice_cases') THEN
    ALTER TABLE user_request_preferences
    ADD CONSTRAINT check_max_practice_cases
      CHECK (max_practice_cases >= 3 AND max_practice_cases <= 25);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_max_practice_depth') THEN
    ALTER TABLE user_request_preferences
    ADD CONSTRAINT check_max_practice_depth
      CHECK (max_practice_depth >= 1 AND max_practice_depth <= 5);
  END IF;
END $$;

-- Add comments for documentation
COMMENT ON TABLE user_request_preferences IS 'User-configurable request parameters for cost and quality control';
COMMENT ON COLUMN user_request_preferences.default_reasoning_budget IS 'Default reasoning depth: quick (fast/cheap), standard (balanced), deep (thorough/expensive)';
COMMENT ON COLUMN user_request_preferences.max_search_results IS 'Maximum documents to retrieve (1-50). Higher = more API calls + tokens';
COMMENT ON COLUMN user_request_preferences.max_analysis_depth IS 'Document analysis depth (1-5). Higher = more OpenAI tokens';
COMMENT ON COLUMN user_request_preferences.max_practice_cases IS 'Maximum practice cases to analyze (3-25). Higher = more API calls + tokens';
COMMENT ON COLUMN user_request_preferences.max_practice_depth IS 'Practice expansion depth (1-5). Higher = more OpenAI tokens';
COMMENT ON COLUMN user_request_preferences.quality_preference IS 'Cost vs quality: economy (min cost), balanced, quality (max accuracy)';
COMMENT ON COLUMN user_request_preferences.aggressive_caching IS 'Use aggressive caching to reduce API calls (may be slightly outdated)';
COMMENT ON COLUMN user_request_preferences.enable_semantic_search IS 'Use AI embeddings for semantic search (costs OpenAI, better results)';
COMMENT ON COLUMN user_request_preferences.enable_auto_citations IS 'Auto-validate citations (extra OpenAI calls)';
COMMENT ON COLUMN user_request_preferences.enable_legal_patterns IS 'Extract legal patterns (experimental, adds cost)';

-- Create view for combined user settings
CREATE OR REPLACE VIEW user_full_settings AS
SELECT
  u.id AS user_id,
  u.email,
  u.name,
  -- Billing info
  ub.pricing_tier,
  ub.balance_usd,
  ub.daily_limit_usd,
  ub.monthly_limit_usd,
  ub.billing_enabled,
  -- Request preferences
  COALESCE(urp.default_reasoning_budget, 'standard') AS default_reasoning_budget,
  COALESCE(urp.max_search_results, 10) AS max_search_results,
  COALESCE(urp.max_analysis_depth, 2) AS max_analysis_depth,
  COALESCE(urp.max_practice_cases, 15) AS max_practice_cases,
  COALESCE(urp.max_practice_depth, 2) AS max_practice_depth,
  COALESCE(urp.quality_preference, 'balanced') AS quality_preference,
  COALESCE(urp.aggressive_caching, true) AS aggressive_caching,
  COALESCE(urp.enable_semantic_search, true) AS enable_semantic_search,
  COALESCE(urp.enable_auto_citations, true) AS enable_auto_citations,
  COALESCE(urp.enable_legal_patterns, false) AS enable_legal_patterns
FROM users u
LEFT JOIN user_billing ub ON u.id = ub.user_id
LEFT JOIN user_request_preferences urp ON u.id = urp.user_id;

COMMENT ON VIEW user_full_settings IS 'Combined view of user billing and request preferences for easy access';

-- Create preset configurations for quality_preference
-- These are helpful for frontend to show estimated costs

CREATE TABLE IF NOT EXISTS request_preset_configs (
  preset_name VARCHAR(20) PRIMARY KEY,
  description TEXT,
  reasoning_budget VARCHAR(20),
  max_search_results INTEGER,
  max_analysis_depth INTEGER,
  max_practice_cases INTEGER,
  max_practice_depth INTEGER,
  aggressive_caching BOOLEAN,
  enable_semantic_search BOOLEAN,
  estimated_cost_multiplier DECIMAL(3, 2),
  -- How much more expensive than 'economy' (1.0 = economy, 2.0 = 2x cost)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default presets
INSERT INTO request_preset_configs (
  preset_name, description, reasoning_budget,
  max_search_results, max_analysis_depth,
  max_practice_cases, max_practice_depth,
  aggressive_caching, enable_semantic_search,
  estimated_cost_multiplier
) VALUES
  (
    'economy',
    'Minimize costs - quick analysis with basic results',
    'quick', 5, 1, 5, 1, true, false, 1.00
  ),
  (
    'balanced',
    'Balance cost and quality - standard analysis with good coverage',
    'standard', 10, 2, 15, 2, true, true, 1.50
  ),
  (
    'quality',
    'Maximum accuracy - deep analysis with comprehensive coverage',
    'deep', 25, 5, 25, 5, false, true, 3.00
  )
ON CONFLICT (preset_name) DO NOTHING;

COMMENT ON TABLE request_preset_configs IS 'Predefined request configuration presets for easy user selection';
