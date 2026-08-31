-- Migration 186: pricing for search_amcu_practice.
--
-- Exposed on /api/v2/mcp, which bills per call from the ₴/$ balance, so it needs a
-- tool_pricing row or it falls through to the billing layer's default.
--
-- Priced at the semantic-search tier rather than the registry tier: unlike the plain
-- table searches at $0.0003, every call embeds the query through tei-bge-m3 before it
-- touches Qdrant. Still an order below search_legislation's $0.02, which additionally
-- runs an LLM grounding pass.

INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, notes)
VALUES
  ('search_amcu_practice', 'backend', 'Семантичний пошук практики АМКУ', 0.00100000,
   '174K фрагментів з 2 600 рішень АМКУ; вартість включає ембединг запиту через bge-m3')
ON CONFLICT (tool_name) DO UPDATE SET
  base_cost_usd = EXCLUDED.base_cost_usd,
  display_name = EXCLUDED.display_name,
  service = EXCLUDED.service,
  notes = EXCLUDED.notes;
