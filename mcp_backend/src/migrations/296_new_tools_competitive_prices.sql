-- Migration 296: list prices of the MCP v2 tools added on 20.11.2026, set against competitors
-- (benchmarks gathered 20.11.2026; UAH at NBU 45.4274 as in migration 289, before tier markup).
--   search_offshore_leaks 1.50 → 1.00: ICIJ itself is free; the cheapest per-call screening APIs
--     are OpenSanctions (€0.10 per query, €0.03 ≈1.46 UAH at the 500K bundle) and Dilisense
--     (€0.10), Clarity Project API 1.35–2.64. 1.00 is the cards/searches step and stays below all.
--   get_company_dossier 8.00 → 6.00: Opendatabot API «full data» 7,608 UAH/yr ÷ 1,200 = 6.34 and
--     7,600/mo ÷ 1,000 = 7.60; YouScore Easy start €4,500 ÷ 10,000 ≈ 22. The dossier now also
--     carries ICIJ, Cyprus founders (DRCOR) and inspection plans, none of which those offer.
--   search_cyprus_companies 0.50 (kept): the DRCOR web search is free, a DRCOR certificate is €20
--     (≈970 UAH), OpenCorporates API ≈11.5–21.6 per call (plan ÷ quota).
--   openreyestr_search_inspection_plans 0.25 (kept): inspections.gov.ua is free and competitors
--     only bundle inspections into the company card, so the floor of the ladder.
--   edrsr_get_decision_dispositive, get_decision_cited_norms 0.25 (kept): sudovispravy 0.24/0.14
--     per operation inside a 1,199 UAH/mo or 8,399 UAH/yr subscription; we are pay-per-call, at
--     the ladder floor.
--   get_citation_graph 1.00 (kept): «хто цитує» exists only inside subscriptions (LIGA360,
--     Verdictum), with no per-call price.
--   search_registry 0.50 (kept): Opendatabot ЄДР-only API 0.45–0.80, Clarity 1.35–2.64.
-- The INSERT also creates the rows of migrations 291–293 where those have not been applied.
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, markup_percent, notes, updated_by)
VALUES
  ('search_cyprus_companies', 'backend', 'Реєстр компаній Кіпру (DRCOR)', 0.01100657, 0,
   '0,50 грн: пошук DRCOR безкоштовний, сертифікат DRCOR €20, OpenCorporates API ≈11,5–21,6 грн за виклик (курс НБУ 45,4274, 20.11.2026)', 'migration_296'),
  ('search_offshore_leaks', 'backend', 'ICIJ Offshore Leaks: офшорні компанії та особи', 0.02201315, 0,
   '1,00 грн: нижче OpenSanctions (€0,10, від €0,03 ≈1,46 грн), Dilisense (€0,10), Clarity API 1,35 грн; сама база ICIJ безкоштовна (курс НБУ 45,4274, 20.11.2026)', 'migration_296'),
  ('openreyestr_search_inspection_plans', 'openreyestr', 'Плани перевірок державного нагляду', 0.00550329, 0,
   '0,25 грн, нижня сходинка: inspections.gov.ua безкоштовний, у конкурентів лише в картці компанії (курс НБУ 45,4274, 20.11.2026)', 'migration_296'),
  ('edrsr_get_decision_dispositive', 'backend', 'Резолютивна частина рішення', 0.00550329, 0,
   '0,25 грн, нижня сходинка: sudovispravy 0,14–0,24 грн за операцію лише в підписці від 1 199 грн/міс (курс НБУ 45,4274, 20.11.2026)', 'migration_296'),
  ('get_decision_cited_norms', 'backend', 'Норми, цитовані рішенням', 0.00550329, 0,
   '0,25 грн, нижня сходинка: sudovispravy 0,14–0,24 грн за операцію лише в підписці від 1 199 грн/міс (курс НБУ 45,4274, 20.11.2026)', 'migration_296'),
  ('get_citation_graph', 'backend', 'Граф цитувань між справами', 0.02201315, 0,
   '1,00 грн: норми, хто цитує справу, кого цитує вона; у LIGA360 і Verdictum лише в підписці (курс НБУ 45,4274, 20.11.2026)', 'migration_296'),
  ('get_company_dossier', 'backend', 'Досьє компанії за ЄДРПОУ', 0.13207888, 0,
   '6,00 грн: нижче Opendatabot API «повні дані» 6,34–7,60 грн і YouScore ≈22 грн; плюс ICIJ, кіпрські засновники, плани перевірок (курс НБУ 45,4274, 20.11.2026)', 'migration_296'),
  ('search_registry', 'backend', 'Пошук по відкритих реєстрах', 0.01100657, 0,
   '0,50 грн: 30 реєстрів; Opendatabot ЄДР API 0,45–0,80 грн, Clarity API 1,35–2,64 грн (курс НБУ 45,4274, 20.11.2026)', 'migration_296')
ON CONFLICT (tool_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_cost_usd = EXCLUDED.base_cost_usd,
  markup_percent = EXCLUDED.markup_percent,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
