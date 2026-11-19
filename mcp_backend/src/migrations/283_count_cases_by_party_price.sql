-- Migration 283: list price of count_cases_by_party.
-- It was priced like an exact registry lookup ($0.01100657 ≈ 0.50 UAH, same as
-- openreyestr_get_by_edrpou), although one call aggregates a party across every court and year
-- (unique cases, documents, by-court breakdown, role filter) and costs seconds of database IO.
-- Benchmark (19.11.2026): YouControl API (YouScore Easy start) €4,500/year for 10,000
-- transactions ≈ €0.45 ≈ 23 UAH per request, court data billed per request; Opendatabot
-- 0.45–7.60 UAH. $0.088 ≈ 4 UAH (NBU 45.4274) sits next to search_case_status_by_party
-- ($0.08) and stays ~4.5× below one YouControl transaction even with the +30% startup markup.
-- A failed (timed-out) call is not charged.
UPDATE tool_pricing
   SET base_cost_usd = 0.08800000,
       notes = 'Кількість справ за стороною (таблиця сторін ЄДРСР 2005–2026, розбивка по судах), ' ||
               '4,00 грн за курсом НБУ 45,4274. Бенчмарк 19.11.2026: YouControl API ≈23 грн/запит, Opendatabot 0,45–7,60 грн',
       updated_by = 'migration_283',
       updated_at = NOW()
 WHERE tool_name = 'count_cases_by_party';
