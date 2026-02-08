-- Migration 023: Add Email Notification Preferences
-- Adds email notification preference columns to user_billing table

-- Add email notification preference columns
ALTER TABLE user_billing
ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS notify_low_balance BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS notify_payment_success BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS notify_payment_failure BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS notify_monthly_report BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS low_balance_threshold_usd DECIMAL(10, 2) DEFAULT 5.00;

COMMENT ON COLUMN user_billing.email_notifications IS 'Master toggle for all email notifications';
COMMENT ON COLUMN user_billing.notify_low_balance IS 'Send email when balance falls below threshold';
COMMENT ON COLUMN user_billing.notify_payment_success IS 'Send email on successful payment';
COMMENT ON COLUMN user_billing.notify_payment_failure IS 'Send email on failed payment';
COMMENT ON COLUMN user_billing.notify_monthly_report IS 'Send monthly usage report';
COMMENT ON COLUMN user_billing.low_balance_threshold_usd IS 'Balance threshold for low balance alerts (USD)';

-- Update user_billing_summary view to include new fields
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
  ub.email_notifications,
  ub.notify_low_balance,
  ub.notify_payment_success,
  ub.notify_payment_failure,
  ub.notify_monthly_report,
  ub.low_balance_threshold_usd,
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

COMMENT ON VIEW user_billing_summary IS 'Real-time billing summary with email preferences and spending stats per user';
