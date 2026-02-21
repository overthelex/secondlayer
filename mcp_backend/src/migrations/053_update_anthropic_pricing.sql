-- Migration 053: Update Anthropic model pricing to reflect currently available models
-- Source: https://platform.claude.com/docs/en/about-claude/models/all-models (2026-02-20)
--
-- Available models (from /v1/models API):
--   claude-sonnet-4-6           (latest)  $3 / $15 per 1M tokens
--   claude-opus-4-6             (latest)  $5 / $25 per 1M tokens
--   claude-opus-4-5-20251101              $5 / $25 per 1M tokens
--   claude-haiku-4-5-20251001             $1 / $5  per 1M tokens
--   claude-sonnet-4-5-20250929            $3 / $15 per 1M tokens
--   claude-opus-4-1-20250805              $15 / $75 per 1M tokens
--   claude-opus-4-20250514                $15 / $75 per 1M tokens
--   claude-sonnet-4-20250514              $3 / $15 per 1M tokens
--   claude-3-haiku-20240307     DEPRECATED, retiring 2026-04-19

-- ----------------------------------------------------------------
-- 1. Remove stale entries with incorrect dot-notation IDs
--    (e.g. 'claude-opus-4.5', 'claude-sonnet-4.5', 'claude-haiku-4.5')
--    that were never valid API model identifiers.
-- ----------------------------------------------------------------
DELETE FROM service_pricing
WHERE provider = 'anthropic'
  AND model IN (
    'claude-opus-4.5',
    'claude-sonnet-4.5',
    'claude-haiku-4.5',
    'claude-haiku-3.5',
    'claude-sonnet-3.7',
    'claude-opus-3',
    'claude-opus',
    'claude-sonnet',
    'claude-haiku'
  );

-- ----------------------------------------------------------------
-- 2. Mark claude-3-haiku-20240307 as deprecated (retiring 2026-04-19)
-- ----------------------------------------------------------------
UPDATE service_pricing
SET notes = 'DEPRECATED — retiring 2026-04-19. Migrate to claude-haiku-4-5-20251001',
    is_active = false
WHERE provider = 'anthropic'
  AND model = 'claude-3-haiku-20240307';

-- ----------------------------------------------------------------
-- 3. Upsert all currently available models with correct prices
-- ----------------------------------------------------------------
INSERT INTO service_pricing (provider, model, display_name, unit_type, price_usd, currency, sort_order, notes) VALUES

  -- claude-sonnet-4-6 (latest, Feb 2026)
  ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 'per_1m_input_tokens',   3.00, 'USD',  10, 'Актуальна модель. Найкраще співвідношення швидкості та інтелекту'),
  ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 'per_1m_output_tokens', 15.00, 'USD',  11, NULL),

  -- claude-opus-4-6 (latest, Feb 2026)
  ('anthropic', 'claude-opus-4-6',   'Claude Opus 4.6',   'per_1m_input_tokens',   5.00, 'USD',  20, 'Актуальна модель. Найвищий інтелект для агентів та кодування'),
  ('anthropic', 'claude-opus-4-6',   'Claude Opus 4.6',   'per_1m_output_tokens', 25.00, 'USD',  21, NULL),

  -- claude-opus-4-5-20251101
  ('anthropic', 'claude-opus-4-5-20251101', 'Claude Opus 4.5', 'per_1m_input_tokens',   5.00, 'USD',  30, NULL),
  ('anthropic', 'claude-opus-4-5-20251101', 'Claude Opus 4.5', 'per_1m_output_tokens', 25.00, 'USD',  31, NULL),

  -- claude-haiku-4-5-20251001
  ('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'per_1m_input_tokens',  1.00, 'USD',  40, 'Найшвидша модель'),
  ('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'per_1m_output_tokens', 5.00, 'USD',  41, NULL),

  -- claude-sonnet-4-5-20250929
  ('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'per_1m_input_tokens',   3.00, 'USD',  50, NULL),
  ('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'per_1m_output_tokens', 15.00, 'USD',  51, NULL),

  -- claude-opus-4-1-20250805
  ('anthropic', 'claude-opus-4-1-20250805', 'Claude Opus 4.1', 'per_1m_input_tokens',  15.00, 'USD',  60, 'Legacy'),
  ('anthropic', 'claude-opus-4-1-20250805', 'Claude Opus 4.1', 'per_1m_output_tokens', 75.00, 'USD',  61, NULL),

  -- claude-opus-4-20250514
  ('anthropic', 'claude-opus-4-20250514', 'Claude Opus 4', 'per_1m_input_tokens',  15.00, 'USD',  70, 'Legacy'),
  ('anthropic', 'claude-opus-4-20250514', 'Claude Opus 4', 'per_1m_output_tokens', 75.00, 'USD',  71, NULL),

  -- claude-sonnet-4-20250514
  ('anthropic', 'claude-sonnet-4-20250514', 'Claude Sonnet 4', 'per_1m_input_tokens',   3.00, 'USD',  80, 'Legacy'),
  ('anthropic', 'claude-sonnet-4-20250514', 'Claude Sonnet 4', 'per_1m_output_tokens', 15.00, 'USD',  81, NULL),

  -- claude-3-haiku-20240307 (already inserted by 049, kept for history — is_active=false set above)
  ('anthropic', 'claude-3-haiku-20240307', 'Claude Haiku 3 (deprecated)', 'per_1m_input_tokens',  0.25, 'USD', 100, 'DEPRECATED — retiring 2026-04-19'),
  ('anthropic', 'claude-3-haiku-20240307', 'Claude Haiku 3 (deprecated)', 'per_1m_output_tokens', 1.25, 'USD', 101, 'DEPRECATED — retiring 2026-04-19')

ON CONFLICT (provider, model, unit_type) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  price_usd    = EXCLUDED.price_usd,
  notes        = EXCLUDED.notes,
  sort_order   = EXCLUDED.sort_order,
  updated_at   = NOW();

-- Mark deprecated claude-3-haiku and all legacy entries as inactive
-- (not deleted, kept for historical cost tracking)
UPDATE service_pricing
SET is_active = false,
    notes = COALESCE(notes, '') || CASE WHEN notes IS NULL THEN '' ELSE '' END
WHERE provider = 'anthropic'
  AND model IN (
    'claude-opus-4-1-20250805',
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-3-haiku-20240307'
  );

-- Remove ghost alias entries without snapshot dates (not real API IDs)
DELETE FROM service_pricing
WHERE provider = 'anthropic'
  AND model IN ('claude-opus-4', 'claude-sonnet-4', 'claude-haiku-3');
