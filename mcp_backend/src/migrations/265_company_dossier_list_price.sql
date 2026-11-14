-- Migration 265: list price for get_company_dossier (LEXAI-2227).
--
-- Migration 261 priced the dossier at $0.008 (0,33 грн) from the sub-call prices
-- before migration 227. At the 227 list prices (UAH, stored in USD at 41,5 грн/$)
-- its ~25 sub-calls come to ~10,3 грн, up to ~16 грн with the shared-contact
-- probes: ЄДР card + details + courts 3 x 0,50; debtors, enforcement, tax debt,
-- bankruptcy, ProZorro supplier and buyer 6 x 1,00; RNBO sanctions 2,50; the other
-- 15 registries ~0,25; each shared phone/email probe 1,00. The sub-calls are not
-- billed separately, so the dossier was a third of one ProZorro search.
-- Set to 8,00 грн: a bundle discount on the parts, near Opendatabot's top request
-- price (7,60 грн). Tier markup applies on top, as for every tool.
UPDATE tool_pricing
SET base_cost_usd = 0.19277108,
    markup_percent = 0,
    notes = '8,00 грн: ~25 підзапитів до реєстрів (за прайсом ~10-16 грн) + суди за назвою',
    updated_at = NOW(),
    updated_by = 'migration_265'
WHERE tool_name = 'get_company_dossier';
