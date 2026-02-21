-- Migration 056: Add model_capabilities table
-- Stores technical specs: context window, max output, modalities, knowledge cutoff
-- Sources:
--   OpenAI:    developers.openai.com/api/docs/models/* (2026-02-20)
--   Anthropic: platform.claude.com/docs/en/about-claude/models/all-models (2026-02-20)

CREATE TABLE IF NOT EXISTS model_capabilities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            VARCHAR(50)  NOT NULL,           -- 'openai', 'anthropic', 'voyageai'
  model               VARCHAR(100) NOT NULL UNIQUE,    -- exact API model ID
  display_name        VARCHAR(200) NOT NULL,
  context_window      INTEGER,                         -- max input tokens
  max_output_tokens   INTEGER,                         -- max completion/output tokens
  input_modalities    TEXT[]       NOT NULL DEFAULT ARRAY['text'],   -- 'text','image','audio'
  output_modalities   TEXT[]       NOT NULL DEFAULT ARRAY['text'],
  supports_streaming  BOOLEAN      NOT NULL DEFAULT true,
  supports_functions  BOOLEAN      NOT NULL DEFAULT true,
  supports_json_mode  BOOLEAN      NOT NULL DEFAULT true,
  supports_vision     BOOLEAN      NOT NULL DEFAULT false,
  knowledge_cutoff    DATE,
  is_active           BOOLEAN      NOT NULL DEFAULT true,
  notes               TEXT,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_capabilities_provider ON model_capabilities(provider);
CREATE INDEX IF NOT EXISTS idx_model_capabilities_active   ON model_capabilities(is_active);

-- ----------------------------------------------------------------
-- OpenAI models
-- ----------------------------------------------------------------
INSERT INTO model_capabilities
  (provider, model, display_name, context_window, max_output_tokens,
   supports_vision, knowledge_cutoff, is_active, notes)
VALUES
  -- GPT-5 family (context: 400K, output: 128K)
  ('openai', 'gpt-5.2',    'GPT-5.2',    400000, 131072, true, '2025-08-31', true,  'Flagship. Найкраща модель для кодування та агентних задач'),
  ('openai', 'gpt-5.1',    'GPT-5.1',    400000, 131072, true, '2025-08-31', true,  'Рекомендована для більшості задач'),
  ('openai', 'gpt-5',      'GPT-5',      400000, 131072, true, '2025-04-30', true,  NULL),
  ('openai', 'gpt-5-mini', 'GPT-5 Mini', 400000, 131072, true, '2025-04-30', true,  'Швидкість + ефективність'),
  ('openai', 'gpt-5-nano', 'GPT-5 Nano', 400000, 131072, true, '2025-04-30', true,  'Найшвидша та найдешевша'),

  -- GPT-4.1 family (context: ~1M, output: 32K)
  ('openai', 'gpt-4.1',      'GPT-4.1',      1047576, 32768, true, '2024-06-01', true, '1M context window'),
  ('openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', 1047576, 32768, true, '2024-06-01', true, '1M context window'),
  ('openai', 'gpt-4.1-nano', 'GPT-4.1 Nano', 1047576, 32768, true, '2024-06-01', true, '1M context window, найдешевший з 4.1'),

  -- GPT-4o family (legacy, context: 128K, output: 16K)
  ('openai', 'gpt-4o',            'GPT-4o',            128000, 16384, true, '2023-10-01', false, 'Legacy'),
  ('openai', 'gpt-4o-mini',       'GPT-4o Mini',       128000, 16384, true, '2023-10-01', false, 'Legacy'),
  ('openai', 'gpt-4o-2024-08-06', 'GPT-4o (2024-08-06)', 128000, 16384, true, '2023-10-01', false, 'Legacy'),
  ('openai', 'gpt-4o-2024-11-20', 'GPT-4o (2024-11-20)', 128000, 16384, true, '2023-10-01', false, 'Legacy'),

  -- Reasoning models
  ('openai', 'o4-mini', 'o4-mini', 200000, 100000, true,  '2025-04-30', true,  'Reasoning. Швидкий, ефективний для коду'),
  ('openai', 'o3',      'o3',      200000, 100000, true,  '2025-04-30', true,  'Reasoning. Складні математика/наука/код'),
  ('openai', 'o1',      'o1',      200000, 100000, false, '2024-06-01', false, 'Legacy reasoning')

ON CONFLICT (model) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  context_window    = EXCLUDED.context_window,
  max_output_tokens = EXCLUDED.max_output_tokens,
  supports_vision   = EXCLUDED.supports_vision,
  knowledge_cutoff  = EXCLUDED.knowledge_cutoff,
  is_active         = EXCLUDED.is_active,
  notes             = EXCLUDED.notes,
  updated_at        = NOW();

-- ----------------------------------------------------------------
-- Anthropic models
-- ----------------------------------------------------------------
INSERT INTO model_capabilities
  (provider, model, display_name, context_window, max_output_tokens,
   supports_vision, knowledge_cutoff, is_active, notes)
VALUES
  -- Current models
  ('anthropic', 'claude-sonnet-4-6',          'Claude Sonnet 4.6', 200000,  65536, true, '2026-01-01', true,  'Актуальна. 1M beta через context-1m-2025-08-07 header. Training cutoff: Jan 2026'),
  ('anthropic', 'claude-opus-4-6',            'Claude Opus 4.6',   200000, 131072, true, '2025-05-31', true,  'Актуальна. 1M beta. Найвищий інтелект'),
  ('anthropic', 'claude-opus-4-5-20251101',   'Claude Opus 4.5',   200000,  65536, true, '2025-08-31', true,  NULL),
  ('anthropic', 'claude-haiku-4-5-20251001',  'Claude Haiku 4.5',  200000,  65536, true, '2025-07-31', true,  'Найшвидша'),
  ('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 200000,  65536, true, '2025-07-31', true,  '1M beta'),

  -- Legacy models
  ('anthropic', 'claude-opus-4-1-20250805',  'Claude Opus 4.1',  200000, 32768, true, '2025-03-31', false, 'Legacy'),
  ('anthropic', 'claude-opus-4-20250514',    'Claude Opus 4',    200000, 32768, true, '2025-03-31', false, 'Legacy'),
  ('anthropic', 'claude-sonnet-4-20250514',  'Claude Sonnet 4',  200000, 65536, true, '2025-03-31', false, 'Legacy. 1M beta'),
  ('anthropic', 'claude-3-haiku-20240307',   'Claude Haiku 3',   200000,  4096, true, '2023-08-01', false, 'DEPRECATED — retiring 2026-04-19')

ON CONFLICT (model) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  context_window    = EXCLUDED.context_window,
  max_output_tokens = EXCLUDED.max_output_tokens,
  supports_vision   = EXCLUDED.supports_vision,
  knowledge_cutoff  = EXCLUDED.knowledge_cutoff,
  is_active         = EXCLUDED.is_active,
  notes             = EXCLUDED.notes,
  updated_at        = NOW();
