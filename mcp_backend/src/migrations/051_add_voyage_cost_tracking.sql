-- Migration 051: Add VoyageAI cost tracking to cost_tracking and monthly_api_usage

-- Add VoyageAI columns to cost_tracking
ALTER TABLE cost_tracking
  ADD COLUMN IF NOT EXISTS voyage_cost_usd DECIMAL(12,8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voyage_total_tokens INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voyage_calls JSONB DEFAULT '[]'::jsonb;

-- Add VoyageAI columns to monthly_api_usage
ALTER TABLE monthly_api_usage
  ADD COLUMN IF NOT EXISTS voyage_total_tokens INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voyage_total_cost_usd DECIMAL(12,8) DEFAULT 0;
