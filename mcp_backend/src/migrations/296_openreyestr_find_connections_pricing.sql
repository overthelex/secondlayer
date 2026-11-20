-- Migration 296: list prices for openreyestr_find_connections and openreyestr_connection_path
-- (LEXAI-2308, «Пошук зв'язків» over the ЄДР relationship graph, schema graph in OpenReyestr DB).
-- Same step of the migration 289 ladder as openreyestr_company_history (reverse ownership and
-- snapshot history): 2.00 UAH at NBU 45.4274 (0.04402629 USD), ≈1/10 of one YouControl
-- transaction. Every v2 tool needs a row here, otherwise billing falls through to the default price.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('openreyestr_find_connections', 'openreyestr', 'Пошук зв''язків', 0.04402629, 0,
   'Граф зв''язків ЄДР до 3 кроків від компанії, особи чи адреси; сходинка company_history (курс НБУ 45,4274)', 'migration_296'),
  ('openreyestr_connection_path', 'openreyestr', 'Шлях зв''язку', 0.04402629, 0,
   'Найкоротші шляхи між двома початками в графі ЄДР (до 4 кроків); сходинка company_history (курс НБУ 45,4274)', 'migration_296')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
