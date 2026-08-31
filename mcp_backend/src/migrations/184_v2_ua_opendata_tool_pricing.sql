-- Migration 184: pricing for the Ukrainian open-data tools added to the v2 curated set.
--
-- PR #2254 grew V2_TOOL_NAMES (curated-mcp-tools.ts) from 28 to 51 tools. /api/v2/mcp bills
-- per call from the ₴/$ balance, so every exposed tool needs a tool_pricing row — without one
-- the call falls through to whatever default the billing layer applies (same gap migration 175
-- closed for the original 28). 11 of the 23 new names were already priced; these are the other 12.
--
-- Scale follows the post-migration-139 (reduced) tiers, matched to sibling tools:
--   * single-record lookups            -> $0.0001 (like get_legislation_section)
--   * plain registry/table searches    -> $0.0003 (like search_judges, search_vkks)
--   * heavy multi-query / fuzzy search -> $0.0005 (like search_registry, openreyestr_search_entities)

INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, notes)
VALUES
  -- Відкриті дані України — локальні хендлери
  ('search_edrnpa',                        'backend',     'Пошук НПА в ЄДРНПА',                 0.00030000, '141K карток Мін''юсту, як search_judges'),
  ('search_court_case_status',             'backend',     'Стан розгляду судових справ',        0.00030000, '1.25M записів, лише Верховний Суд'),
  ('search_court_hearing_schedule',        'backend',     'Розклад судових засідань',           0.00030000, '481K записів'),
  ('search_invalid_passports',             'backend',     'Перевірка недійсних паспортів',      0.00030000, '2.89M + 195K закордонних'),
  ('search_public_spending',               'backend',     'Пошук у публічних коштах (Є-Data)',  0.00050000, '8.8M актів + 2M додатків, важкий скан'),
  -- Інтелектуальна власність
  ('search_ip_objects',                    'backend',     'Пошук об''єктів права ІВ',           0.00050000, 'ip_objects 820K, як search_registry'),
  ('get_ip_object',                        'backend',     'Картка об''єкта права ІВ',           0.00010000, 'Один запис + таймлайн подій'),
  ('get_trademark_dossier',                'backend',     'Досьє торговельної марки',           0.00050000, 'Кілька запитів + події, найважчий з ІВ-інструментів'),
  ('find_similar_trademarks',              'backend',     'Пошук схожих торговельних марок',    0.00050000, 'pg_trgm колізії в межах класу'),
  -- ЄДР — решта OpenReyestr
  ('openreyestr_search_tax_debt',          'openreyestr', 'Податковий борг',                    0.00030000, '861K записів, як інші openreyestr-пошуки'),
  ('openreyestr_search_esv_debt',          'openreyestr', 'Борг з ЄСВ',                         0.00030000, '668K записів'),
  ('openreyestr_search_single_tax_payers', 'openreyestr', 'Платники єдиного податку',           0.00030000, '152K записів')
ON CONFLICT (tool_name) DO UPDATE SET
  base_cost_usd = EXCLUDED.base_cost_usd,
  display_name = EXCLUDED.display_name,
  service = EXCLUDED.service,
  notes = EXCLUDED.notes;
