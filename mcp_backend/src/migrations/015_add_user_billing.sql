-- Migration 015: Add User Billing Infrastructure
-- Adds user_id tracking to cost_tracking and creates billing tables

-- 1. Add user_id to cost_tracking table
ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cost_tracking_user_id ON cost_tracking(user_id);

COMMENT ON COLUMN cost_tracking.user_id IS 'User who made the request (for billing)';

-- 2. Create user_billing table (balance and limits)
CREATE TABLE IF NOT EXISTS user_billing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Balance (USD and UAH)
  balance_usd DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,
  balance_uah DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,

  -- Limits
  daily_limit_usd DECIMAL(10, 2) DEFAULT 10.00 NOT NULL,
  monthly_limit_usd DECIMAL(10, 2) DEFAULT 100.00 NOT NULL,

  -- Statistics
  total_spent_usd DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,
  total_spent_uah DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,
  total_requests INTEGER DEFAULT 0 NOT NULL,

  -- Status
  is_active BOOLEAN DEFAULT true NOT NULL,
  billing_enabled BOOLEAN DEFAULT true NOT NULL,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_billing_user_id ON user_billing(user_id);
CREATE INDEX IF NOT EXISTS idx_user_billing_is_active ON user_billing(is_active);

COMMENT ON TABLE user_billing IS 'User billing accounts with balances and limits';
COMMENT ON COLUMN user_billing.balance_usd IS 'Current balance in USD';
COMMENT ON COLUMN user_billing.daily_limit_usd IS 'Maximum daily spending limit';
COMMENT ON COLUMN user_billing.monthly_limit_usd IS 'Maximum monthly spending limit';
COMMENT ON COLUMN user_billing.billing_enabled IS 'Whether billing is enabled for this user';

-- 3. Create billing_transactions table (transaction history)
CREATE TABLE IF NOT EXISTS billing_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Transaction type: 'charge', 'refund', 'topup', 'adjustment'
  type VARCHAR(50) NOT NULL,

  -- Amounts
  amount_usd DECIMAL(10, 2) NOT NULL,
  amount_uah DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,

  -- Balance snapshots
  balance_before_usd DECIMAL(10, 2) NOT NULL,
  balance_after_usd DECIMAL(10, 2) NOT NULL,

  -- References
  request_id VARCHAR(255), -- Link to cost_tracking.request_id
  payment_provider VARCHAR(50), -- 'stripe', 'fondy', 'manual', etc.
  payment_id VARCHAR(255), -- External payment ID

  -- Metadata
  description TEXT,
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_transactions_user_id ON billing_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_transactions_type ON billing_transactions(type);
CREATE INDEX IF NOT EXISTS idx_billing_transactions_request_id ON billing_transactions(request_id);
CREATE INDEX IF NOT EXISTS idx_billing_transactions_created_at ON billing_transactions(created_at DESC);

COMMENT ON TABLE billing_transactions IS 'All billing transactions (charges, refunds, top-ups)';
COMMENT ON COLUMN billing_transactions.type IS 'Transaction type: charge, refund, topup, adjustment';
COMMENT ON COLUMN billing_transactions.request_id IS 'Link to cost_tracking for charges';

-- 4. Create trigger to auto-update updated_at on user_billing
CREATE OR REPLACE FUNCTION update_user_billing_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_user_billing_updated_at ON user_billing;
CREATE TRIGGER trigger_update_user_billing_updated_at
  BEFORE UPDATE ON user_billing
  FOR EACH ROW
  EXECUTE FUNCTION update_user_billing_updated_at();

-- 5. Create view for user billing summary
CREATE OR REPLACE VIEW user_billing_summary AS
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
  ub.is_active,
  ub.billing_enabled,
  -- Today's spending
  COALESCE(
    (SELECT SUM(ct.total_cost_usd)
     FROM cost_tracking ct
     WHERE ct.user_id = u.id
       AND ct.created_at >= CURRENT_DATE
       AND ct.status = 'completed'),
    0
  ) AS today_spent_usd,
  -- This month's spending
  COALESCE(
    (SELECT SUM(ct.total_cost_usd)
     FROM cost_tracking ct
     WHERE ct.user_id = u.id
       AND ct.created_at >= DATE_TRUNC('month', CURRENT_DATE)
       AND ct.status = 'completed'),
    0
  ) AS month_spent_usd,
  -- Last request
  (SELECT MAX(ct.created_at)
   FROM cost_tracking ct
   WHERE ct.user_id = u.id) AS last_request_at,
  ub.created_at AS billing_created_at,
  ub.updated_at AS billing_updated_at
FROM users u
LEFT JOIN user_billing ub ON u.id = ub.user_id;

COMMENT ON VIEW user_billing_summary IS 'Complete user billing information with real-time spending stats';

-- 6. Initialize billing accounts for existing users
INSERT INTO user_billing (user_id, balance_usd, balance_uah)
SELECT
  id,
  0.00 AS balance_usd,
  0.00 AS balance_uah
FROM users
WHERE id NOT IN (SELECT user_id FROM user_billing)
ON CONFLICT (user_id) DO NOTHING;

-- 7. Grant appropriate permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE ON user_billing TO secondlayer_app;
-- GRANT SELECT, INSERT ON billing_transactions TO secondlayer_app;
-- GRANT SELECT ON user_billing_summary TO secondlayer_app;
