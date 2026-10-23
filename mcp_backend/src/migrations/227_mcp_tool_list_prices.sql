-- Migration 227: per-call list prices for the legal.org.ua MCP v2 tools (23.10.2026).
-- Benchmarked against the ZakonOnline API contract (0,27-0,30 грн per request, 0,10 above
-- 50k/month) and Opendatabot's public API offer (0,45-7,60 грн per request). Prices are set
-- in UAH and stored in USD at 41,5 грн/$ (the rate used in our commercial offers).
-- Only MCP tools change; search_court_decisions, search_legislation, court status/schedule,
-- Rada, IP and the remaining registries keep their prices. Idempotent: plain UPDATEs.

-- Одне судове рішення: не дорожче за ZakonOnline (0,29 грн/запит): 0,25 грн
UPDATE tool_pricing SET base_cost_usd = 0.00602410, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('get_court_decision');

-- Законодавство: статті, структура, історія, редакції, пошук у корпусі НПА: 0,10 грн
UPDATE tool_pricing SET base_cost_usd = 0.00240964, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('get_legislation_articles', 'get_legislation_section', 'get_legislation_structure', 'get_legislation_history', 'list_legislation_editions', 'search_npa');

-- Картка та текст акта НПА: 0,04 грн
UPDATE tool_pricing SET base_cost_usd = 0.00096386, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('get_npa_act');

-- Аналітика: пошук за схожими фактами: 3,00 грн
UPDATE tool_pricing SET base_cost_usd = 0.07228916, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('find_similar_fact_pattern_cases');

-- Аналітика: підбірка практики за/проти: 4,00 грн
UPDATE tool_pricing SET base_cost_usd = 0.09638554, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('compare_practice_pro_contra');

-- Статус прецеденту та граф цитувань: 1,00 грн
UPDATE tool_pricing SET base_cost_usd = 0.02409639, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('check_precedent_status', 'get_citation_graph');

-- Кількість справ за стороною: 0,50 грн
UPDATE tool_pricing SET base_cost_usd = 0.01204819, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('count_cases_by_party');

-- Реєстри: пошук за ЄДРПОУ, картка юрособи (Опендатабот 0,45-0,80 грн): 0,50 грн
UPDATE tool_pricing SET base_cost_usd = 0.01204819, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('openreyestr_get_by_edrpou', 'openreyestr_get_entity_details');

-- Реєстри: пошук юросіб, бенефіціарів, боржників, ВП, банкрутств, податкового боргу, Prozorro: 1,00 грн
UPDATE tool_pricing SET base_cost_usd = 0.02409639, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('openreyestr_search_entities', 'openreyestr_search_beneficiaries', 'openreyestr_search_debtors', 'openreyestr_search_enforcement_proceedings', 'openreyestr_search_bankruptcy_cases', 'openreyestr_search_tax_debt', 'openreyestr_search_prozorro');

-- Реєстри: санкції РНБО, декларації НАЗК: 2,50 грн
UPDATE tool_pricing SET base_cost_usd = 0.06024096, markup_percent = 0, updated_at = NOW(), updated_by = 'migration_227'
WHERE tool_name IN ('openreyestr_search_rnbo_sanctions', 'openreyestr_search_nazk_declarations');
