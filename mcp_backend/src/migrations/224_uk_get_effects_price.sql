-- Migration 224: launch price for uk_get_effects (the amendment register over MCP).
-- Same terms as the other uk_* tools (migration 223): a fixed per-call price in GBP,
-- charged by FixedPriceBilling after a successful call, no markup.

INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, is_active, notes, fixed_price, fixed_price_currency)
VALUES ('uk_get_effects', 'backend', 'UK: amendments to an act or provision', 0, 0, true, 'Launch price 29.09.2026', 0.02, 'GBP')
ON CONFLICT (tool_name) DO UPDATE
  SET fixed_price = EXCLUDED.fixed_price,
      fixed_price_currency = EXCLUDED.fixed_price_currency,
      updated_at = NOW();
