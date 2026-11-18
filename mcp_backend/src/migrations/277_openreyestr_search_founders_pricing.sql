-- Migration 277: pricing for openreyestr_search_founders (reverse search by founder).
-- Same price as the other ЄДР searches (search_entities, search_beneficiaries): 1,00 грн.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('openreyestr_search_founders', 'openreyestr', 'Пошук за засновниками', 0.02409639, 0, 'Зворотний пошук за засновником / країною', 'migration_277')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
