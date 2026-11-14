-- Migration 266: get_company_dossier price at the current NBU rate (LEXAI-2227).
--
-- Migration 265 stored 8,00 грн at 41,5 грн/$ (the rate of migration 227). UAH
-- charges convert at the live NBU rate (currency-service), which on 14.11.2026 is
-- 45,4274 грн/$, so 0.19277108 USD was being charged as ~8,76 грн. Stored at the
-- current rate, 8,00 грн = 0.17610517 USD.
UPDATE tool_pricing
SET base_cost_usd = 0.17610517,
    notes = '8,00 грн за курсом НБУ 45,4274 (14.11.2026): ~25 підзапитів до реєстрів + суди за назвою',
    updated_at = NOW(),
    updated_by = 'migration_266'
WHERE tool_name = 'get_company_dossier';
