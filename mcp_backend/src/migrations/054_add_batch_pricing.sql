-- Migration 054: Add Anthropic Message Batches API pricing
-- Source: https://platform.claude.com/docs/en/build-with-claude/batch-processing (2026-02-20)
--
-- Batch API = 50% discount vs standard API prices.
-- Limits: up to 100 000 requests or 256 MB per batch; results within 24h; stored 29 days.
-- unit_types added: per_1m_batch_input_tokens, per_1m_batch_output_tokens

INSERT INTO service_pricing (provider, model, display_name, unit_type, price_usd, currency, sort_order, notes) VALUES

  -- claude-sonnet-4-6  standard: $3/$15  →  batch: $1.50/$7.50
  ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 'per_1m_batch_input_tokens',   1.50, 'USD',  12, 'Batch API — 50% знижка від стандартної ціни'),
  ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 'per_1m_batch_output_tokens',  7.50, 'USD',  13, 'Batch API — 50% знижка від стандартної ціни'),

  -- claude-opus-4-6    standard: $5/$25  →  batch: $2.50/$12.50
  ('anthropic', 'claude-opus-4-6',   'Claude Opus 4.6',   'per_1m_batch_input_tokens',   2.50, 'USD',  22, 'Batch API — 50% знижка від стандартної ціни'),
  ('anthropic', 'claude-opus-4-6',   'Claude Opus 4.6',   'per_1m_batch_output_tokens', 12.50, 'USD',  23, 'Batch API — 50% знижка від стандартної ціни'),

  -- claude-opus-4-5-20251101  standard: $5/$25  →  batch: $2.50/$12.50
  ('anthropic', 'claude-opus-4-5-20251101', 'Claude Opus 4.5', 'per_1m_batch_input_tokens',   2.50, 'USD',  32, 'Batch API — 50% знижка від стандартної ціни'),
  ('anthropic', 'claude-opus-4-5-20251101', 'Claude Opus 4.5', 'per_1m_batch_output_tokens', 12.50, 'USD',  33, 'Batch API — 50% знижка від стандартної ціни'),

  -- claude-haiku-4-5-20251001  standard: $1/$5  →  batch: $0.50/$2.50
  ('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'per_1m_batch_input_tokens',  0.50, 'USD',  42, 'Batch API — 50% знижка від стандартної ціни'),
  ('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'per_1m_batch_output_tokens', 2.50, 'USD',  43, 'Batch API — 50% знижка від стандартної ціни'),

  -- claude-sonnet-4-5-20250929  standard: $3/$15  →  batch: $1.50/$7.50
  ('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'per_1m_batch_input_tokens',   1.50, 'USD',  52, 'Batch API — 50% знижка від стандартної ціни'),
  ('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'per_1m_batch_output_tokens',  7.50, 'USD',  53, 'Batch API — 50% знижка від стандартної ціни'),

  -- claude-opus-4-1-20250805  standard: $15/$75  →  batch: $7.50/$37.50  (legacy, is_active=false)
  ('anthropic', 'claude-opus-4-1-20250805', 'Claude Opus 4.1', 'per_1m_batch_input_tokens',   7.50, 'USD',  62, 'Batch API — legacy'),
  ('anthropic', 'claude-opus-4-1-20250805', 'Claude Opus 4.1', 'per_1m_batch_output_tokens', 37.50, 'USD',  63, 'Batch API — legacy'),

  -- claude-opus-4-20250514  standard: $15/$75  →  batch: $7.50/$37.50  (legacy, is_active=false)
  ('anthropic', 'claude-opus-4-20250514', 'Claude Opus 4', 'per_1m_batch_input_tokens',   7.50, 'USD',  72, 'Batch API — legacy'),
  ('anthropic', 'claude-opus-4-20250514', 'Claude Opus 4', 'per_1m_batch_output_tokens', 37.50, 'USD',  73, 'Batch API — legacy'),

  -- claude-sonnet-4-20250514  standard: $3/$15  →  batch: $1.50/$7.50  (legacy, is_active=false)
  ('anthropic', 'claude-sonnet-4-20250514', 'Claude Sonnet 4', 'per_1m_batch_input_tokens',   1.50, 'USD',  82, 'Batch API — legacy'),
  ('anthropic', 'claude-sonnet-4-20250514', 'Claude Sonnet 4', 'per_1m_batch_output_tokens',  7.50, 'USD',  83, 'Batch API — legacy'),

  -- claude-3-haiku-20240307  standard: $0.25/$1.25  →  batch: $0.125/$0.625  (deprecated)
  ('anthropic', 'claude-3-haiku-20240307', 'Claude Haiku 3 (deprecated)', 'per_1m_batch_input_tokens',  0.125, 'USD', 102, 'Batch API — DEPRECATED, retiring 2026-04-19'),
  ('anthropic', 'claude-3-haiku-20240307', 'Claude Haiku 3 (deprecated)', 'per_1m_batch_output_tokens', 0.625, 'USD', 103, 'Batch API — DEPRECATED, retiring 2026-04-19')

ON CONFLICT (provider, model, unit_type) DO UPDATE SET
  price_usd  = EXCLUDED.price_usd,
  notes      = EXCLUDED.notes,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

-- Batch entries for legacy/deprecated models inherit is_active=false
UPDATE service_pricing
SET is_active = false
WHERE provider = 'anthropic'
  AND unit_type IN ('per_1m_batch_input_tokens', 'per_1m_batch_output_tokens')
  AND model IN (
    'claude-opus-4-1-20250805',
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-3-haiku-20240307'
  );
