-- Migration 290: list prices for the two document lookups added to MCP v2.
-- edrsr_get_decision_dispositive and get_decision_cited_norms are single doc_id lookups,
-- cheaper to serve than get_court_decision (a resolutive part, or a grouped read of the
-- citation graph). They take the floor of the migration 289 ladder: 0.25 UAH at NBU
-- 45.4274 (0.00550329 USD), the same as get_court_decision and below ZakonOnline's
-- 0.27–0.30 UAH per API operation. Every v2 tool needs a row here, otherwise billing
-- falls through to the default price.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('edrsr_get_decision_dispositive', 'backend', 'Резолютивна частина рішення', 0.00550329, 0,
   'Лише ВИРІШИВ / УХВАЛИВ / ПОСТАНОВИВ за doc_id, нижня сходинка прайсу (курс НБУ 45,4274, 14.11.2026)', 'migration_290'),
  ('get_decision_cited_norms', 'backend', 'Норми, цитовані рішенням', 0.00550329, 0,
   'Статті законів з графа цитувань за doc_id, нижня сходинка прайсу (курс НБУ 45,4274, 14.11.2026)', 'migration_290')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
