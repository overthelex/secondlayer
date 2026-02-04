-- Migration 015: API Keys Management
-- Phase 2 Billing - API Key authentication and rate limiting
-- Date: 2026-02-02

-- Function to generate secure API key
CREATE OR REPLACE FUNCTION generate_api_key()
RETURNS VARCHAR AS $$
DECLARE
  prefix VARCHAR := 'sl_';
  random_part VARCHAR;
  checksum VARCHAR;
  full_key VARCHAR;
BEGIN
  -- Generate 32 random characters (base62: a-zA-Z0-9)
  random_part := encode(gen_random_bytes(24), 'base64');
  random_part := translate(random_part, '+/=', 'abc');
  random_part := substring(random_part, 1, 32);

  -- Generate 8-char checksum
  checksum := substring(md5(random_part || CURRENT_TIMESTAMP::TEXT), 1, 8);

  -- Combine: sl_<32chars>_<8chars>
  -- Total length: 3 + 32 + 1 + 8 = 44 chars
  full_key := prefix || random_part || '_' || checksum;

  RETURN full_key;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION generate_api_key IS 'Generate secure API key with format: sl_<random32>_<checksum8>';

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Key details
  key VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Status
  is_active BOOLEAN DEFAULT true NOT NULL,

  -- Usage tracking
  last_used_at TIMESTAMPTZ,
  usage_count INTEGER DEFAULT 0 NOT NULL,

  -- Rate limiting
  rate_limit_per_minute INTEGER DEFAULT 60 NOT NULL,
  rate_limit_per_day INTEGER DEFAULT 10000 NOT NULL,
  requests_today INTEGER DEFAULT 0 NOT NULL,
  requests_today_reset_at DATE DEFAULT CURRENT_DATE NOT NULL,

  -- Expiration
  expires_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_api_keys_is_active ON api_keys(is_active);

-- User credits table (for balance tracking)
CREATE TABLE IF NOT EXISTS user_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Balance
  balance DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,

  -- Statistics
  total_earned DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,
  total_spent DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_credits_user_id ON user_credits(user_id);

-- Function to check rate limit
CREATE OR REPLACE FUNCTION check_api_key_rate_limit(p_api_key VARCHAR)
RETURNS TABLE (
  allowed BOOLEAN,
  reason TEXT,
  requests_today INTEGER,
  rate_limit_per_day INTEGER
) AS $$
DECLARE
  v_key_info RECORD;
BEGIN
  -- Get key info
  SELECT * INTO v_key_info
  FROM api_keys
  WHERE key = p_api_key AND is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Invalid or inactive API key'::TEXT, 0, 0;
    RETURN;
  END IF;

  -- Reset daily counter if needed
  IF v_key_info.requests_today_reset_at < CURRENT_DATE THEN
    UPDATE api_keys
    SET requests_today = 0,
        requests_today_reset_at = CURRENT_DATE
    WHERE id = v_key_info.id;

    v_key_info.requests_today := 0;
  END IF;

  -- Check daily limit
  IF v_key_info.requests_today >= v_key_info.rate_limit_per_day THEN
    RETURN QUERY SELECT
      false,
      'Daily rate limit exceeded'::TEXT,
      v_key_info.requests_today,
      v_key_info.rate_limit_per_day;
    RETURN;
  END IF;

  -- Check expiration
  IF v_key_info.expires_at IS NOT NULL AND v_key_info.expires_at < NOW() THEN
    RETURN QUERY SELECT
      false,
      'API key expired'::TEXT,
      v_key_info.requests_today,
      v_key_info.rate_limit_per_day;
    RETURN;
  END IF;

  -- Allowed
  RETURN QUERY SELECT
    true,
    'OK'::TEXT,
    v_key_info.requests_today,
    v_key_info.rate_limit_per_day;
END;
$$ LANGUAGE plpgsql;

-- Function to increment API key usage
CREATE OR REPLACE FUNCTION increment_api_key_usage(p_api_key VARCHAR)
RETURNS VOID AS $$
BEGIN
  UPDATE api_keys
  SET usage_count = usage_count + 1,
      requests_today = requests_today + 1,
      last_used_at = NOW(),
      updated_at = NOW()
  WHERE key = p_api_key AND is_active = true;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_api_keys_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_api_keys_updated_at ON api_keys;
CREATE TRIGGER trigger_update_api_keys_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW
  EXECUTE FUNCTION update_api_keys_updated_at();

-- Comments
COMMENT ON TABLE api_keys IS 'API keys for user authentication and rate limiting';
COMMENT ON TABLE user_credits IS 'User credit balances for prepaid usage';
COMMENT ON COLUMN api_keys.key IS 'API key value (should be hashed in production)';
COMMENT ON COLUMN api_keys.rate_limit_per_minute IS 'Maximum requests per minute';
COMMENT ON COLUMN api_keys.rate_limit_per_day IS 'Maximum requests per day';
COMMENT ON COLUMN api_keys.requests_today IS 'Number of requests made today';
COMMENT ON FUNCTION check_api_key_rate_limit IS 'Check if API key is within rate limits';
COMMENT ON FUNCTION increment_api_key_usage IS 'Increment usage counters for API key';

-- Initialize user_credits for existing users
INSERT INTO user_credits (user_id, balance)
SELECT id, 0.00
FROM users
WHERE id NOT IN (SELECT user_id FROM user_credits)
ON CONFLICT (user_id) DO NOTHING;
