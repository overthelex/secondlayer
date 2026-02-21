-- Migration 052: Remove Stripe/Fondy, update schema for Monobank
-- Date: 2026-02-20

BEGIN;

-- Remove provider-specific customer ID columns
ALTER TABLE user_billing DROP COLUMN IF EXISTS stripe_customer_id;
ALTER TABLE user_billing DROP COLUMN IF EXISTS fondy_customer_id;

-- Update payment_methods provider CHECK constraint
-- DROP CONSTRAINT IF EXISTS handles the "does not exist" case without EXCEPTION
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

COMMIT;
