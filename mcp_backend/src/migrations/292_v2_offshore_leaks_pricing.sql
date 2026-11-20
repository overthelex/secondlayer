-- Migration 292: list price for search_offshore_leaks (LEXAI-2311).
-- Name search over the ICIJ Offshore Leaks graph (icij_nodes 2.0M, icij_relationships 3.3M,
-- migration 287) with one or two hops of relationships: compliance screening with a graph,
-- the 1.50 UAH step of the migration 289 ladder (between cards/searches at 0.50–1.00 and
-- reverse ownership at 2.50). At NBU 45.4274 that is 0.03301972 USD. Every v2 tool needs a
-- row here, otherwise billing falls through to the default price.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('search_offshore_leaks', 'backend', 'ICIJ Offshore Leaks: офшорні компанії та особи', 0.03301972, 0,
   'Пошук у графі ICIJ Offshore Leaks за назвою зі зв’язками на 1–2 кроки, сходинка комплаєнс-перевірки (1,50 грн, курс НБУ 45,4274, 14.11.2026)', 'migration_292')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
