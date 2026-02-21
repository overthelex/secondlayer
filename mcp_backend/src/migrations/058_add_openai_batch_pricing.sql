-- Migration 058: Add OpenAI Batch API pricing
-- Source: https://developers.openai.com/api/docs/pricing (2026-02-20)
--
-- Batch API = 50% discount vs standard. Same as Anthropic.
-- Limits: up to 50,000 requests or 200MB per batch; results within 24h.
-- Separate rate-limit pool — does NOT consume standard RPM/TPM quotas.
-- Supported: /v1/chat/completions, /v1/embeddings, /v1/responses, /v1/completions

INSERT INTO service_pricing (provider, model, display_name, unit_type, price_usd, currency, sort_order, notes) VALUES

  -- gpt-5.2  standard: $1.75/$14  → batch: $0.875/$7.00
  ('openai', 'gpt-5.2', 'GPT-5.2', 'per_1m_batch_input_tokens',  0.875, 'USD',  7, 'Batch API — 50% знижка'),
  ('openai', 'gpt-5.2', 'GPT-5.2', 'per_1m_batch_output_tokens', 7.000, 'USD',  8, 'Batch API — 50% знижка'),

  -- gpt-5.1  standard: $1.25/$10  → batch: $0.625/$5.00
  ('openai', 'gpt-5.1', 'GPT-5.1', 'per_1m_batch_input_tokens',  0.625, 'USD', 12, 'Batch API — 50% знижка'),
  ('openai', 'gpt-5.1', 'GPT-5.1', 'per_1m_batch_output_tokens', 5.000, 'USD', 13, 'Batch API — 50% знижка'),

  -- gpt-5    standard: $1.25/$10  → batch: $0.625/$5.00
  ('openai', 'gpt-5', 'GPT-5', 'per_1m_batch_input_tokens',  0.625, 'USD', 22, 'Batch API — 50% знижка'),
  ('openai', 'gpt-5', 'GPT-5', 'per_1m_batch_output_tokens', 5.000, 'USD', 23, 'Batch API — 50% знижка'),

  -- gpt-5-mini  standard: $0.25/$2  → batch: $0.125/$1.00
  ('openai', 'gpt-5-mini', 'GPT-5 Mini', 'per_1m_batch_input_tokens',  0.125, 'USD', 32, 'Batch API — 50% знижка'),
  ('openai', 'gpt-5-mini', 'GPT-5 Mini', 'per_1m_batch_output_tokens', 1.000, 'USD', 33, 'Batch API — 50% знижка'),

  -- gpt-5-nano  standard: $0.05/$0.40  → batch: $0.025/$0.20
  ('openai', 'gpt-5-nano', 'GPT-5 Nano', 'per_1m_batch_input_tokens',  0.025, 'USD', 42, 'Batch API — 50% знижка'),
  ('openai', 'gpt-5-nano', 'GPT-5 Nano', 'per_1m_batch_output_tokens', 0.200, 'USD', 43, 'Batch API — 50% знижка'),

  -- gpt-4.1  standard: $2/$8  → batch: $1.00/$4.00
  ('openai', 'gpt-4.1', 'GPT-4.1', 'per_1m_batch_input_tokens',  1.00, 'USD', 52, 'Batch API — 50% знижка'),
  ('openai', 'gpt-4.1', 'GPT-4.1', 'per_1m_batch_output_tokens', 4.00, 'USD', 53, 'Batch API — 50% знижка'),

  -- gpt-4.1-mini  standard: $0.40/$1.60  → batch: $0.20/$0.80
  ('openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', 'per_1m_batch_input_tokens',  0.20, 'USD', 62, 'Batch API — 50% знижка'),
  ('openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', 'per_1m_batch_output_tokens', 0.80, 'USD', 63, 'Batch API — 50% знижка'),

  -- gpt-4.1-nano  standard: $0.10/$0.40  → batch: $0.05/$0.20
  ('openai', 'gpt-4.1-nano', 'GPT-4.1 Nano', 'per_1m_batch_input_tokens',  0.05, 'USD', 72, 'Batch API — 50% знижка'),
  ('openai', 'gpt-4.1-nano', 'GPT-4.1 Nano', 'per_1m_batch_output_tokens', 0.20, 'USD', 73, 'Batch API — 50% знижка'),

  -- gpt-4o  standard: $2.50/$10  → batch: $1.25/$5.00  (legacy)
  ('openai', 'gpt-4o', 'GPT-4o', 'per_1m_batch_input_tokens',  1.25, 'USD', 82, 'Batch API — legacy'),
  ('openai', 'gpt-4o', 'GPT-4o', 'per_1m_batch_output_tokens', 5.00, 'USD', 83, 'Batch API — legacy'),

  -- o4-mini  standard: $1.10/$4.40  → batch: $0.55/$2.20
  ('openai', 'o4-mini', 'o4-mini', 'per_1m_batch_input_tokens',  0.55, 'USD', 112, 'Batch API — 50% знижка'),
  ('openai', 'o4-mini', 'o4-mini', 'per_1m_batch_output_tokens', 2.20, 'USD', 113, 'Batch API — 50% знижка'),

  -- o3  standard: $2/$8  → batch: $1.00/$4.00
  ('openai', 'o3', 'o3', 'per_1m_batch_input_tokens',  1.00, 'USD', 122, 'Batch API — 50% знижка'),
  ('openai', 'o3', 'o3', 'per_1m_batch_output_tokens', 4.00, 'USD', 123, 'Batch API — 50% знижка'),

  -- embeddings (batch = same price, no extra discount)
  ('openai', 'text-embedding-3-small', 'Text Embedding 3 Small', 'per_1m_batch_tokens', 0.010, 'USD', 142, 'Batch API — базова ціна (без знижки)'),
  ('openai', 'text-embedding-3-large', 'Text Embedding 3 Large', 'per_1m_batch_tokens', 0.065, 'USD', 152, 'Batch API — базова ціна (без знижки)')

ON CONFLICT (provider, model, unit_type) DO UPDATE SET
  price_usd  = EXCLUDED.price_usd,
  notes      = EXCLUDED.notes,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

-- Legacy gpt-4o batch entries → is_active = false
UPDATE service_pricing SET is_active = false
WHERE provider = 'openai'
  AND model = 'gpt-4o'
  AND unit_type IN ('per_1m_batch_input_tokens', 'per_1m_batch_output_tokens');
