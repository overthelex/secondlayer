-- ============================================================================
-- Migration 027: Dynamic Template System
-- ============================================================================
-- Adds complete infrastructure for self-learning legal knowledge system:
-- - Template registry and versioning
-- - Question classification and deduplication
-- - Template matching and recommendations
-- - Usage analytics and feedback
-- - Quality scoring and metrics

-- ============================================================================
-- Core Tables
-- ============================================================================

-- Active template registry
CREATE TABLE IF NOT EXISTS question_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name VARCHAR(255) NOT NULL UNIQUE,
  category VARCHAR(100) NOT NULL,
  intent_keywords TEXT[] NOT NULL, -- Array of keywords for intent matching

  -- Content
  prompt_template TEXT NOT NULL, -- Mustache template with {{variables}}
  input_schema JSONB NOT NULL, -- JSON schema for input validation
  output_schema JSONB NOT NULL, -- JSON schema for output validation

  -- Metadata
  description TEXT,
  instructions TEXT, -- Additional context for LLM
  example_input JSONB, -- Example input for testing
  example_output JSONB, -- Example output for reference

  -- Status
  status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'archived')),
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID, -- User who created this template

  -- Versioning
  current_version VARCHAR(20) DEFAULT '1.0.0',

  -- Quality metrics (denormalized from template_usage_metrics)
  quality_score NUMERIC(3, 1) DEFAULT 0.0 CHECK (quality_score >= 0 AND quality_score <= 100),
  success_rate NUMERIC(5, 2) DEFAULT 0.0 CHECK (success_rate >= 0 AND success_rate <= 100),
  user_satisfaction NUMERIC(3, 2) DEFAULT 0.0 CHECK (user_satisfaction >= 0 AND user_satisfaction <= 5),
  total_uses INTEGER DEFAULT 0,

  -- Cost tracking (amortized per use)
  generation_cost_usd NUMERIC(8, 6) DEFAULT 0.0,
  avg_execution_cost_usd NUMERIC(8, 6) DEFAULT 0.0,

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deprecated_at TIMESTAMP
);

CREATE INDEX idx_question_templates_category ON question_templates(category);
CREATE INDEX idx_question_templates_status ON question_templates(status);
CREATE INDEX idx_question_templates_quality_score ON question_templates(quality_score DESC);
CREATE INDEX idx_question_templates_created_at ON question_templates(created_at DESC);
CREATE INDEX idx_question_templates_intent_keywords ON question_templates USING GIN(intent_keywords);

-- Question classification audit trail
CREATE TABLE IF NOT EXISTS question_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Question details
  user_id UUID NOT NULL,
  question_text TEXT NOT NULL,
  question_hash VARCHAR(64) NOT NULL, -- SHA256 for deduplication

  -- Classification result
  classified_intent VARCHAR(100),
  intent_confidence NUMERIC(3, 2) CHECK (intent_confidence >= 0 AND intent_confidence <= 1),
  category VARCHAR(100),
  entities JSONB, -- Extracted entities (person, date, amount, etc.)

  -- Matched template (if found)
  matched_template_id UUID REFERENCES question_templates(id) ON DELETE SET NULL,
  match_score NUMERIC(3, 2) CHECK (match_score >= 0 AND match_score <= 1),

  -- Alternative suggestions
  alternative_templates JSONB, -- [{id, name, score}, ...]

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_question_classifications_user_id ON question_classifications(user_id);
CREATE INDEX idx_question_classifications_question_hash ON question_classifications(question_hash);
CREATE INDEX idx_question_classifications_matched_template_id ON question_classifications(matched_template_id);
CREATE INDEX idx_question_classifications_created_at ON question_classifications(created_at DESC);

-- Generated templates pending approval
CREATE TABLE IF NOT EXISTS template_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source
  user_id UUID NOT NULL,
  triggering_question_id UUID REFERENCES question_classifications(id) ON DELETE SET NULL,
  triggering_question TEXT NOT NULL,

  -- Generated template
  generated_template JSONB NOT NULL, -- {name, category, prompt_template, input_schema, output_schema, instructions}
  generation_model VARCHAR(50) DEFAULT 'gpt-4o',
  generation_cost_usd NUMERIC(8, 6),
  generation_duration_ms INTEGER,

  -- Validation
  validation_status VARCHAR(50) DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid')),
  validation_errors TEXT[], -- List of validation errors if invalid

  -- Approval workflow
  approval_status VARCHAR(50) DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected', 'needs_revision')),
  approved_by UUID, -- User who approved
  approval_notes TEXT,
  approved_at TIMESTAMP,

  -- Sampling test results (5-10 test executions)
  test_results JSONB, -- {test_count, passed_count, avg_latency_ms, avg_cost_usd, quality_score}

  -- Admin feedback
  admin_feedback TEXT,
  suggested_improvements TEXT,

  -- Rollout configuration (after approval)
  rollout_percentage INTEGER DEFAULT 0 CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
  a_b_test_group VARCHAR(50), -- 'control', 'treatment', or NULL if not A/B testing

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Status tracking
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'published', 'rolled_back'))
);

CREATE INDEX idx_template_generations_approval_status ON template_generations(approval_status);
CREATE INDEX idx_template_generations_status ON template_generations(status);
CREATE INDEX idx_template_generations_created_at ON template_generations(created_at DESC);
CREATE INDEX idx_template_generations_user_id ON template_generations(user_id);

-- Template usage tracking (every template execution)
CREATE TABLE IF NOT EXISTS template_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parties involved
  user_id UUID NOT NULL,
  template_id UUID NOT NULL REFERENCES question_templates(id) ON DELETE CASCADE,
  question_id UUID REFERENCES question_classifications(id) ON DELETE SET NULL,

  -- Match details
  user_question TEXT NOT NULL,
  match_score NUMERIC(3, 2) CHECK (match_score >= 0 AND match_score <= 1),
  was_used BOOLEAN DEFAULT FALSE, -- Did user actually use this match?

  -- Execution result
  result JSONB, -- Actual output from template execution
  execution_time_ms INTEGER,
  execution_cost_usd NUMERIC(8, 6),

  -- User feedback
  user_rating INTEGER CHECK (user_rating >= 1 AND user_rating <= 5),
  user_helpful BOOLEAN, -- Did user mark as helpful?

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  feedback_at TIMESTAMP
);

CREATE INDEX idx_template_matches_user_id ON template_matches(user_id);
CREATE INDEX idx_template_matches_template_id ON template_matches(template_id);
CREATE INDEX idx_template_matches_was_used ON template_matches(was_used);
CREATE INDEX idx_template_matches_created_at ON template_matches(created_at DESC);
CREATE INDEX idx_template_matches_user_rating ON template_matches(user_rating);

-- Template versions (semantic versioning)
CREATE TABLE IF NOT EXISTS template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  template_id UUID NOT NULL REFERENCES question_templates(id) ON DELETE CASCADE,
  version_number VARCHAR(20) NOT NULL, -- "1.0.0", "1.1.0", "2.0.0"

  -- Content snapshot
  prompt_template TEXT NOT NULL,
  input_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL,
  instructions TEXT,

  -- Change metadata
  change_type VARCHAR(50) NOT NULL CHECK (change_type IN ('major', 'minor', 'patch')),
  change_description TEXT,
  migration_notes TEXT, -- If major version

  -- Metrics at time of publication
  quality_score_at_release NUMERIC(3, 1),
  success_rate_at_release NUMERIC(5, 2),

  -- Status
  is_current BOOLEAN DEFAULT FALSE,
  is_supported BOOLEAN DEFAULT TRUE, -- Keep 3 versions supported, older marked unsupported
  released_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sunset_at TIMESTAMP -- When this version will be deprecated
);

CREATE INDEX idx_template_versions_template_id ON template_versions(template_id);
CREATE INDEX idx_template_versions_version_number ON template_versions(template_id, version_number);
CREATE INDEX idx_template_versions_is_current ON template_versions(is_current);

-- User feedback on templates
CREATE TABLE IF NOT EXISTS template_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source
  user_id UUID NOT NULL,
  template_id UUID NOT NULL REFERENCES question_templates(id) ON DELETE CASCADE,
  match_id UUID REFERENCES template_matches(id) ON DELETE CASCADE,

  -- Feedback content
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  was_helpful BOOLEAN,
  improvement_suggestion TEXT,
  accuracy_issue TEXT, -- If inaccurate, what was wrong?
  missing_information TEXT, -- What was missing?

  -- Impact on quality
  contributed_to_version_bump BOOLEAN DEFAULT FALSE,
  created_issue_ticket VARCHAR(255), -- Jira/GitHub issue ID if created

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP, -- When admin reviewed this feedback
  reviewed_by UUID -- Admin who reviewed
);

CREATE INDEX idx_template_feedback_template_id ON template_feedback(template_id);
CREATE INDEX idx_template_feedback_user_id ON template_feedback(user_id);
CREATE INDEX idx_template_feedback_rating ON template_feedback(rating);
CREATE INDEX idx_template_feedback_created_at ON template_feedback(created_at DESC);

-- Question deduplication (SHA256 hash of normalized question)
CREATE TABLE IF NOT EXISTS question_deduplication (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Hash and normalization
  question_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA256 of normalized question
  canonical_question TEXT NOT NULL, -- First question with this hash
  variation_count INTEGER DEFAULT 1, -- How many similar questions seen?

  -- Best template for this hash
  best_template_id UUID REFERENCES question_templates(id) ON DELETE SET NULL,
  best_match_score NUMERIC(3, 2),

  -- Tracking
  first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_matches INTEGER DEFAULT 0
);

CREATE INDEX idx_question_deduplication_question_hash ON question_deduplication(question_hash);
CREATE INDEX idx_question_deduplication_best_template_id ON question_deduplication(best_template_id);

-- Daily usage metrics aggregation
CREATE TABLE IF NOT EXISTS template_usage_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Dimensions
  template_id UUID NOT NULL REFERENCES question_templates(id) ON DELETE CASCADE,
  metric_date DATE NOT NULL,

  -- Aggregated counts
  total_matches INTEGER DEFAULT 0, -- Questions matched to this template
  successful_matches INTEGER DEFAULT 0, -- User actually used it
  usage_count INTEGER DEFAULT 0, -- Executions

  -- Quality metrics
  avg_rating NUMERIC(3, 2), -- Average 1-5 rating
  helpful_count INTEGER DEFAULT 0, -- Marked helpful
  accuracy_issues INTEGER DEFAULT 0, -- Negative feedback

  -- Performance
  avg_execution_time_ms INTEGER,
  avg_cost_usd NUMERIC(8, 6),

  -- Cost-benefit
  total_cost_usd NUMERIC(10, 6),
  total_time_saved_minutes NUMERIC(10, 2), -- Estimated based on question complexity
  roi_ratio NUMERIC(8, 2), -- (time_saved_usd_value / total_cost) if > 1 then profitable

  -- Trends
  quality_score_trend NUMERIC(3, 1), -- How quality changed vs yesterday
  success_rate_trend NUMERIC(5, 2), -- How success rate changed vs yesterday

  -- Unique constraint
  UNIQUE(template_id, metric_date)
);

CREATE INDEX idx_template_usage_metrics_template_id ON template_usage_metrics(template_id);
CREATE INDEX idx_template_usage_metrics_metric_date ON template_usage_metrics(metric_date DESC);
CREATE INDEX idx_template_usage_metrics_quality_score ON template_usage_metrics(avg_rating DESC);

-- Template recommendations (personalized suggestions)
CREATE TABLE IF NOT EXISTS template_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Target user
  user_id UUID NOT NULL,

  -- Recommended template
  template_id UUID NOT NULL REFERENCES question_templates(id) ON DELETE CASCADE,

  -- Recommendation strategy
  strategy VARCHAR(50) NOT NULL CHECK (strategy IN ('frequency', 'trending', 'collaborative', 'seasonal', 'cost_optimized')),
  strategy_score NUMERIC(5, 2) CHECK (strategy_score >= 0 AND strategy_score <= 100),

  -- Combined score (weighted average of all strategies)
  combined_score NUMERIC(5, 2) CHECK (combined_score >= 0 AND combined_score <= 100),

  -- Recommendation metadata
  reason TEXT, -- "You use similar templates frequently", "Top trending this week", etc.
  confidence NUMERIC(3, 2) CHECK (confidence >= 0 AND confidence <= 1),

  -- Engagement tracking
  was_shown BOOLEAN DEFAULT FALSE,
  was_clicked BOOLEAN DEFAULT FALSE,
  was_used BOOLEAN DEFAULT FALSE,
  clicked_at TIMESTAMP,
  used_at TIMESTAMP,

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP -- Recommendation expires after 7 days
);

CREATE INDEX idx_template_recommendations_user_id ON template_recommendations(user_id);
CREATE INDEX idx_template_recommendations_template_id ON template_recommendations(template_id);
CREATE INDEX idx_template_recommendations_strategy ON template_recommendations(strategy);
CREATE INDEX idx_template_recommendations_combined_score ON template_recommendations(combined_score DESC);
CREATE INDEX idx_template_recommendations_was_shown ON template_recommendations(was_shown);

-- ============================================================================
-- Analytics Views
-- ============================================================================

-- Active templates with current metrics
CREATE OR REPLACE VIEW active_templates_with_metrics AS
SELECT
  t.id,
  t.name,
  t.category,
  t.status,
  t.current_version,
  t.quality_score,
  t.success_rate,
  t.user_satisfaction,
  t.total_uses,
  t.generation_cost_usd,
  t.avg_execution_cost_usd,
  COUNT(DISTINCT tm.id) as total_matches,
  COUNT(DISTINCT tm.id) FILTER (WHERE tm.user_rating >= 4) as positive_ratings,
  COUNT(DISTINCT tm.id) FILTER (WHERE tm.user_rating <= 2) as negative_ratings,
  COUNT(DISTINCT tf.id) as feedback_count,
  t.created_at,
  t.updated_at
FROM question_templates t
LEFT JOIN template_matches tm ON t.id = tm.template_id
LEFT JOIN template_feedback tf ON t.id = tf.template_id
WHERE t.status = 'active'
GROUP BY t.id;

-- Template performance trends (last 30 days)
CREATE OR REPLACE VIEW template_performance_30d AS
SELECT
  t.id,
  t.name,
  SUM(tum.usage_count) as uses_30d,
  AVG(tum.avg_rating) as avg_rating_30d,
  AVG(tum.avg_cost_usd) as avg_cost_30d,
  SUM(tum.total_cost_usd) as total_cost_30d,
  SUM(tum.total_time_saved_minutes) as total_time_saved_30d,
  CASE
    WHEN SUM(tum.total_cost_usd) > 0 THEN SUM(tum.total_time_saved_minutes) * 0.5 / SUM(tum.total_cost_usd)
    ELSE 0
  END as roi_30d
FROM question_templates t
LEFT JOIN template_usage_metrics tum ON t.id = tum.template_id AND tum.metric_date >= CURRENT_DATE - 30
WHERE t.status = 'active'
GROUP BY t.id, t.name;

-- Top performing templates
CREATE OR REPLACE VIEW top_templates AS
SELECT
  t.id,
  t.name,
  t.category,
  t.quality_score,
  t.success_rate,
  t.user_satisfaction,
  t.total_uses,
  RANK() OVER (PARTITION BY t.category ORDER BY t.quality_score DESC) as rank_in_category
FROM question_templates t
WHERE t.status = 'active'
ORDER BY t.quality_score DESC, t.total_uses DESC;

-- Templates needing improvement (quality declining)
CREATE OR REPLACE VIEW declining_templates AS
SELECT
  t.id,
  t.name,
  t.quality_score,
  tum_recent.avg_rating as recent_rating,
  tum_old.avg_rating as previous_rating,
  (tum_old.avg_rating - tum_recent.avg_rating) as quality_drop,
  COUNT(DISTINCT tf.id) as recent_feedback_count
FROM question_templates t
LEFT JOIN template_usage_metrics tum_recent ON t.id = tum_recent.template_id
  AND tum_recent.metric_date >= CURRENT_DATE - 7
LEFT JOIN template_usage_metrics tum_old ON t.id = tum_old.template_id
  AND tum_old.metric_date >= CURRENT_DATE - 14 AND tum_old.metric_date < CURRENT_DATE - 7
LEFT JOIN template_feedback tf ON t.id = tf.template_id
  AND tf.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
WHERE t.status = 'active'
  AND tum_old.avg_rating IS NOT NULL
  AND tum_recent.avg_rating IS NOT NULL
  AND (tum_old.avg_rating - tum_recent.avg_rating) > 0.5
GROUP BY t.id, t.name, t.quality_score, tum_recent.avg_rating, tum_old.avg_rating;

-- ============================================================================
-- Utility Functions
-- ============================================================================

-- Calculate cosine similarity between two vectors (for matching)
CREATE OR REPLACE FUNCTION calculate_template_similarity(
  vec1 DOUBLE PRECISION[],
  vec2 DOUBLE PRECISION[]
) RETURNS NUMERIC AS $$
DECLARE
  dot_product DOUBLE PRECISION := 0;
  norm1 DOUBLE PRECISION := 0;
  norm2 DOUBLE PRECISION := 0;
  i INTEGER;
BEGIN
  IF array_length(vec1, 1) != array_length(vec2, 1) THEN
    RETURN 0;
  END IF;

  FOR i IN 1..array_length(vec1, 1) LOOP
    dot_product := dot_product + (vec1[i] * vec2[i]);
    norm1 := norm1 + (vec1[i] * vec1[i]);
    norm2 := norm2 + (vec2[i] * vec2[i]);
  END LOOP;

  IF norm1 = 0 OR norm2 = 0 THEN
    RETURN 0;
  END IF;

  RETURN dot_product / (sqrt(norm1) * sqrt(norm2));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Check if question should trigger new template generation
CREATE OR REPLACE FUNCTION check_template_similarity_for_generation(
  p_best_match_score NUMERIC
) RETURNS BOOLEAN AS $$
BEGIN
  -- Generate new template if best match score < 0.65
  -- This means 80% match rate (65% threshold for existing, 20% will generate)
  RETURN p_best_match_score < 0.65;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Aggregate daily metrics from matches and feedback
CREATE OR REPLACE FUNCTION aggregate_template_metrics(
  p_template_id UUID,
  p_date DATE
) RETURNS void AS $$
BEGIN
  INSERT INTO template_usage_metrics (
    template_id, metric_date, total_matches, successful_matches,
    usage_count, avg_rating, helpful_count, accuracy_issues,
    avg_execution_time_ms, avg_cost_usd, total_cost_usd
  )
  SELECT
    p_template_id,
    p_date,
    COUNT(DISTINCT CASE WHEN tm.created_at::DATE = p_date THEN tm.id END),
    COUNT(DISTINCT CASE WHEN tm.was_used AND tm.created_at::DATE = p_date THEN tm.id END),
    COUNT(DISTINCT CASE WHEN tm.execution_time_ms IS NOT NULL AND tm.created_at::DATE = p_date THEN tm.id END),
    AVG(CASE WHEN tf.created_at::DATE = p_date THEN tf.rating END),
    COUNT(DISTINCT CASE WHEN tf.was_helpful AND tf.created_at::DATE = p_date THEN tf.id END),
    COUNT(DISTINCT CASE WHEN tf.accuracy_issue IS NOT NULL AND tf.created_at::DATE = p_date THEN tf.id END),
    AVG(CASE WHEN tm.created_at::DATE = p_date THEN tm.execution_time_ms END),
    AVG(CASE WHEN tm.created_at::DATE = p_date THEN tm.execution_cost_usd END),
    SUM(CASE WHEN tm.created_at::DATE = p_date THEN tm.execution_cost_usd ELSE 0 END)
  FROM template_matches tm
  LEFT JOIN template_feedback tf ON tm.id = tf.match_id
  WHERE tm.template_id = p_template_id
  ON CONFLICT (template_id, metric_date) DO UPDATE SET
    total_matches = EXCLUDED.total_matches,
    successful_matches = EXCLUDED.successful_matches,
    usage_count = EXCLUDED.usage_count,
    avg_rating = EXCLUDED.avg_rating,
    helpful_count = EXCLUDED.helpful_count,
    accuracy_issues = EXCLUDED.accuracy_issues,
    avg_execution_time_ms = EXCLUDED.avg_execution_time_ms,
    avg_cost_usd = EXCLUDED.avg_cost_usd,
    total_cost_usd = EXCLUDED.total_cost_usd;
END;
$$ LANGUAGE plpgsql;

-- Auto-deprecate templates with low success rate
CREATE OR REPLACE FUNCTION auto_deprecate_low_quality_templates() RETURNS void AS $$
BEGIN
  UPDATE question_templates
  SET status = 'deprecated', deprecated_at = CURRENT_TIMESTAMP
  WHERE status = 'active'
    AND success_rate < 50
    AND total_uses >= 10 -- Only if it has been used enough
    AND updated_at < CURRENT_TIMESTAMP - INTERVAL '7 days'; -- Only if stale for 7 days
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Triggers
-- ============================================================================

-- Update question_templates.updated_at on any change
CREATE OR REPLACE FUNCTION update_template_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_question_templates_updated_at
BEFORE UPDATE ON question_templates
FOR EACH ROW
EXECUTE FUNCTION update_template_timestamp();

-- Similar trigger for template_generations
CREATE TRIGGER trigger_template_generations_updated_at
BEFORE UPDATE ON template_generations
FOR EACH ROW
EXECUTE FUNCTION update_template_timestamp();

-- Update question_deduplication.last_seen_at on every match
CREATE OR REPLACE FUNCTION update_deduplication_last_seen()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE question_deduplication
  SET last_seen_at = CURRENT_TIMESTAMP,
      total_matches = total_matches + 1
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Indexes for Performance
-- ============================================================================

-- Composite indexes for common queries
CREATE INDEX idx_template_matches_user_template_date
  ON template_matches(user_id, template_id, created_at DESC);

CREATE INDEX idx_template_feedback_template_rating
  ON template_feedback(template_id, rating, created_at DESC);

CREATE INDEX idx_template_generations_status_date
  ON template_generations(status, created_at DESC);

CREATE INDEX idx_template_classifications_hash_template
  ON question_classifications(question_hash, matched_template_id);

-- ============================================================================
-- Data Constraints and Checks
-- ============================================================================

-- Ensure no duplicate active templates in same category
ALTER TABLE question_templates
ADD CONSTRAINT unique_active_template_per_category
UNIQUE (name, category) WHERE status = 'active';

-- Ensure template version is monotonically increasing
ALTER TABLE template_versions
ADD CONSTRAINT valid_version_format
CHECK (version_number ~ '^\d+\.\d+\.\d+$');

-- Ensure cost is non-negative
ALTER TABLE question_templates
ADD CONSTRAINT non_negative_costs
CHECK (generation_cost_usd >= 0 AND avg_execution_cost_usd >= 0);

-- Ensure rating is valid
ALTER TABLE template_feedback
ADD CONSTRAINT valid_rating
CHECK (rating >= 1 AND rating <= 5);

-- ============================================================================
-- Initial Data (Optional)
-- ============================================================================

-- No initial data required - system is initialized empty and learns from usage
