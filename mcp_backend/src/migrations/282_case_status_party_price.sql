-- Migration 282: list price of search_case_status_by_party.
-- Search by party name is a scarce product in Ukraine (ЄДРСР texts are anonymised): YouControl API
-- (YouScore Easy start) is €4,500/year for 10,000 transactions ≈ €0.45 ≈ 23 UAH per request,
-- Opendatabot 0.45–7.60 UAH; full-text decision search (ZakonOnline) ≈ 0.3 UAH. $0.08 ≈ 3.6 UAH keeps
-- a question (2–4 searches + a case card, plus tier markup) below one YouControl transaction.
-- get_case_status_details stays at $0.02409639: it is the follow-up step after a search.
UPDATE tool_pricing
   SET base_cost_usd = 0.08000000,
       notes = 'Стан розгляду справ ДСА (накопичена історія) + розклад засідань, пошук за стороною. ' ||
               'Бенчмарк 19.11.2026: YouControl API ≈23 грн/запит, Opendatabot 0,45–7,60 грн',
       updated_by = 'migration_282',
       updated_at = NOW()
 WHERE tool_name = 'search_case_status_by_party';
