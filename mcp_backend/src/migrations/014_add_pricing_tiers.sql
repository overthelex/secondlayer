-- Migration: Add pricing tiers to user billing
-- Purpose: Support different pricing tiers (free, startup, business, enterprise, internal)
-- Author: SecondLayer Team
-- Date: 2026-01-29

-- Add pricing_tier column to user_billing table
ALTER TABLE user_billing
ADD COLUMN IF NOT EXISTS pricing_tier VARCHAR(20) DEFAULT 'startup';

-- Add check constraint for valid tier values
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_pricing_tier') THEN
    ALTER TABLE user_billing
    ADD CONSTRAINT check_pricing_tier
      CHECK (pricing_tier IN ('free', 'startup', 'business', 'enterprise', 'internal'));
  END IF;
END $$;

-- Create index for pricing tier queries
CREATE INDEX IF NOT EXISTS idx_user_billing_pricing_tier
  ON user_billing(pricing_tier);

-- Add pricing columns to cost_tracking for transparency
ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS base_cost_usd DECIMAL(10, 6) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS markup_percentage DECIMAL(5, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS markup_amount_usd DECIMAL(10, 6) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS client_tier VARCHAR(20);

-- Update existing records to set base_cost_usd = total_cost_usd (since they were cost pass-through)
UPDATE cost_tracking
SET base_cost_usd = total_cost_usd,
    markup_percentage = 0.00,
    markup_amount_usd = 0.00,
    client_tier = 'free'
WHERE base_cost_usd IS NULL OR base_cost_usd = 0;

-- Add comment for documentation
COMMENT ON COLUMN user_billing.pricing_tier IS 'Pricing tier: free (0% markup), startup (30%), business (50%), enterprise (40%), internal (0%)';
COMMENT ON COLUMN cost_tracking.base_cost_usd IS 'Actual cost before markup (OpenAI + ZakonOnline + SecondLayer)';
COMMENT ON COLUMN cost_tracking.markup_percentage IS 'Applied markup percentage based on user tier';
COMMENT ON COLUMN cost_tracking.markup_amount_usd IS 'Markup amount in USD (base_cost * markup_percentage)';
COMMENT ON COLUMN cost_tracking.client_tier IS 'Client pricing tier at time of request';

-- Update user_billing_summary view to include pricing tier
DROP VIEW IF EXISTS user_billing_summary CASCADE;

CREATE VIEW user_billing_summary AS
SELECT
  u.id AS user_id,
  u.email,
  u.name,
  ub.balance_usd,
  ub.balance_uah,
  ub.total_spent_usd,
  ub.total_requests,
  ub.daily_limit_usd,
  ub.monthly_limit_usd,
  ub.pricing_tier,
  ub.billing_enabled,
  ub.is_active,
  -- Today's spending
  COALESCE(
    (SELECT SUM(total_cost_usd)
     FROM cost_tracking ct
     WHERE ct.user_id = u.id
       AND ct.created_at >= CURRENT_DATE
       AND ct.status = 'completed'),
    0
  ) AS today_spent_usd,
  -- This month's spending
  COALESCE(
    (SELECT SUM(total_cost_usd)
     FROM cost_tracking ct
     WHERE ct.user_id = u.id
       AND ct.created_at >= DATE_TRUNC('month', CURRENT_DATE)
       AND ct.status = 'completed'),
    0
  ) AS month_spent_usd,
  -- Last request timestamp
  (SELECT MAX(created_at)
   FROM cost_tracking ct
   WHERE ct.user_id = u.id) AS last_request_at
FROM users u
LEFT JOIN user_billing ub ON u.id = ub.user_id;

COMMENT ON VIEW user_billing_summary IS 'Real-time billing summary with pricing tier and spending stats per user';

-- Create pricing tier statistics view for admin/analytics
CREATE OR REPLACE VIEW pricing_tier_stats AS
SELECT
  pricing_tier,
  COUNT(*) AS total_users,
  COUNT(*) FILTER (WHERE billing_enabled = true) AS active_users,
  SUM(balance_usd) AS total_balance_usd,
  SUM(total_spent_usd) AS total_spent_usd,
  AVG(total_spent_usd) AS avg_spent_per_user_usd,
  MIN(total_spent_usd) AS min_spent_usd,
  MAX(total_spent_usd) AS max_spent_usd
FROM user_billing
GROUP BY pricing_tier;

COMMENT ON VIEW pricing_tier_stats IS 'Aggregate statistics per pricing tier for business intelligence';
