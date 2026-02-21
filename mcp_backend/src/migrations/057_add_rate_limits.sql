-- Migration 057: Add rate limit columns to model_capabilities
-- Data source: Anthropic Console rate limits screenshot (2026-02-20)
-- These reflect current account tier limits (may vary by tier/plan)

ALTER TABLE model_capabilities
  ADD COLUMN IF NOT EXISTS rate_limit_rpm     INTEGER,   -- requests per minute
  ADD COLUMN IF NOT EXISTS rate_limit_itpm    INTEGER,   -- input tokens per minute
  ADD COLUMN IF NOT EXISTS rate_limit_otpm    INTEGER,   -- output tokens per minute
  ADD COLUMN IF NOT EXISTS rate_limit_batch_rpm INTEGER, -- batch requests per minute (shared across models)
  ADD COLUMN IF NOT EXISTS rate_limit_tier    VARCHAR(50) DEFAULT 'default'; -- tier label

-- ----------------------------------------------------------------
-- Anthropic rate limits (account tier as of 2026-02-20)
-- ----------------------------------------------------------------

-- Sonnet Active (claude-sonnet-4-6, claude-sonnet-4-5-20250929)
UPDATE model_capabilities SET
  rate_limit_rpm       = 50,
  rate_limit_itpm      = 30000,
  rate_limit_otpm      = 8000,
  rate_limit_batch_rpm = 50,
  rate_limit_tier      = 'default'
WHERE provider = 'anthropic'
  AND model IN ('claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514');

-- Opus Active (claude-opus-4-6, claude-opus-4-5-20251101, claude-opus-4-1-20250805, claude-opus-4-20250514)
UPDATE model_capabilities SET
  rate_limit_rpm       = 50,
  rate_limit_itpm      = 30000,
  rate_limit_otpm      = 8000,
  rate_limit_batch_rpm = 50,
  rate_limit_tier      = 'default'
WHERE provider = 'anthropic'
  AND model IN (
    'claude-opus-4-6',
    'claude-opus-4-5-20251101',
    'claude-opus-4-1-20250805',
    'claude-opus-4-20250514'
  );

-- Haiku Active (claude-haiku-4-5-20251001)
UPDATE model_capabilities SET
  rate_limit_rpm       = 50,
  rate_limit_itpm      = 50000,
  rate_limit_otpm      = 10000,
  rate_limit_batch_rpm = 50,
  rate_limit_tier      = 'default'
WHERE provider = 'anthropic'
  AND model = 'claude-haiku-4-5-20251001';

-- Haiku 3 (claude-3-haiku-20240307)
UPDATE model_capabilities SET
  rate_limit_rpm       = 50,
  rate_limit_itpm      = 50000,
  rate_limit_otpm      = 10000,
  rate_limit_batch_rpm = 50,
  rate_limit_tier      = 'default'
WHERE provider = 'anthropic'
  AND model = 'claude-3-haiku-20240307';
