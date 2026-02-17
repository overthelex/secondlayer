-- Migration 042: Add billing management tables
-- billing_tiers, volume_discount_thresholds, subscriptions
-- ALTER organizations for billing fields

BEGIN;

-- ========================================
-- 1. billing_tiers
-- ========================================
CREATE TABLE IF NOT EXISTS billing_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_key VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  markup_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
  description TEXT,
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_daily_limit_usd NUMERIC(10,2) NOT NULL DEFAULT 10.00,
  default_monthly_limit_usd NUMERIC(10,2) NOT NULL DEFAULT 100.00,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_tiers_tier_key ON billing_tiers(tier_key);
CREATE INDEX IF NOT EXISTS idx_billing_tiers_is_active ON billing_tiers(is_active);

-- ========================================
-- 2. volume_discount_thresholds
-- ========================================
CREATE TABLE IF NOT EXISTS volume_discount_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  min_monthly_spend_usd NUMERIC(10,2) NOT NULL,
  discount_percentage NUMERIC(5,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_volume_discounts_spend ON volume_discount_thresholds(min_monthly_spend_usd);

-- ========================================
-- 3. subscriptions
-- ========================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  tier_key VARCHAR(50) NOT NULL REFERENCES billing_tiers(tier_key),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('trial', 'active', 'past_due', 'canceled', 'expired')),
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'quarterly', 'annual')),
  price_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  next_billing_date TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscriptions_user_or_org CHECK (
    (user_id IS NOT NULL AND organization_id IS NULL) OR
    (user_id IS NULL AND organization_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing ON subscriptions(next_billing_date) WHERE status = 'active';

-- ========================================
-- 4. ALTER organizations for billing
-- ========================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'billing_email'
  ) THEN
    ALTER TABLE organizations ADD COLUMN billing_email VARCHAR(255);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'billing_tier_key'
  ) THEN
    ALTER TABLE organizations ADD COLUMN billing_tier_key VARCHAR(50) REFERENCES billing_tiers(tier_key);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'balance_usd'
  ) THEN
    ALTER TABLE organizations ADD COLUMN balance_usd NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'total_spent_usd'
  ) THEN
    ALTER TABLE organizations ADD COLUMN total_spent_usd NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- ========================================
-- 5. Seed billing_tiers with current hardcoded values
-- ========================================
INSERT INTO billing_tiers (tier_key, display_name, markup_percentage, description, features, default_daily_limit_usd, default_monthly_limit_usd, is_default, sort_order)
VALUES
  ('free', 'Free', 0, 'Free tier - cost pass-through (early adopters, testing)',
   '["Full access to all tools", "Cost transparency (you pay what we pay)", "Community support", "Rate limits apply"]'::jsonb,
   5.00, 50.00, false, 0),
  ('startup', 'Startup', 30, 'Startup tier - 30% markup (standard commercial)',
   '["Full access to all tools", "30% markup on API costs", "Email support (24-48h response)", "Standard rate limits", "Monthly usage reports"]'::jsonb,
   10.00, 100.00, true, 1),
  ('business', 'Business', 50, 'Business tier - 50% markup (premium + priority)',
   '["Full access to all tools", "50% markup on API costs", "Priority email support (12h response)", "Higher rate limits", "Dedicated account manager", "Custom integrations support", "Advanced analytics dashboard"]'::jsonb,
   50.00, 500.00, false, 2),
  ('enterprise', 'Enterprise', 40, 'Enterprise tier - Custom pricing (negotiated)',
   '["Full access to all tools", "40% markup (negotiable)", "Priority 24/7 support", "No rate limits", "Dedicated infrastructure", "SLA guarantees (99.9% uptime)", "Custom tool development", "On-premise deployment options"]'::jsonb,
   1000.00, 10000.00, false, 3),
  ('internal', 'Internal', 0, 'Internal use - no markup',
   '["Internal SecondLayer team usage", "Cost pass-through for testing/development"]'::jsonb,
   1000.00, 10000.00, false, 4)
ON CONFLICT (tier_key) DO NOTHING;

-- ========================================
-- 6. Seed volume_discount_thresholds
-- ========================================
INSERT INTO volume_discount_thresholds (min_monthly_spend_usd, discount_percentage)
SELECT * FROM (VALUES
  (250.00, 5.00),
  (500.00, 10.00),
  (1000.00, 15.00)
) AS v(min_monthly_spend_usd, discount_percentage)
WHERE NOT EXISTS (SELECT 1 FROM volume_discount_thresholds LIMIT 1);

-- ========================================
-- 7. updated_at trigger for new tables
-- ========================================
DO $$ BEGIN
  CREATE TRIGGER update_billing_tiers_updated_at
    BEFORE UPDATE ON billing_tiers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER update_volume_discount_thresholds_updated_at
    BEFORE UPDATE ON volume_discount_thresholds
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
