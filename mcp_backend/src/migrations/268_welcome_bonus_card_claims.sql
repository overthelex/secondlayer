-- Welcome bonus is credited only after the user verifies a card (a 1 UAH
-- Monobank payment that is refunded). One bonus per account and one per card.
CREATE TABLE IF NOT EXISTS welcome_bonus_claims (
  user_id UUID PRIMARY KEY,
  -- Masked PAN as Monobank returns it (first 6 + last 4). NULL for accounts
  -- that received the bonus at registration before this rule existed.
  card_masked_pan TEXT UNIQUE,
  invoice_id TEXT,
  amount_uah NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Accounts that already got the registration bonus must not get it again.
INSERT INTO welcome_bonus_claims (user_id, amount_uah, created_at)
SELECT DISTINCT ON (user_id) user_id, amount_uah, created_at
FROM billing_transactions
WHERE payment_id LIKE 'welcome-%'
ORDER BY user_id, created_at
ON CONFLICT (user_id) DO NOTHING;
