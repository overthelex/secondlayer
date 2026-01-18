-- Migration 003: Add cost tracking tables
-- This migration adds tables for tracking API costs (OpenAI and ZakonOnline)

-- Main cost tracking table
CREATE TABLE IF NOT EXISTS cost_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Request identification
  request_id VARCHAR(255) UNIQUE NOT NULL,
  tool_name VARCHAR(100) NOT NULL,
  client_key VARCHAR(100),

  -- User query info
  user_query TEXT,
  query_params JSONB DEFAULT '{}',

  -- OpenAI costs (USD)
  openai_total_tokens INTEGER DEFAULT 0,
  openai_prompt_tokens INTEGER DEFAULT 0,
  openai_completion_tokens INTEGER DEFAULT 0,
  openai_cost_usd DECIMAL(10, 6) DEFAULT 0.00,
  openai_calls JSONB DEFAULT '[]', -- [{model, tokens, cost, task, timestamp}]

  -- ZakonOnline costs (UAH)
  zakononline_api_calls INTEGER DEFAULT 0,
  zakononline_cost_uah DECIMAL(10, 2) DEFAULT 0.00,
  zakononline_monthly_total INTEGER DEFAULT 0, -- Total API calls this month before this request
  zakononline_calls JSONB DEFAULT '[]', -- [{endpoint, timestamp, cached}]

  -- Total costs
  total_cost_usd DECIMAL(10, 6) DEFAULT 0.00,
  total_cost_uah DECIMAL(10, 2) DEFAULT 0.00,

  -- Metadata
  execution_time_ms INTEGER,
  status VARCHAR(50) DEFAULT 'pending', -- pending, completed, failed
  error_message TEXT,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Indexes for cost_tracking
CREATE INDEX IF NOT EXISTS idx_cost_tracking_request_id ON cost_tracking(request_id);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_tool_name ON cost_tracking(tool_name);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_client_key ON cost_tracking(client_key);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_created_at ON cost_tracking(created_at);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_status ON cost_tracking(status);

-- Monthly statistics table for ZakonOnline tier calculation
CREATE TABLE IF NOT EXISTS monthly_api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year_month VARCHAR(7) NOT NULL, -- 'YYYY-MM' format
  zakononline_total_calls INTEGER DEFAULT 0,
  zakononline_total_cost_uah DECIMAL(10, 2) DEFAULT 0.00,
  openai_total_tokens INTEGER DEFAULT 0,
  openai_total_cost_usd DECIMAL(10, 6) DEFAULT 0.00,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(year_month)
);

-- Index for monthly_api_usage
CREATE INDEX IF NOT EXISTS idx_monthly_usage_year_month ON monthly_api_usage(year_month);
