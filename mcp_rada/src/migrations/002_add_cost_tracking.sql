-- Migration 002: Add cost tracking tables
-- This migration adds tables for tracking API costs (OpenAI, Anthropic, RADA APIs)

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

  -- Anthropic costs (USD)
  anthropic_total_tokens INTEGER DEFAULT 0,
  anthropic_prompt_tokens INTEGER DEFAULT 0,
  anthropic_completion_tokens INTEGER DEFAULT 0,
  anthropic_cost_usd DECIMAL(10, 6) DEFAULT 0.00,
  anthropic_calls JSONB DEFAULT '[]', -- [{model, tokens, cost, task, timestamp}]

  -- RADA API usage (FREE but track bandwidth and rate limits)
  rada_api_calls INTEGER DEFAULT 0,
  rada_api_cached INTEGER DEFAULT 0,
  rada_api_bytes INTEGER DEFAULT 0,
  rada_calls JSONB DEFAULT '[]', -- [{endpoint, timestamp, cached, bytes}]

  -- SecondLayer API calls (for cross-referencing)
  secondlayer_api_calls INTEGER DEFAULT 0,
  secondlayer_cost_usd DECIMAL(10, 6) DEFAULT 0.00,
  secondlayer_calls JSONB DEFAULT '[]', -- [{tool_name, timestamp, cost}]

  -- Total costs
  total_cost_usd DECIMAL(10, 6) DEFAULT 0.00,

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

-- Monthly statistics table for API usage analytics
CREATE TABLE IF NOT EXISTS monthly_api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year_month VARCHAR(7) NOT NULL, -- 'YYYY-MM' format

  -- OpenAI
  openai_total_tokens INTEGER DEFAULT 0,
  openai_total_cost_usd DECIMAL(10, 6) DEFAULT 0.00,

  -- Anthropic
  anthropic_total_tokens INTEGER DEFAULT 0,
  anthropic_total_cost_usd DECIMAL(10, 6) DEFAULT 0.00,

  -- RADA API (free but track usage)
  rada_total_calls INTEGER DEFAULT 0,
  rada_total_cached INTEGER DEFAULT 0,
  rada_total_bytes BIGINT DEFAULT 0,

  -- SecondLayer
  secondlayer_total_calls INTEGER DEFAULT 0,
  secondlayer_total_cost_usd DECIMAL(10, 6) DEFAULT 0.00,

  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(year_month)
);

-- Index for monthly_api_usage
CREATE INDEX IF NOT EXISTS idx_monthly_usage_year_month ON monthly_api_usage(year_month);

-- Tool usage statistics (for analytics)
CREATE TABLE IF NOT EXISTS tool_usage_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name VARCHAR(100) NOT NULL,
  year_month VARCHAR(7) NOT NULL,

  -- Usage counts
  total_calls INTEGER DEFAULT 0,
  successful_calls INTEGER DEFAULT 0,
  failed_calls INTEGER DEFAULT 0,

  -- Performance
  avg_execution_time_ms INTEGER DEFAULT 0,
  max_execution_time_ms INTEGER DEFAULT 0,
  min_execution_time_ms INTEGER DEFAULT 0,

  -- Costs
  total_cost_usd DECIMAL(10, 6) DEFAULT 0.00,

  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tool_name, year_month)
);

CREATE INDEX IF NOT EXISTS idx_tool_stats_tool_name ON tool_usage_stats(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_stats_year_month ON tool_usage_stats(year_month);
