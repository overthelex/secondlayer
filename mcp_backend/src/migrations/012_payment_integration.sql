-- Migration 012: Payment Integration
-- Adds payment tracking fields and idempotency tables

-- 1. Add payment tracking fields to user_billing
ALTER TABLE user_billing
ADD COLUMN IF NOT EXISTS last_alert_sent_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS fondy_customer_id VARCHAR(255);

COMMENT ON COLUMN user_billing.last_alert_sent_at IS 'Last time low balance alert was sent';
COMMENT ON COLUMN user_billing.stripe_customer_id IS 'Stripe customer ID for recurring payments';
COMMENT ON COLUMN user_billing.fondy_customer_id IS 'Fondy customer ID for recurring payments';

-- 2. Add indexes for payment lookups on billing_transactions
CREATE INDEX IF NOT EXISTS idx_billing_transactions_payment_id
  ON billing_transactions(payment_id);

CREATE INDEX IF NOT EXISTS idx_billing_transactions_payment_provider
  ON billing_transactions(payment_provider);

COMMENT ON INDEX idx_billing_transactions_payment_id IS 'Fast lookup by payment ID for webhook processing';
COMMENT ON INDEX idx_billing_transactions_payment_provider IS 'Fast lookup by payment provider (stripe, fondy)';

-- 3. Create payment_intents table for idempotency and webhook deduplication
CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Payment provider and external ID
  provider VARCHAR(50) NOT NULL, -- 'stripe', 'fondy'
  external_id VARCHAR(255) NOT NULL, -- PaymentIntent ID or Order ID

  -- Amounts
  amount_usd DECIMAL(10, 2) NOT NULL,
  amount_uah DECIMAL(10, 2),

  -- Status tracking
  status VARCHAR(50) NOT NULL, -- 'pending', 'processing', 'succeeded', 'failed', 'canceled'

  -- Metadata
  metadata JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Ensure uniqueness per provider/external_id
  UNIQUE(provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_user_id
  ON payment_intents(user_id);

CREATE INDEX IF NOT EXISTS idx_payment_intents_provider_external_id
  ON payment_intents(provider, external_id);

CREATE INDEX IF NOT EXISTS idx_payment_intents_status
  ON payment_intents(status);

CREATE INDEX IF NOT EXISTS idx_payment_intents_created_at
  ON payment_intents(created_at DESC);

COMMENT ON TABLE payment_intents IS 'Payment intents for idempotency and webhook deduplication';
COMMENT ON COLUMN payment_intents.provider IS 'Payment provider: stripe or fondy';
COMMENT ON COLUMN payment_intents.external_id IS 'External payment ID from provider';
COMMENT ON COLUMN payment_intents.status IS 'Payment status: pending, processing, succeeded, failed, canceled';

-- 4. Create trigger to auto-update updated_at on payment_intents
CREATE OR REPLACE FUNCTION update_payment_intents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_payment_intents_updated_at ON payment_intents;
CREATE TRIGGER trigger_update_payment_intents_updated_at
  BEFORE UPDATE ON payment_intents
  FOR EACH ROW
  EXECUTE FUNCTION update_payment_intents_updated_at();

-- 5. Add function to check for existing payment intent (idempotency)
CREATE OR REPLACE FUNCTION get_or_create_payment_intent(
  p_user_id UUID,
  p_provider VARCHAR(50),
  p_external_id VARCHAR(255),
  p_amount_usd DECIMAL(10, 2),
  p_amount_uah DECIMAL(10, 2),
  p_status VARCHAR(50),
  p_metadata JSONB
)
RETURNS payment_intents AS $$
DECLARE
  v_intent payment_intents;
BEGIN
  -- Try to get existing intent
  SELECT * INTO v_intent
  FROM payment_intents
  WHERE provider = p_provider
    AND external_id = p_external_id;

  -- If not found, create new
  IF NOT FOUND THEN
    INSERT INTO payment_intents (
      user_id, provider, external_id,
      amount_usd, amount_uah, status, metadata
    ) VALUES (
      p_user_id, p_provider, p_external_id,
      p_amount_usd, p_amount_uah, p_status, p_metadata
    )
    RETURNING * INTO v_intent;
  END IF;

  RETURN v_intent;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_or_create_payment_intent IS 'Get existing or create new payment intent for idempotency';

-- 6. Grant appropriate permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE ON payment_intents TO secondlayer_app;
-- GRANT EXECUTE ON FUNCTION get_or_create_payment_intent TO secondlayer_app;
