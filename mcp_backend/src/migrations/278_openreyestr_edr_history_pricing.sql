-- Migration 278: pricing for the ЄДР history tools (openreyestr schema edr_hist).
-- Same price as the other ЄДР searches (search_entities, search_founders): 1,00 грн.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('openreyestr_company_as_of', 'openreyestr', 'ЄДР станом на дату', 0.02409639, 0, 'Юрособа за знімком ЄДР на дату', 'migration_278'),
  ('openreyestr_company_history', 'openreyestr', 'Історія змін у ЄДР', 0.02409639, 0, 'Значення полів юрособи за знімками ЄДР', 'migration_278'),
  ('openreyestr_search_founders_history', 'openreyestr', 'Засновники, зокрема колишні', 0.02409639, 0, 'Пошук засновника в усіх знімках ЄДР', 'migration_278'),
  ('openreyestr_search_beneficiaries_history', 'openreyestr', 'Бенефіціари, зокрема колишні', 0.02409639, 0, 'Пошук КБВ в усіх знімках ЄДР', 'migration_278')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
