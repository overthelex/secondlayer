-- Migration 052: Remove Stripe/Fondy, update schema for Monobank
-- Date: 2026-02-20

BEGIN;

-- Remove provider-specific customer ID columns
ALTER TABLE user_billing DROP COLUMN IF EXISTS stripe_customer_id;
ALTER TABLE user_billing DROP COLUMN IF EXISTS fondy_customer_id;

-- Update payment_methods provider CHECK constraint
ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_provider_check;

ALTER TABLE payment_methods
  ADD CONSTRAINT payment_methods_provider_check
  CHECK (provider IN ('monobank', 'metamask'));

-- Update get_or_create_payment_intent function provider check
CREATE OR REPLACE FUNCTION get_or_create_payment_intent(
  p_user_id UUID,
  p_amount_usd NUMERIC,
  p_provider TEXT,
  p_metadata JSONB DEFAULT '{}'::JSONB
) RETURNS TABLE(
  payment_intent_id UUID,
  status TEXT,
  created BOOLEAN
) LANGUAGE plpgsql AS $$
BEGIN
  IF p_provider NOT IN ('metamask', 'monobank') THEN
    RAISE EXCEPTION 'Invalid provider: %. Must be metamask or monobank', p_provider;
  END IF;

  -- Try to find existing pending intent
  RETURN QUERY
  SELECT
    pi.id AS payment_intent_id,
    pi.status,
    FALSE AS created
  FROM payment_intents pi
  WHERE pi.user_id = p_user_id
    AND pi.provider = p_provider
    AND pi.status = 'pending'
    AND pi.created_at > NOW() - INTERVAL '1 hour'
  ORDER BY pi.created_at DESC
  LIMIT 1;

  IF FOUND THEN RETURN; END IF;

  -- Create new intent
  RETURN QUERY
  INSERT INTO payment_intents (user_id, amount_usd, provider, status, metadata)
  VALUES (p_user_id, p_amount_usd, p_provider, 'pending', p_metadata)
  RETURNING id AS payment_intent_id, status, TRUE AS created;
END;
$$;

-- Recreate add_credits with provider-agnostic parameter name
-- (replaces p_stripe_payment_intent_id → p_payment_reference)
DROP FUNCTION IF EXISTS add_credits(UUID, DECIMAL, VARCHAR, VARCHAR, VARCHAR, TEXT, VARCHAR);

CREATE OR REPLACE FUNCTION add_credits(
  p_user_id UUID,
  p_amount DECIMAL,
  p_transaction_type VARCHAR,
  p_source VARCHAR,
  p_source_id VARCHAR,
  p_description TEXT,
  p_payment_reference VARCHAR
)
RETURNS TABLE (
  success BOOLEAN,
  new_balance NUMERIC,
  transaction_id UUID
) AS $$
DECLARE
  v_current_balance DECIMAL(10, 2);
  v_new_balance DECIMAL(10, 2);
  v_transaction_id UUID;
BEGIN
  -- Get current balance with row lock
  SELECT balance INTO v_current_balance
  FROM user_credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- If user not found, initialize
  IF NOT FOUND THEN
    INSERT INTO user_credits (user_id, balance)
    VALUES (p_user_id, 0)
    RETURNING balance INTO v_current_balance;
  END IF;

  -- Calculate new balance
  v_new_balance := v_current_balance + p_amount;

  -- Update balance
  UPDATE user_credits
  SET balance = v_new_balance,
      total_earned = total_earned + p_amount,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  -- Create transaction record (if credit_transactions table exists)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'credit_transactions') THEN
    INSERT INTO credit_transactions (
      user_id,
      transaction_type,
      amount,
      balance_before,
      balance_after,
      source,
      source_id,
      description,
      metadata
    ) VALUES (
      p_user_id,
      p_transaction_type,
      p_amount,
      v_current_balance,
      v_new_balance,
      p_source,
      p_source_id,
      p_description,
      jsonb_build_object('payment_reference', p_payment_reference)
    )
    RETURNING id INTO v_transaction_id;
  ELSE
    v_transaction_id := gen_random_uuid();
  END IF;

  RETURN QUERY SELECT true, v_new_balance, v_transaction_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION add_credits IS 'Add credits to user balance with transaction logging';

COMMIT;
