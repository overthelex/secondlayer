-- Create Vovkes User with $1000 Balance
-- Execute this on stage database: secondlayer_stage

-- 1. Create user if not exists
INSERT INTO users (email, name, google_id, picture, email_verified)
VALUES (
  'vovkes@legal.org.ua',
  'Vovkes Admin',
  'vovkes-google-id-' || extract(epoch from now())::text,
  'https://via.placeholder.com/150',
  true
)
ON CONFLICT (email) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = CURRENT_TIMESTAMP
RETURNING id;

-- Get user ID (run this separately to get the ID)
SELECT id, email, name FROM users WHERE email = 'vovkes@legal.org.ua';

-- 2. Initialize user credits (1000 credits = $1000)
-- Replace <USER_ID> with the actual UUID from step 1
DO $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Get user ID
  SELECT id INTO v_user_id FROM users WHERE email = 'vovkes@legal.org.ua';

  -- Initialize credits if not exists
  INSERT INTO user_credits (user_id, balance, total_earned)
  VALUES (v_user_id, 1000.00, 1000.00)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = user_credits.balance + 1000.00,
        total_earned = user_credits.total_earned + 1000.00,
        updated_at = NOW();

  -- Create transaction record (using billing_transactions table)
  INSERT INTO billing_transactions (
    user_id,
    type,
    amount_usd,
    balance_before_usd,
    balance_after_usd,
    payment_provider,
    description
  )
  SELECT
    v_user_id,
    'topup',
    1000.00,
    COALESCE((SELECT balance FROM user_credits WHERE user_id = v_user_id), 0) - 1000.00,
    COALESCE((SELECT balance FROM user_credits WHERE user_id = v_user_id), 0),
    'manual',
    'Initial balance for Vovkes admin account ($1000)';

  -- Initialize billing record
  INSERT INTO user_billing (
    user_id,
    balance_usd,
    balance_uah,
    daily_limit_usd,
    monthly_limit_usd,
    total_spent_usd,
    total_requests,
    is_active,
    billing_enabled
  )
  VALUES (
    v_user_id,
    1000.00,
    0,
    1000.00,
    10000.00,
    0,
    0,
    true,
    true
  )
  ON CONFLICT (user_id) DO UPDATE
    SET balance_usd = 1000.00,
        daily_limit_usd = 1000.00,
        monthly_limit_usd = 10000.00,
        updated_at = CURRENT_TIMESTAMP;

  RAISE NOTICE 'User created successfully! User ID: %', v_user_id;
END $$;

-- 3. Verify the result
SELECT
  u.id,
  u.email,
  u.name,
  uc.balance as credits,
  ub.balance_usd,
  ub.daily_limit_usd,
  ub.monthly_limit_usd
FROM users u
LEFT JOIN user_credits uc ON u.id = uc.user_id
LEFT JOIN user_billing ub ON u.id = ub.user_id
WHERE u.email = 'vovkes@legal.org.ua';
