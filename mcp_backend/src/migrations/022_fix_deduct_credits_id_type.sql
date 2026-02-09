-- Migration 022: Fix deduct_credits function parameter type
-- Change p_cost_tracking_id from UUID to VARCHAR to support string request IDs
-- Date: 2026-02-06

-- Drop both existing overloads (UUID and VARCHAR versions)
DROP FUNCTION IF EXISTS deduct_credits(UUID, DECIMAL, VARCHAR, UUID, TEXT);
DROP FUNCTION IF EXISTS deduct_credits(UUID, DECIMAL, VARCHAR, VARCHAR, TEXT);

-- Recreate with VARCHAR parameter
CREATE OR REPLACE FUNCTION deduct_credits(
  p_user_id UUID,
  p_amount DECIMAL,
  p_tool_name VARCHAR,
  p_cost_tracking_id VARCHAR,  -- Changed from UUID to VARCHAR
  p_description TEXT
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
    ON CONFLICT (user_id) DO NOTHING;

    v_current_balance := 0;
  END IF;

  -- Check if sufficient balance
  IF v_current_balance < p_amount THEN
    RETURN QUERY SELECT false, v_current_balance, NULL::UUID;
    RETURN;
  END IF;

  -- Calculate new balance
  v_new_balance := v_current_balance - p_amount;

  -- Update balance
  UPDATE user_credits
  SET balance = v_new_balance,
      total_spent = total_spent + p_amount,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  -- Create transaction record (if credit_transactions table exists)
  IF EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_name = 'credit_transactions' AND t.table_schema = current_schema()) THEN
    INSERT INTO credit_transactions (
      user_id,
      transaction_type,
      amount,
      balance_before,
      balance_after,
      source,
      source_id,
      description
    ) VALUES (
      p_user_id,
      'deduction',
      -p_amount,
      v_current_balance,
      v_new_balance,
      p_tool_name,
      p_cost_tracking_id,  -- Now VARCHAR, supports string IDs
      COALESCE(p_description, 'Credit deduction for tool: ' || p_tool_name)
    )
    RETURNING id INTO v_transaction_id;
  ELSE
    v_transaction_id := gen_random_uuid();
  END IF;

  RETURN QUERY SELECT true, v_new_balance, v_transaction_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION deduct_credits(UUID, DECIMAL, VARCHAR, VARCHAR, TEXT) IS 'Deduct credits from user balance with transaction logging (accepts string request IDs)';
