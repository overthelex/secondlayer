/**
 * Migration 028: Template Versioning & Promotion System
 *
 * Implements version management with user segments and auto-promotion logic.
 * Each template version can be promoted through lifecycle:
 * draft → candidate → released → deprecated
 *
 * Different user segments (individual, legal_entity) can have different
 * "best versions" simultaneously. Auto-promotion based on usage + ratings.
 */

-- ============================================================================
-- Add version status and segment tracking
-- ============================================================================

ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
-- draft: freshly created, no users
-- candidate: in testing phase, limited rollout
-- released: production version for segment
-- deprecated: being phased out, replaced by newer

ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS user_segment TEXT DEFAULT 'general';
-- general: default (all users)
-- individual: физ лица
-- legal_entity: юр лица
-- government: государственные учреждения
-- corporate: корпоративные клиенты

ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS is_default_for_segment BOOLEAN DEFAULT FALSE;
-- Which version is "best" for this user_segment

ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS rollout_percentage INT DEFAULT 100;
-- Gradual rollout: 5% → 50% → 100%

ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMP;
ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS promoted_by TEXT;
ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS promotion_reason TEXT;

-- ============================================================================
-- Version metrics tracking (separate from daily metrics)
-- ============================================================================

CREATE TABLE IF NOT EXISTS template_version_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES question_templates(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES template_versions(id) ON DELETE CASCADE,
  version_number TEXT NOT NULL,
  user_segment TEXT NOT NULL DEFAULT 'general',

  -- Usage metrics
  total_uses INT DEFAULT 0,
  uses_30d INT DEFAULT 0,
  uses_7d INT DEFAULT 0,

  -- Quality metrics
  avg_rating NUMERIC(3, 2) DEFAULT 0,
  total_ratings INT DEFAULT 0,
  helpful_count INT DEFAULT 0,
  unhelpful_count INT DEFAULT 0,

  -- Success/satisfaction
  success_rate NUMERIC(5, 2) DEFAULT 0,  -- % of positive outcomes
  user_satisfaction NUMERIC(3, 2) DEFAULT 0,  -- 0-5 scale

  -- Cost tracking
  total_cost_usd NUMERIC(10, 4) DEFAULT 0,
  avg_execution_cost_usd NUMERIC(10, 4) DEFAULT 0,

  -- Performance
  avg_execution_time_ms INT DEFAULT 0,

  -- ROI (return on investment)
  roi_30d NUMERIC(8, 2) DEFAULT 0,  -- Success rate / Cost

  -- Promotion signals
  ready_for_promotion BOOLEAN DEFAULT FALSE,
  promotion_score NUMERIC(5, 2) DEFAULT 0,  -- Composite score for promotion (0-100)

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(template_id, version_id, user_segment)
);

CREATE INDEX IF NOT EXISTS idx_version_metrics_template ON template_version_metrics(template_id);
CREATE INDEX IF NOT EXISTS idx_version_metrics_segment ON template_version_metrics(user_segment);
CREATE INDEX IF NOT EXISTS idx_version_metrics_promotion ON template_version_metrics(ready_for_promotion, promotion_score DESC);

-- ============================================================================
-- Promotion history audit trail
-- ============================================================================

CREATE TABLE IF NOT EXISTS template_promotion_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES question_templates(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES template_versions(id) ON DELETE CASCADE,
  version_number TEXT NOT NULL,
  user_segment TEXT NOT NULL,

  from_status TEXT NOT NULL,  -- draft → candidate
  to_status TEXT NOT NULL,    -- candidate → released

  promoted_by TEXT NOT NULL,  -- user_id or 'system'
  promotion_reason TEXT,

  -- Metrics at time of promotion
  uses_at_promotion INT,
  avg_rating_at_promotion NUMERIC(3, 2),
  success_rate_at_promotion NUMERIC(5, 2),

  promoted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_promotion_history_template ON template_promotion_history(template_id);
CREATE INDEX IF NOT EXISTS idx_promotion_history_version ON template_promotion_history(version_id);
CREATE INDEX IF NOT EXISTS idx_promotion_history_segment ON template_promotion_history(user_segment);

-- ============================================================================
-- Promotion eligibility rules
-- ============================================================================

CREATE TABLE IF NOT EXISTS promotion_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,

  -- Promotion eligibility criteria
  min_uses INT DEFAULT 10,  -- At least 10 uses
  min_rating NUMERIC(3, 2) DEFAULT 4.0,  -- At least 4.0/5.0 average
  min_success_rate NUMERIC(5, 2) DEFAULT 70,  -- At least 70% success
  min_days_active INT DEFAULT 3,  -- At least 3 days since draft

  -- Auto-promotion settings
  auto_promote BOOLEAN DEFAULT TRUE,
  auto_deprecate BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Default promotion rules
INSERT INTO promotion_rules (name, description, min_uses, min_rating, min_success_rate, min_days_active, auto_promote, auto_deprecate)
VALUES (
  'standard',
  'Standard promotion: 10+ uses, 4.0+ rating, 70%+ success',
  10,
  4.0,
  70,
  3,
  TRUE,
  FALSE
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO promotion_rules (name, description, min_uses, min_rating, min_success_rate, min_days_active, auto_promote, auto_deprecate)
VALUES (
  'strict',
  'Strict promotion: 50+ uses, 4.5+ rating, 85%+ success',
  50,
  4.5,
  85,
  7,
  TRUE,
  FALSE
)
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- Utility functions for promotion logic
-- ============================================================================

CREATE OR REPLACE FUNCTION calculate_promotion_score(
  p_uses INT,
  p_avg_rating NUMERIC,
  p_success_rate NUMERIC
) RETURNS NUMERIC AS $$
BEGIN
  -- Weighted composite score: usage (20%) + rating (40%) + success (40%)
  RETURN ROUND(
    (p_uses::NUMERIC / 100.0 * 0.2) +  -- 0-20 points for uses
    ((COALESCE(p_avg_rating, 0) / 5.0) * 0.4 * 100) +  -- 0-40 points for rating
    (COALESCE(p_success_rate, 0) * 0.4),  -- 0-40 points for success
    2
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Check if version is eligible for promotion to candidate
CREATE OR REPLACE FUNCTION is_eligible_for_promotion(
  p_template_version_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_uses INT;
  v_rating NUMERIC;
  v_success_rate NUMERIC;
  v_rules RECORD;
  v_days_active INT;
BEGIN
  -- Get current version metrics
  SELECT total_uses, avg_rating, success_rate, EXTRACT(DAY FROM (CURRENT_TIMESTAMP - tv.released_at))::INT
  INTO v_uses, v_rating, v_success_rate, v_days_active
  FROM template_version_metrics tvm
  JOIN template_versions tv ON tv.id = tvm.version_id
  WHERE tvm.version_id = p_template_version_id
  LIMIT 1;

  -- Get standard rules
  SELECT * INTO v_rules FROM promotion_rules WHERE name = 'standard' LIMIT 1;

  -- Check eligibility
  RETURN (
    COALESCE(v_uses, 0) >= v_rules.min_uses AND
    COALESCE(v_rating, 0) >= v_rules.min_rating AND
    COALESCE(v_success_rate, 0) >= v_rules.min_success_rate AND
    COALESCE(v_days_active, 0) >= v_rules.min_days_active
  );
END;
$$ LANGUAGE plpgsql;

-- Auto-promote candidates to released if metrics excellent
CREATE OR REPLACE FUNCTION auto_promote_versions()
RETURNS TABLE(template_id UUID, version_id UUID, version_number TEXT, user_segment TEXT) AS $$
BEGIN
  RETURN QUERY
  WITH candidates_for_promotion AS (
    SELECT
      tvm.template_id,
      tvm.version_id,
      tvm.version_number,
      tvm.user_segment,
      tv.status,
      calculate_promotion_score(tvm.uses_30d, tvm.avg_rating, tvm.success_rate) as promotion_score
    FROM template_version_metrics tvm
    JOIN template_versions tv ON tv.id = tvm.version_id
    WHERE tv.status = 'candidate'
      AND tvm.total_uses >= 10
      AND tvm.avg_rating >= 4.0
      AND tvm.success_rate >= 70
      AND EXTRACT(DAY FROM (CURRENT_TIMESTAMP - tv.promoted_at)) >= 3
  )
  UPDATE template_versions tv
  SET status = 'released',
      promoted_at = CURRENT_TIMESTAMP,
      promoted_by = 'system',
      promotion_reason = 'Auto-promoted based on metrics',
      is_default_for_segment = TRUE
  FROM candidates_for_promotion cfp
  WHERE tv.id = cfp.version_id
  RETURNING cfp.template_id, cfp.version_id, cfp.version_number, cfp.user_segment;
END;
$$ LANGUAGE plpgsql;

-- Update version promotion score daily
CREATE OR REPLACE FUNCTION update_version_promotion_scores()
RETURNS TABLE(updated_count INT) AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE template_version_metrics tvm
  SET promotion_score = calculate_promotion_score(
    tvm.uses_30d,
    tvm.avg_rating,
    tvm.success_rate
  ),
  ready_for_promotion = (
    tvm.total_uses >= 10 AND
    tvm.avg_rating >= 4.0 AND
    tvm.success_rate >= 70
  ),
  updated_at = CURRENT_TIMESTAMP;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN QUERY SELECT v_updated;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Data migration: existing versions → candidate status
-- ============================================================================

UPDATE template_versions
SET status = 'released',
    is_default_for_segment = TRUE,
    user_segment = 'general'
WHERE status IS NULL OR status = ''
  AND is_current = TRUE;

UPDATE template_versions
SET status = 'deprecated',
    user_segment = 'general'
WHERE status IS NULL OR status = ''
  AND is_current = FALSE;

-- ============================================================================
-- Create initial version metrics for all existing template versions
-- ============================================================================

INSERT INTO template_version_metrics (
  template_id, version_id, version_number, user_segment,
  total_uses, avg_rating, success_rate, user_satisfaction
)
SELECT
  qt.id,
  tv.id,
  tv.version_number,
  'general',
  COALESCE(qt.total_uses, 0),
  COALESCE(qt.quality_score, 0),
  COALESCE(qt.success_rate, 0),
  COALESCE(qt.user_satisfaction, 0)
FROM question_templates qt
JOIN template_versions tv ON tv.template_id = qt.id
WHERE NOT EXISTS (
  SELECT 1 FROM template_version_metrics tvm
  WHERE tvm.version_id = tv.id
)
ON CONFLICT (template_id, version_id, user_segment) DO NOTHING;

-- ============================================================================
-- Indexes for common queries
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_template_versions_status_segment
  ON template_versions(status, user_segment);
CREATE INDEX IF NOT EXISTS idx_template_versions_default_segment
  ON template_versions(template_id, user_segment)
  WHERE is_default_for_segment = TRUE;
