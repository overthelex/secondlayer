-- Migration 008: Add Prompt Lifecycle Tables
-- ADR-002 Target Prompt Architecture
-- Tracks prompt instances and executions for observability

-- Prompt instances (assembled prompts)
CREATE TABLE IF NOT EXISTS prompt_instances (
  instance_id TEXT PRIMARY KEY,
  intent_name TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  system_instructions JSONB NOT NULL,
  user_message TEXT NOT NULL,
  sources JSONB NOT NULL,
  constraints JSONB NOT NULL,
  assembled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Prompt executions (LLM calls)
CREATE TABLE IF NOT EXISTS prompt_executions (
  execution_id SERIAL PRIMARY KEY,
  instance_id TEXT REFERENCES prompt_instances(instance_id),
  model_used TEXT NOT NULL,
  tokens_input INTEGER NOT NULL,
  tokens_output INTEGER NOT NULL,
  cost_usd DECIMAL(10, 6) NOT NULL,
  execution_time_ms INTEGER NOT NULL,
  validation_passed BOOLEAN NOT NULL,
  retry_count INTEGER DEFAULT 0,
  output JSONB,
  error TEXT,
  executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_prompt_instances_intent ON prompt_instances(intent_name);
CREATE INDEX IF NOT EXISTS idx_prompt_instances_template ON prompt_instances(template_id);
CREATE INDEX IF NOT EXISTS idx_prompt_instances_assembled_at ON prompt_instances(assembled_at);

CREATE INDEX IF NOT EXISTS idx_prompt_executions_instance ON prompt_executions(instance_id);
CREATE INDEX IF NOT EXISTS idx_prompt_executions_model ON prompt_executions(model_used);
CREATE INDEX IF NOT EXISTS idx_prompt_executions_validation ON prompt_executions(validation_passed);
CREATE INDEX IF NOT EXISTS idx_prompt_executions_executed_at ON prompt_executions(executed_at);

-- Function to calculate prompt metrics
CREATE OR REPLACE FUNCTION get_prompt_metrics(intent_param TEXT, days_param INTEGER DEFAULT 7)
RETURNS TABLE (
  total_executions BIGINT,
  avg_tokens_input NUMERIC,
  avg_tokens_output NUMERIC,
  total_cost_usd NUMERIC,
  avg_execution_time_ms NUMERIC,
  validation_success_rate NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT,
    AVG(tokens_input)::NUMERIC,
    AVG(tokens_output)::NUMERIC,
    SUM(cost_usd)::NUMERIC,
    AVG(execution_time_ms)::NUMERIC,
    (COUNT(*) FILTER (WHERE validation_passed = true)::NUMERIC / NULLIF(COUNT(*)::NUMERIC, 0) * 100)
  FROM prompt_executions pe
  JOIN prompt_instances pi ON pe.instance_id = pi.instance_id
  WHERE pi.intent_name = intent_param
    AND pe.executed_at >= NOW() - (days_param || ' days')::INTERVAL;
END;
$$ LANGUAGE plpgsql;

-- View for prompt performance monitoring
CREATE OR REPLACE VIEW prompt_performance AS
SELECT
  pi.intent_name,
  pi.template_id,
  pi.template_version,
  COUNT(pe.*) as execution_count,
  AVG(pe.tokens_input) as avg_input_tokens,
  AVG(pe.tokens_output) as avg_output_tokens,
  AVG(pe.cost_usd) as avg_cost,
  SUM(pe.cost_usd) as total_cost,
  AVG(pe.execution_time_ms) as avg_latency_ms,
  COUNT(*) FILTER (WHERE pe.validation_passed = true)::NUMERIC / NULLIF(COUNT(*)::NUMERIC, 0) * 100 as success_rate_pct
FROM prompt_instances pi
LEFT JOIN prompt_executions pe ON pi.instance_id = pe.instance_id
WHERE pe.executed_at >= NOW() - INTERVAL '30 days'
GROUP BY pi.intent_name, pi.template_id, pi.template_version
ORDER BY total_cost DESC;

-- Record migration
INSERT INTO migrations (version, description, executed_at)
VALUES (8, 'Add prompt lifecycle tables for ADR-002', CURRENT_TIMESTAMP)
ON CONFLICT (version) DO NOTHING;
