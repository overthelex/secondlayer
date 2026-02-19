-- Migration 049: Add service_pricing table for external service cost management
-- Stores per-unit costs for all external services (Anthropic, OpenAI, VoyageAI, ZakonOnline)

CREATE TABLE IF NOT EXISTS service_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(50) NOT NULL,        -- 'anthropic', 'openai', 'voyageai', 'zakononline'
  model VARCHAR(100) NOT NULL,          -- model/service identifier
  display_name VARCHAR(200) NOT NULL,   -- human-readable label
  unit_type VARCHAR(50) NOT NULL,       -- 'per_1m_input_tokens', 'per_1m_output_tokens', 'per_1m_tokens', 'per_call'
  price_usd DECIMAL(14, 8) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(255),
  UNIQUE(provider, model, unit_type)
);

CREATE INDEX IF NOT EXISTS idx_service_pricing_provider ON service_pricing(provider);
CREATE INDEX IF NOT EXISTS idx_service_pricing_active ON service_pricing(is_active);

-- ----------------------------------------------------------------
-- Default pricing data
-- ----------------------------------------------------------------

-- OpenAI models (USD per 1M tokens)
INSERT INTO service_pricing (provider, model, display_name, unit_type, price_usd, currency, sort_order, notes) VALUES
  ('openai', 'gpt-4o',               'GPT-4o',                'per_1m_input_tokens',  2.50,  'USD', 10, 'Ціна за 1M вхідних токенів'),
  ('openai', 'gpt-4o',               'GPT-4o',                'per_1m_output_tokens', 10.00, 'USD', 11, 'Ціна за 1M вихідних токенів'),
  ('openai', 'gpt-4o-mini',          'GPT-4o Mini',           'per_1m_input_tokens',  0.15,  'USD', 20, 'Ціна за 1M вхідних токенів'),
  ('openai', 'gpt-4o-mini',          'GPT-4o Mini',           'per_1m_output_tokens', 0.60,  'USD', 21, 'Ціна за 1M вихідних токенів'),
  ('openai', 'gpt-4o-2024-08-06',    'GPT-4o (2024-08-06)',   'per_1m_input_tokens',  2.50,  'USD', 30, 'Ціна за 1M вхідних токенів'),
  ('openai', 'gpt-4o-2024-08-06',    'GPT-4o (2024-08-06)',   'per_1m_output_tokens', 10.00, 'USD', 31, 'Ціна за 1M вихідних токенів'),
  ('openai', 'text-embedding-ada-002','Text Embedding Ada 002','per_1m_tokens',        0.10,  'USD', 40, 'Ціна за 1M токенів ембедінгу')
ON CONFLICT (provider, model, unit_type) DO NOTHING;

-- VoyageAI models (USD per 1M tokens)
INSERT INTO service_pricing (provider, model, display_name, unit_type, price_usd, currency, sort_order, notes) VALUES
  ('voyageai', 'voyage-multilingual-2', 'Voyage Multilingual 2', 'per_1m_tokens', 0.06, 'USD', 10, 'Ціна за 1M токенів (багатомовний ембедінг)'),
  ('voyageai', 'voyage-3',              'Voyage 3',              'per_1m_tokens', 0.06, 'USD', 20, 'Ціна за 1M токенів'),
  ('voyageai', 'voyage-3-lite',         'Voyage 3 Lite',         'per_1m_tokens', 0.02, 'USD', 30, 'Ціна за 1M токенів')
ON CONFLICT (provider, model, unit_type) DO NOTHING;

-- Anthropic models (USD per 1M tokens)
INSERT INTO service_pricing (provider, model, display_name, unit_type, price_usd, currency, sort_order, notes) VALUES
  ('anthropic', 'claude-opus-4-20250514',   'Claude Opus 4 (2025-05-14)', 'per_1m_input_tokens',  15.00, 'USD', 10, NULL),
  ('anthropic', 'claude-opus-4-20250514',   'Claude Opus 4 (2025-05-14)', 'per_1m_output_tokens', 75.00, 'USD', 11, NULL),
  ('anthropic', 'claude-opus-4.5',          'Claude Opus 4.5',            'per_1m_input_tokens',   5.00, 'USD', 20, NULL),
  ('anthropic', 'claude-opus-4.5',          'Claude Opus 4.5',            'per_1m_output_tokens', 25.00, 'USD', 21, NULL),
  ('anthropic', 'claude-opus-4',            'Claude Opus 4',              'per_1m_input_tokens',  15.00, 'USD', 30, NULL),
  ('anthropic', 'claude-opus-4',            'Claude Opus 4',              'per_1m_output_tokens', 75.00, 'USD', 31, NULL),
  ('anthropic', 'claude-sonnet-4-20250514', 'Claude Sonnet 4 (2025-05-14)','per_1m_input_tokens',  3.00, 'USD', 40, NULL),
  ('anthropic', 'claude-sonnet-4-20250514', 'Claude Sonnet 4 (2025-05-14)','per_1m_output_tokens',15.00, 'USD', 41, NULL),
  ('anthropic', 'claude-sonnet-4.5',        'Claude Sonnet 4.5',          'per_1m_input_tokens',   3.00, 'USD', 50, NULL),
  ('anthropic', 'claude-sonnet-4.5',        'Claude Sonnet 4.5',          'per_1m_output_tokens', 15.00, 'USD', 51, NULL),
  ('anthropic', 'claude-sonnet-4',          'Claude Sonnet 4',            'per_1m_input_tokens',   3.00, 'USD', 60, NULL),
  ('anthropic', 'claude-sonnet-4',          'Claude Sonnet 4',            'per_1m_output_tokens', 15.00, 'USD', 61, NULL),
  ('anthropic', 'claude-sonnet-3.7',        'Claude Sonnet 3.7',          'per_1m_input_tokens',   3.00, 'USD', 70, NULL),
  ('anthropic', 'claude-sonnet-3.7',        'Claude Sonnet 3.7',          'per_1m_output_tokens', 15.00, 'USD', 71, NULL),
  ('anthropic', 'claude-haiku-4-5-20251001','Claude Haiku 4.5 (2025-10-01)','per_1m_input_tokens', 1.00, 'USD', 80, NULL),
  ('anthropic', 'claude-haiku-4-5-20251001','Claude Haiku 4.5 (2025-10-01)','per_1m_output_tokens',5.00, 'USD', 81, NULL),
  ('anthropic', 'claude-haiku-4.5',         'Claude Haiku 4.5',           'per_1m_input_tokens',   1.00, 'USD', 82, NULL),
  ('anthropic', 'claude-haiku-4.5',         'Claude Haiku 4.5',           'per_1m_output_tokens',  5.00, 'USD', 83, NULL),
  ('anthropic', 'claude-haiku-3.5',         'Claude Haiku 3.5',           'per_1m_input_tokens',   0.80, 'USD', 90, NULL),
  ('anthropic', 'claude-haiku-3.5',         'Claude Haiku 3.5',           'per_1m_output_tokens',  4.00, 'USD', 91, NULL),
  ('anthropic', 'claude-haiku-3',           'Claude Haiku 3',             'per_1m_input_tokens',   0.25, 'USD', 100, NULL),
  ('anthropic', 'claude-haiku-3',           'Claude Haiku 3',             'per_1m_output_tokens',  1.25, 'USD', 101, NULL)
ON CONFLICT (provider, model, unit_type) DO NOTHING;

-- ZakonOnline API (UAH per call, tiered pricing)
-- Tier thresholds per calendar month
INSERT INTO service_pricing (provider, model, display_name, unit_type, price_usd, currency, sort_order, notes) VALUES
  ('zakononline', 'api_tier_1', 'API до 10 000 запитів/міс',    'per_call', 0.00714, 'UAH', 10, 'Перші 9 999 запитів на місяць'),
  ('zakononline', 'api_tier_2', 'API 10 000–19 999 запитів/міс','per_call', 0.00690, 'UAH', 20, '10 000–19 999 запитів на місяць'),
  ('zakononline', 'api_tier_3', 'API 20 000–29 999 запитів/міс','per_call', 0.00667, 'UAH', 30, '20 000–29 999 запитів на місяць'),
  ('zakononline', 'api_tier_4', 'API 30 000–49 999 запитів/міс','per_call', 0.00643, 'UAH', 40, '30 000–49 999 запитів на місяць'),
  ('zakononline', 'api_tier_5', 'API 50 000+ запитів/міс',      'per_call', 0.00238, 'UAH', 50, '50 000 та більше запитів на місяць')
ON CONFLICT (provider, model, unit_type) DO NOTHING;
