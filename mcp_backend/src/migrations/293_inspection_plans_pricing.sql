-- Migration 293: list price for openreyestr_search_inspection_plans (LEXAI-2315).
-- Annual plans of state inspections (inspection_plans, OpenReyestr DB, ~32K rows): an
-- open-data lookup over a small table, so it takes the floor of the migration 289 ladder,
-- 0.25 UAH at NBU 45.4274 (0.00550329 USD), like openreyestr_search_special_forms and
-- openreyestr_search_termination_started. Every v2 tool needs a row here, otherwise
-- billing falls through to the default price.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('openreyestr_search_inspection_plans', 'openreyestr', 'Плани перевірок державного нагляду', 0.00550329, 0,
   'Річні плани планових перевірок; за ЄДРПОУ зіставлення за назвою з ЄДР. Нижня сходинка прайсу (курс НБУ 45,4274, 14.11.2026)', 'migration_293')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
