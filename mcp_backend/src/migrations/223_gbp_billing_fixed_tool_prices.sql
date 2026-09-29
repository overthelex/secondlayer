-- Migration 223: GBP billing accounts and fixed per-call tool prices (lawrider.uk)
--
-- 1. user_billing.currency: the currency of the account ledger. balance_usd, total_spent_usd
--    and the billing_transactions amount_usd / balance_*_usd columns hold amounts in THIS
--    currency (the column names predate multi-currency). USD accounts are unchanged; for them
--    balance_uah stays a derived NBU conversion. GBP accounts never touch the UAH columns.
-- 2. billing_transactions.currency: the currency each transaction was booked in.
-- 3. tool_pricing.fixed_price / fixed_price_currency: a flat price per successful call, charged
--    with no tier or tool markup. Tools without one keep usage billing.
-- 4. Seed the UK statute-book tools with their launch prices in GBP.
--
-- ADD COLUMN ... NOT NULL DEFAULT is metadata-only on PostgreSQL 11+, so this does not
-- rewrite user_billing or billing_transactions on legal.org.ua.

ALTER TABLE user_billing ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'USD';

DO $$ BEGIN
  ALTER TABLE user_billing
    ADD CONSTRAINT user_billing_currency_check CHECK (currency IN ('USD', 'GBP'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN user_billing.currency IS
  'Ledger currency. balance_usd / total_spent_usd hold amounts in this currency (USD unless GBP).';

ALTER TABLE billing_transactions ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'USD';

ALTER TABLE tool_pricing ADD COLUMN IF NOT EXISTS fixed_price NUMERIC(10, 2);
ALTER TABLE tool_pricing ADD COLUMN IF NOT EXISTS fixed_price_currency CHAR(3);

DO $$ BEGIN
  ALTER TABLE tool_pricing
    ADD CONSTRAINT tool_pricing_fixed_price_check CHECK (
      (fixed_price IS NULL AND fixed_price_currency IS NULL)
      OR (fixed_price >= 0 AND fixed_price_currency IN ('USD', 'GBP'))
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, is_active, notes, fixed_price, fixed_price_currency)
VALUES
  ('uk_search_legislation',    'backend', 'UK: search legislation',              0, 0, true, 'Launch price 29.09.2026', 0.02, 'GBP'),
  ('uk_semantic_search',       'backend', 'UK: semantic search of provisions',   0, 0, true, 'Launch price 29.09.2026', 0.03, 'GBP'),
  ('uk_get_act',               'backend', 'UK: act with structure',              0, 0, true, 'Launch price 29.09.2026', 0.02, 'GBP'),
  ('uk_get_act_as_at',         'backend', 'UK: act as it stood on a date',       0, 0, true, 'Launch price 29.09.2026', 0.03, 'GBP'),
  ('uk_get_provision',         'backend', 'UK: provision',                       0, 0, true, 'Launch price 29.09.2026', 0.01, 'GBP'),
  ('uk_get_provision_history', 'backend', 'UK: provision revision history',      0, 0, true, 'Launch price 29.09.2026', 0.02, 'GBP'),
  ('uk_search_judgments',      'backend', 'UK: search judgments (FCL licence)',  0, 0, true, 'Launch price 29.09.2026', 0.03, 'GBP')
ON CONFLICT (tool_name) DO UPDATE
  SET fixed_price = EXCLUDED.fixed_price,
      fixed_price_currency = EXCLUDED.fixed_price_currency,
      updated_at = NOW();
