-- Migration 043: Add Anthropic cost tracking columns to cost_tracking table
-- These columns are referenced by /api/admin/stats/cost-breakdown endpoint

ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS anthropic_cost_usd DECIMAL(10, 6) DEFAULT 0.00;

ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS anthropic_calls JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_cost_tracking_anthropic_cost
  ON cost_tracking(anthropic_cost_usd);
