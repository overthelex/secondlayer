-- Migration 185: pricing for the full-НПА-corpus tools (search_npa, get_npa_act).
--
-- Both are exposed on /api/v2/mcp, which bills per call from the ₴/$ balance, so each
-- needs a tool_pricing row or it falls through to the billing layer's default.
--
-- search_npa runs a GIN FTS over 429K current edition texts -> priced like the other
-- open-data searches ($0.0005). get_npa_act is a PK lookup in npa.act/edition/article
-- -> priced like get_legislation_section ($0.0001).

INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, notes)
VALUES
  ('search_npa',   'backend', 'Пошук у повному корпусі НПА',   0.00050000, '293K актів / 439K редакцій, GIN FTS по чинних редакціях'),
  ('get_npa_act',  'backend', 'Картка та текст акта НПА',      0.00010000, 'PK-лукап у npa.act/edition/article, як get_legislation_section')
ON CONFLICT (tool_name) DO UPDATE SET
  base_cost_usd = EXCLUDED.base_cost_usd,
  display_name = EXCLUDED.display_name,
  service = EXCLUDED.service,
  notes = EXCLUDED.notes;
