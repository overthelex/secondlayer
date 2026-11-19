-- Migration 289: list prices of the MCP v2 tools, benchmarked 20.11.2026 (48 tools).
-- Benchmarks: YouControl API (YouScore Easy start) €4,500/yr ÷ 10,000 transactions ≈ 23 UAH per
-- request; Opendatabot API ≈6.3–7.6 UAH per check; ZakonOnline API ≈0.27–0.30 UAH; sudovispravy
-- ≈0.24 UAH per API op and 4.90 UAH per AI analysis; LIGA360 ≈3–8 UAH per query implied by the seat.
-- Ladder (UAH at NBU 45.4274, before tier markup): 0.25 floor for open-data lookups and document
-- fetches (0.01–0.10 was below ZakonOnline and below cost to serve); 0.50–1.00 for cards and
-- searches; 1.50–2.50 for reverse ownership, snapshot history and compliance screening; 3–5 for
-- LLM analytics; 8 for multi-source dossiers. The top price stays ≈1/3 of one YouControl transaction.
-- search_court_decisions and search_legislation: the old price barely covered their LLM cost.
-- search_registry: 0.02 was a back door around openreyestr_search_entities over the same ЄДР data.
UPDATE tool_pricing p
   SET base_cost_usd = v.price,
       updated_by = 'migration_289',
       updated_at = NOW()
  FROM (VALUES
  ('check_precedent_status', 0.03301972),
  ('compare_practice_pro_contra', 0.11006573),
  ('find_similar_trademarks', 0.06603944),
  ('get_case_documents_chain', 0.01650986),
  ('get_case_status_details', 0.02201315),
  ('get_financial_statements', 0.04402629),
  ('get_ip_object', 0.01100657),
  ('get_legislation_articles', 0.00550329),
  ('get_legislation_history', 0.01100657),
  ('get_legislation_section', 0.00550329),
  ('get_legislation_structure', 0.00550329),
  ('get_npa_act', 0.00550329),
  ('get_trademark_dossier', 0.17610517),
  ('list_legislation_editions', 0.01100657),
  ('load_full_texts', 0.02201315),
  ('openreyestr_company_as_of', 0.04402629),
  ('openreyestr_company_history', 0.04402629),
  ('openreyestr_get_entity_details', 0.01650986),
  ('openreyestr_search_arbitration_managers', 0.00550329),
  ('openreyestr_search_arma_seized_assets', 0.01100657),
  ('openreyestr_search_beneficiaries', 0.03301972),
  ('openreyestr_search_beneficiaries_history', 0.05503287),
  ('openreyestr_search_esv_debt', 0.01100657),
  ('openreyestr_search_founders', 0.03301972),
  ('openreyestr_search_founders_history', 0.05503287),
  ('openreyestr_search_nazk_declarations', 0.04402629),
  ('openreyestr_search_notaries', 0.00550329),
  ('openreyestr_search_single_tax_payers', 0.00550329),
  ('openreyestr_search_special_forms', 0.00550329),
  ('openreyestr_search_termination_started', 0.00550329),
  ('rada_analyze_voting_record', 0.01100657),
  ('rada_get_deputy_info', 0.00550329),
  ('rada_search_bill_documents', 0.00880526),
  ('rada_search_parliament_bills', 0.00660394),
  ('search_amcu_practice', 0.01650986),
  ('search_court_case_status', 0.00550329),
  ('search_court_decisions', 0.02201315),
  ('search_court_hearing_schedule', 0.01100657),
  ('search_edrnpa', 0.00550329),
  ('search_invalid_passports', 0.01100657),
  ('search_ip_objects', 0.02201315),
  ('search_judges', 0.00550329),
  ('search_legislation', 0.02201315),
  ('search_npa', 0.01100657),
  ('search_public_spending', 0.01650986),
  ('search_registry', 0.01100657),
  ('search_vkks', 0.00550329),
  ('search_vrp_judges_discipline', 0.00550329)
  ) AS v(tool_name, price)
 WHERE p.tool_name = v.tool_name;
