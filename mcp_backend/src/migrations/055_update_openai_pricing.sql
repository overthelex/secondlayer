-- Migration 055: Update OpenAI model pricing — add GPT-5 family, fix prices
-- Source: https://developers.openai.com/api/docs/pricing (2026-02-20)

-- ----------------------------------------------------------------
-- 1. Mark old GPT-4o / GPT-4o-mini / ada-002 as legacy (is_active=false)
--    Prices stay correct, just no longer the active models
-- ----------------------------------------------------------------
UPDATE service_pricing
SET is_active = false
WHERE provider = 'openai'
  AND model IN ('gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-08-06', 'text-embedding-ada-002');

-- ----------------------------------------------------------------
-- 2. Upsert current GPT-5 family + GPT-4.1 + reasoning + embeddings
-- ----------------------------------------------------------------
INSERT INTO service_pricing (provider, model, display_name, unit_type, price_usd, currency, sort_order, notes) VALUES

  -- GPT-5.2 (latest)
  ('openai', 'gpt-5.2', 'GPT-5.2', 'per_1m_input_tokens',   1.75, 'USD',  5, 'Актуальна модель'),
  ('openai', 'gpt-5.2', 'GPT-5.2', 'per_1m_output_tokens', 14.00, 'USD',  6, NULL),

  -- GPT-5.1
  ('openai', 'gpt-5.1', 'GPT-5.1', 'per_1m_input_tokens',   1.25, 'USD', 10, 'Актуальна модель'),
  ('openai', 'gpt-5.1', 'GPT-5.1', 'per_1m_output_tokens', 10.00, 'USD', 11, NULL),

  -- GPT-5
  ('openai', 'gpt-5', 'GPT-5', 'per_1m_input_tokens',   1.25, 'USD', 20, NULL),
  ('openai', 'gpt-5', 'GPT-5', 'per_1m_output_tokens', 10.00, 'USD', 21, NULL),

  -- GPT-5-mini
  ('openai', 'gpt-5-mini', 'GPT-5 Mini', 'per_1m_input_tokens',  0.25, 'USD', 30, 'Актуальна модель'),
  ('openai', 'gpt-5-mini', 'GPT-5 Mini', 'per_1m_output_tokens', 2.00, 'USD', 31, NULL),

  -- GPT-5-nano
  ('openai', 'gpt-5-nano', 'GPT-5 Nano', 'per_1m_input_tokens',  0.05, 'USD', 40, 'Актуальна модель'),
  ('openai', 'gpt-5-nano', 'GPT-5 Nano', 'per_1m_output_tokens', 0.40, 'USD', 41, NULL),

  -- GPT-4.1
  ('openai', 'gpt-4.1', 'GPT-4.1', 'per_1m_input_tokens',  2.00, 'USD', 50, NULL),
  ('openai', 'gpt-4.1', 'GPT-4.1', 'per_1m_output_tokens', 8.00, 'USD', 51, NULL),

  -- GPT-4.1-mini
  ('openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', 'per_1m_input_tokens',  0.40, 'USD', 60, NULL),
  ('openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', 'per_1m_output_tokens', 1.60, 'USD', 61, NULL),

  -- GPT-4.1-nano
  ('openai', 'gpt-4.1-nano', 'GPT-4.1 Nano', 'per_1m_input_tokens',  0.10, 'USD', 70, NULL),
  ('openai', 'gpt-4.1-nano', 'GPT-4.1 Nano', 'per_1m_output_tokens', 0.40, 'USD', 71, NULL),

  -- GPT-4o (legacy, keep for history)
  ('openai', 'gpt-4o',            'GPT-4o',            'per_1m_input_tokens',  2.50,  'USD', 80, 'Legacy'),
  ('openai', 'gpt-4o',            'GPT-4o',            'per_1m_output_tokens', 10.00, 'USD', 81, 'Legacy'),
  ('openai', 'gpt-4o-mini',       'GPT-4o Mini',       'per_1m_input_tokens',  0.15,  'USD', 90, 'Legacy'),
  ('openai', 'gpt-4o-mini',       'GPT-4o Mini',       'per_1m_output_tokens', 0.60,  'USD', 91, 'Legacy'),
  ('openai', 'gpt-4o-2024-08-06', 'GPT-4o (2024-08-06)', 'per_1m_input_tokens',  2.50, 'USD', 100, 'Legacy'),
  ('openai', 'gpt-4o-2024-08-06', 'GPT-4o (2024-08-06)', 'per_1m_output_tokens', 10.00,'USD', 101, 'Legacy'),

  -- Reasoning models
  ('openai', 'o4-mini', 'o4-mini', 'per_1m_input_tokens',   1.10, 'USD', 110, NULL),
  ('openai', 'o4-mini', 'o4-mini', 'per_1m_output_tokens',  4.40, 'USD', 111, NULL),
  ('openai', 'o3',      'o3',      'per_1m_input_tokens',   2.00, 'USD', 120, NULL),
  ('openai', 'o3',      'o3',      'per_1m_output_tokens',  8.00, 'USD', 121, NULL),
  ('openai', 'o1',      'o1',      'per_1m_input_tokens',  15.00, 'USD', 130, 'Legacy'),
  ('openai', 'o1',      'o1',      'per_1m_output_tokens', 60.00, 'USD', 131, 'Legacy'),

  -- Embeddings (current)
  ('openai', 'text-embedding-3-small', 'Text Embedding 3 Small', 'per_1m_tokens', 0.02, 'USD', 140, 'Актуальна модель ембедінгу'),
  ('openai', 'text-embedding-3-large', 'Text Embedding 3 Large', 'per_1m_tokens', 0.13, 'USD', 150, NULL),
  -- Embeddings (legacy)
  ('openai', 'text-embedding-ada-002', 'Text Embedding Ada 002', 'per_1m_tokens', 0.10, 'USD', 160, 'Legacy')

ON CONFLICT (provider, model, unit_type) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  price_usd    = EXCLUDED.price_usd,
  notes        = EXCLUDED.notes,
  sort_order   = EXCLUDED.sort_order,
  updated_at   = NOW();

-- Legacy/deprecated reasoning
UPDATE service_pricing SET is_active = false
WHERE provider = 'openai' AND model IN ('o1');
