-- LEXAI-2069: uk_check_citations checks every citation of a contract in one call
-- (instruments, provisions, amendments since signing). Flat price per call, in GBP,
-- charged only when the call returns a result (FixedPriceBilling skips isError).
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, is_active, notes, fixed_price, fixed_price_currency)
VALUES ('uk_check_citations', 'backend', 'UK: statutory due diligence of a contract''s citations', 0, 0, true, 'Launch price 30.09.2026', 1.50, 'GBP')
ON CONFLICT (tool_name) DO UPDATE
  SET fixed_price = EXCLUDED.fixed_price,
      fixed_price_currency = EXCLUDED.fixed_price_currency,
      updated_at = NOW();
