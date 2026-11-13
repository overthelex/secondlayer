-- Migration 261: pricing for get_company_dossier (LEXAI-2227).
--
-- One call fans out to ~25 registry sub-calls (ЄДР, санкції, борги, ProZorro,
-- Є-Data, ЄДЕССБ, суди), which priced one by one at $0.0003-0.0005 come to about
-- $0.008. The dossier is priced near that sum so it is not cheaper than the parts.
-- Sub-calls made inside the dossier go through the tool registry directly and are
-- not billed again.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, notes)
VALUES
  ('get_company_dossier', 'backend', 'Досьє компанії за ЄДРПОУ', 0.00800000, '~25 підзапитів до реєстрів + суди за назвою')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  notes = EXCLUDED.notes;
