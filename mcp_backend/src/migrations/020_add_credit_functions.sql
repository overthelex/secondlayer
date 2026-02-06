-- Migration 020: Add Phase 2 Credit Functions
-- Creates PostgreSQL functions for credit management
-- Date: 2026-02-04

-- Function: Calculate credits required for a tool
CREATE OR REPLACE FUNCTION calculate_credits_for_tool(
  p_tool_name VARCHAR,
  p_user_id UUID
)
RETURNS INTEGER AS $$
DECLARE
  v_credits INTEGER;
BEGIN
  -- Tool pricing (can be moved to a config table later)
  -- For now, simple pricing based on tool name
  CASE
    WHEN p_tool_name IN ('search_court_cases', 'semantic_search', 'search_legal_precedents') THEN
      v_credits := 1;
    WHEN p_tool_name IN ('get_document_text', 'get_legislation_section') THEN
      v_credits := 1;
    WHEN p_tool_name IN ('packaged_lawyer_answer', 'get_legal_advice') THEN
      v_credits := 3;
    WHEN p_tool_name IN ('find_legal_patterns', 'find_similar_fact_pattern_cases') THEN
      v_credits := 2;
    WHEN p_tool_name IN ('search_legislation', 'search_supreme_court_practice') THEN
      v_credits := 1;
    ELSE
      v_credits := 1; -- Default
  END CASE;

  RETURN v_credits;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_credits_for_tool IS 'Calculate credit cost for a specific tool';

-- Function: Check if user has sufficient balance
CREATE OR REPLACE FUNCTION check_user_balance(
  p_user_id UUID,
  p_required_credits INTEGER
)
RETURNS TABLE (
  has_credits BOOLEAN,
  current_balance NUMERIC,
  reason TEXT
) AS $$
DECLARE
  v_balance DECIMAL(10, 2);
BEGIN
  -- Get current balance
  SELECT balance INTO v_balance
  FROM user_credits
  WHERE user_id = p_user_id;

  -- If user not found, initialize with 0 balance
  IF NOT FOUND THEN
    INSERT INTO user_credits (user_id, balance)
    VALUES (p_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    v_balance := 0;
  END IF;

  -- Check if balance is sufficient
  IF v_balance >= p_required_credits THEN
    RETURN QUERY SELECT true, v_balance, 'Sufficient balance'::TEXT;
  ELSE
    RETURN QUERY SELECT false, v_balance, 'Insufficient credits'::TEXT;
  END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION check_user_balance IS 'Check if user has sufficient credits for operation';

-- Function: Deduct credits from user balance
CREATE OR REPLACE FUNCTION deduct_credits(
  p_user_id UUID,
  p_amount DECIMAL,
  p_tool_name VARCHAR,
  p_cost_tracking_id VARCHAR,  -- Changed from UUID to VARCHAR to support string request IDs
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
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'credit_transactions') THEN
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
      p_cost_tracking_id,
      COALESCE(p_description, 'Credit deduction for tool: ' || p_tool_name)
    )
    RETURNING id INTO v_transaction_id;
  ELSE
    v_transaction_id := gen_random_uuid();
  END IF;

  RETURN QUERY SELECT true, v_new_balance, v_transaction_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION deduct_credits IS 'Deduct credits from user balance with transaction logging';

-- Function: Add credits to user balance
CREATE OR REPLACE FUNCTION add_credits(
  p_user_id UUID,
  p_amount DECIMAL,
  p_transaction_type VARCHAR,
  p_source VARCHAR,
  p_source_id VARCHAR,
  p_description TEXT,
  p_stripe_payment_intent_id VARCHAR
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
      jsonb_build_object('stripe_payment_intent_id', p_stripe_payment_intent_id)
    )
    RETURNING id INTO v_transaction_id;
  ELSE
    v_transaction_id := gen_random_uuid();
  END IF;

  RETURN QUERY SELECT true, v_new_balance, v_transaction_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION add_credits IS 'Add credits to user balance with transaction logging';

-- Grant permissions
-- GRANT EXECUTE ON FUNCTION calculate_credits_for_tool TO secondlayer_app;
-- GRANT EXECUTE ON FUNCTION check_user_balance TO secondlayer_app;
-- GRANT EXECUTE ON FUNCTION deduct_credits TO secondlayer_app;
-- GRANT EXECUTE ON FUNCTION add_credits TO secondlayer_app;
