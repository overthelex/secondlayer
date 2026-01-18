-- Migration 004: Add SecondLayer MCP API tracking
-- Adds fields for tracking internal SecondLayer MCP API calls (web scraping, processing)

-- Add SecondLayer MCP cost tracking columns
ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS secondlayer_api_calls INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS secondlayer_cost_usd DECIMAL(10, 6) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS secondlayer_monthly_total INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS secondlayer_calls JSONB DEFAULT '[]';

-- Update monthly_api_usage table for SecondLayer tracking
ALTER TABLE monthly_api_usage
ADD COLUMN IF NOT EXISTS secondlayer_total_calls INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS secondlayer_total_cost_usd DECIMAL(10, 6) DEFAULT 0.00;

-- Create indexes for SecondLayer fields
CREATE INDEX IF NOT EXISTS idx_cost_tracking_secondlayer_calls
  ON cost_tracking(secondlayer_api_calls);
