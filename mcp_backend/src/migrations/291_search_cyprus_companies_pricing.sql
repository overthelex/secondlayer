-- Migration 291 (LEXAI-2310): list price for search_cyprus_companies on MCP v2.
-- A search over the Cyprus DRCOR register (cy_companies, migration 288) that returns cards
-- with registered office and officials: the 0.50 UAH step of the migration 289 ladder for
-- cards and searches, at NBU 45.4274 (0.01100657 USD), the same as openreyestr_get_by_edrpou.
-- Every v2 tool needs a row here, otherwise billing falls through to the default price.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('search_cyprus_companies', 'backend', 'Реєстр компаній Кіпру (DRCOR)', 0.01100657, 0,
   'Пошук компаній Кіпру за назвою, номером HE/AE чи посадовою особою; 0,50 грн за прайсом (курс НБУ 45,4274, 14.11.2026)', 'migration_291')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
