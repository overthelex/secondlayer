-- Migration 045: Crypto Payments (MetaMask + Binance Pay)
-- Adds user_tags table and extends payment_intents with crypto columns

-- User tags: generic tag system (first use = "crypto")
CREATE TABLE IF NOT EXISTS user_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag VARCHAR(50) NOT NULL,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_user_tags_user_id ON user_tags(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tags_tag ON user_tags(tag);

-- Extend payment_intents with crypto-specific columns
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_intents' AND column_name = 'crypto_network'
  ) THEN
    ALTER TABLE payment_intents ADD COLUMN crypto_network VARCHAR(20);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_intents' AND column_name = 'crypto_token'
  ) THEN
    ALTER TABLE payment_intents ADD COLUMN crypto_token VARCHAR(10);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_intents' AND column_name = 'crypto_amount'
  ) THEN
    ALTER TABLE payment_intents ADD COLUMN crypto_amount DECIMAL(18, 8);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_intents' AND column_name = 'crypto_tx_hash'
  ) THEN
    ALTER TABLE payment_intents ADD COLUMN crypto_tx_hash VARCHAR(66);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_intents' AND column_name = 'wallet_address'
  ) THEN
    ALTER TABLE payment_intents ADD COLUMN wallet_address VARCHAR(42);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_intents' AND column_name = 'exchange_rate_usd'
  ) THEN
    ALTER TABLE payment_intents ADD COLUMN exchange_rate_usd DECIMAL(18, 8);
  END IF;
END $$;

-- Partial index on tx hash for lookups
CREATE INDEX IF NOT EXISTS idx_payment_intents_crypto_tx_hash
  ON payment_intents(crypto_tx_hash) WHERE crypto_tx_hash IS NOT NULL;
