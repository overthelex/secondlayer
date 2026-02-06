-- Migration 021: Migrate USD Billing to Credit System
-- Converts existing user_billing.balance_usd to user_credits.balance
-- Date: 2026-02-06

-- 1. Create credit_transactions table if it doesn't exist
CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Transaction type: 'deduction', 'purchase', 'bonus', 'refund', 'subscription_grant', 'migration'
  transaction_type VARCHAR(50) NOT NULL,

  -- Amount (positive for additions, negative for deductions)
  amount DECIMAL(10, 2) NOT NULL,

  -- Balance snapshots
  balance_before DECIMAL(10, 2) NOT NULL,
  balance_after DECIMAL(10, 2) NOT NULL,

  -- Source information
  source VARCHAR(255) NOT NULL, -- e.g., 'tool_execution', 'stripe_payment', 'manual_grant', 'migration'
  source_id VARCHAR(255), -- e.g., cost_tracking_id, payment_intent_id, etc.

  -- Description
  description TEXT,

  -- Metadata
  metadata JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_type ON credit_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_source ON credit_transactions(source);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at ON credit_transactions(created_at DESC);

COMMENT ON TABLE credit_transactions IS 'Credit transaction history for user_credits';
COMMENT ON COLUMN credit_transactions.transaction_type IS 'Type: deduction, purchase, bonus, refund, subscription_grant, migration';
COMMENT ON COLUMN credit_transactions.source IS 'Source of transaction (tool name, payment provider, etc.)';

-- 2. Create migration log table
CREATE TABLE IF NOT EXISTS billing_migration_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Old balance
  old_balance_usd DECIMAL(10, 2) NOT NULL,
  old_balance_uah DECIMAL(10, 2) NOT NULL,

  -- New balance (in credits)
  new_credits DECIMAL(10, 2) NOT NULL,

  -- Conversion rate used
  conversion_rate DECIMAL(10, 2) NOT NULL,

  -- Migration status
  status VARCHAR(50) NOT NULL, -- 'success', 'skipped', 'error'
  reason TEXT,

  -- Migration metadata
  migrated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  migrated_by VARCHAR(100) DEFAULT 'migration_021'
);

CREATE INDEX IF NOT EXISTS idx_billing_migration_log_user_id ON billing_migration_log(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_migration_log_status ON billing_migration_log(status);

COMMENT ON TABLE billing_migration_log IS 'Log of user_billing to user_credits migrations';

-- 3. Create migration function
CREATE OR REPLACE FUNCTION migrate_user_billing_to_credits(
  p_conversion_rate DECIMAL DEFAULT 1.0,
  p_dry_run BOOLEAN DEFAULT false
)
RETURNS TABLE (
  user_id UUID,
  email VARCHAR,
  old_balance_usd DECIMAL,
  new_credits DECIMAL,
  status VARCHAR,
  message TEXT
) AS $$
DECLARE
  v_user RECORD;
  v_credits_to_add DECIMAL;
  v_current_credit_balance DECIMAL;
  v_transaction_id UUID;
BEGIN
  -- Loop through all users with billing accounts
  FOR v_user IN
    SELECT
      u.id,
      u.email,
      u.name,
      COALESCE(ub.balance_usd, 0) AS balance_usd,
      COALESCE(ub.balance_uah, 0) AS balance_uah,
      COALESCE(uc.balance, 0) AS current_credit_balance
    FROM users u
    LEFT JOIN user_billing ub ON u.id = ub.user_id
    LEFT JOIN user_credits uc ON u.id = uc.user_id
    WHERE ub.balance_usd > 0 OR ub.balance_uah > 0
    ORDER BY u.created_at
  LOOP
    -- Calculate credits to add (USD balance * conversion rate)
    v_credits_to_add := v_user.balance_usd * p_conversion_rate;
    v_current_credit_balance := COALESCE(v_user.current_credit_balance, 0);

    -- Skip if zero credits to add
    IF v_credits_to_add <= 0 THEN
      RETURN QUERY SELECT
        v_user.id,
        v_user.email::VARCHAR,
        v_user.balance_usd,
        0::DECIMAL,
        'skipped'::VARCHAR,
        'No positive USD balance to migrate'::TEXT;

      INSERT INTO billing_migration_log (
        user_id, old_balance_usd, old_balance_uah, new_credits, conversion_rate, status, reason
      ) VALUES (
        v_user.id, v_user.balance_usd, v_user.balance_uah, 0, p_conversion_rate, 'skipped', 'No positive USD balance'
      );

      CONTINUE;
    END IF;

    -- Dry run mode
    IF p_dry_run THEN
      RETURN QUERY SELECT
        v_user.id,
        v_user.email::VARCHAR,
        v_user.balance_usd,
        v_credits_to_add,
        'dry_run'::VARCHAR,
        format('Would migrate $%s to %s credits (current: %s)', v_user.balance_usd, v_credits_to_add, v_current_credit_balance)::TEXT;
      CONTINUE;
    END IF;

    -- Actual migration
    BEGIN
      -- Ensure user_credits record exists
      INSERT INTO user_credits (user_id, balance, total_earned)
      VALUES (v_user.id, 0, 0)
      ON CONFLICT (user_id) DO NOTHING;

      -- Add credits using the add_credits function
      SELECT transaction_id INTO v_transaction_id
      FROM add_credits(
        v_user.id,
        v_credits_to_add,
        'migration',
        'billing_usd_to_credits',
        'migration_021',
        format('Migrated from user_billing: $%s USD → %s credits (rate: %sx)',
               v_user.balance_usd, v_credits_to_add, p_conversion_rate),
        NULL
      );

      -- Zero out the old billing balance (keep history but mark as migrated)
      UPDATE user_billing ub
      SET balance_usd = 0,
          updated_at = NOW()
      WHERE ub.user_id = v_user.id;

      -- Log successful migration
      INSERT INTO billing_migration_log (
        user_id, old_balance_usd, old_balance_uah, new_credits, conversion_rate, status, reason
      ) VALUES (
        v_user.id, v_user.balance_usd, v_user.balance_uah, v_credits_to_add, p_conversion_rate,
        'success', format('Migrated successfully (txn: %s)', v_transaction_id)
      );

      RETURN QUERY SELECT
        v_user.id,
        v_user.email::VARCHAR,
        v_user.balance_usd,
        v_credits_to_add,
        'success'::VARCHAR,
        format('Migrated $%s → %s credits', v_user.balance_usd, v_credits_to_add)::TEXT;

    EXCEPTION WHEN OTHERS THEN
      -- Log error
      INSERT INTO billing_migration_log (
        user_id, old_balance_usd, old_balance_uah, new_credits, conversion_rate, status, reason
      ) VALUES (
        v_user.id, v_user.balance_usd, v_user.balance_uah, 0, p_conversion_rate,
        'error', SQLERRM
      );

      RETURN QUERY SELECT
        v_user.id,
        v_user.email::VARCHAR,
        v_user.balance_usd,
        0::DECIMAL,
        'error'::VARCHAR,
        SQLERRM::TEXT;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION migrate_user_billing_to_credits IS 'Migrate user_billing.balance_usd to user_credits.balance';

-- 4. Create helper view for migration status
CREATE OR REPLACE VIEW billing_migration_status AS
SELECT
  u.id AS user_id,
  u.email,
  u.name,
  -- Old system
  COALESCE(ub.balance_usd, 0) AS old_balance_usd,
  COALESCE(ub.balance_uah, 0) AS old_balance_uah,
  -- New system
  COALESCE(uc.balance, 0) AS credit_balance,
  COALESCE(uc.total_earned, 0) AS total_credits_earned,
  COALESCE(uc.total_spent, 0) AS total_credits_spent,
  -- Migration status
  CASE
    WHEN ml.user_id IS NOT NULL THEN ml.status
    WHEN ub.balance_usd > 0 OR ub.balance_uah > 0 THEN 'pending_migration'
    ELSE 'no_migration_needed'
  END AS migration_status,
  ml.migrated_at,
  ml.reason AS migration_reason
FROM users u
LEFT JOIN user_billing ub ON u.id = ub.user_id
LEFT JOIN user_credits uc ON u.id = uc.user_id
LEFT JOIN billing_migration_log ml ON u.id = ml.user_id;

COMMENT ON VIEW billing_migration_status IS 'Shows migration status for all users';

-- 5. Run dry-run migration to show what would be migrated
DO $$
DECLARE
  v_result RECORD;
  v_total_users INTEGER := 0;
  v_total_usd DECIMAL := 0;
  v_total_credits DECIMAL := 0;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE '  Migration 021: Billing USD → Credits (DRY RUN)';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE '';

  FOR v_result IN
    SELECT * FROM migrate_user_billing_to_credits(1.0, true)
  LOOP
    v_total_users := v_total_users + 1;
    v_total_usd := v_total_usd + v_result.old_balance_usd;
    v_total_credits := v_total_credits + v_result.new_credits;

    RAISE NOTICE 'User: % (%) - $% → % credits - %',
      v_result.email,
      v_result.user_id,
      v_result.old_balance_usd,
      v_result.new_credits,
      v_result.message;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '────────────────────────────────────────────────────────────────';
  RAISE NOTICE 'Summary:';
  RAISE NOTICE '  Users to migrate: %', v_total_users;
  RAISE NOTICE '  Total USD: $%', v_total_usd;
  RAISE NOTICE '  Total credits: %', v_total_credits;
  RAISE NOTICE '────────────────────────────────────────────────────────────────';
  RAISE NOTICE '';
  RAISE NOTICE '⚠️  This was a DRY RUN - no changes were made';
  RAISE NOTICE '';
  RAISE NOTICE 'To execute migration:';
  RAISE NOTICE '  SELECT * FROM migrate_user_billing_to_credits(1.0, false);';
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
END $$;
