/**
 * Curated MCP tool set (v2)
 *
 * The single source of truth for the small, focused tool list exposed to external
 * MCP clients (ChatGPT connector, Claude Desktop/Code). Instead of surfacing the
 * ~100+ low-level tools registered in the ToolRegistry — which makes tool selection
 * intractable for the model and can exceed client-side tool-count limits — both
 * transports advertise only this curated subset:
 *
 *   • /api/v2/mcp  (Streamable HTTP, buildMcpServerV2)
 *   • /sse         (legacy SSE transport, MCPSSEServer)
 *
 * IMPORTANT: keep this in sync with the actual handler names registered in
 * factories/tool-services.ts (local tools) and with the remote routes in
 * tool-registry.ts (rada_* / openreyestr_*).
 *
 * Local vs remote matters per transport: /api/v2/mcp merges remote definitions via
 * getAllToolDefinitions(), so prefixed tools resolve there. /sse lists only
 * getLocalToolDefinitions(), so every prefixed (rada_, openreyestr_) name below is
 * skipped on that transport and logged as missing — expected, not a regression.
 */
export const V2_TOOL_NAMES = new Set<string>([
  // Legislation (6)
  'search_legislation',
  'get_legislation_section',
  'get_legislation_articles',
  'get_legislation_structure',
  'get_legislation_history',
  'list_legislation_editions',
  // Повний корпус НПА (schema `npa`) — 293K актів / 439K редакцій, поза кураторськими ~655
  'search_npa',
  'get_npa_act',
  // Швейцарія (CH) — судові рішення (entscheidsuche.ch) та федеральне законодавство
  // (Fedlex): пошук, точковий у часі текст статті або повного акта, історія змін акта.
  'ch_search_court_decisions',
  'ch_get_court_decision',
  'ch_search_legislation',
  'ch_get_act_article',
  'ch_get_act_history',
  'ch_get_act_text',
  // Швейцарія (CH) — реєстри компаній: Zefix + SHAB + FINMA + SECO + кантональні відомості.
  'ch_search_companies',
  'ch_get_company',
  // Court decisions — ЄДРСР (9)
  'search_court_decisions',
  'get_court_decision',
  'get_case_documents_chain',
  'load_full_texts',
  'find_similar_fact_pattern_cases',
  'compare_practice_pro_contra',
  'count_cases_by_party',
  'check_precedent_status',
  'get_citation_graph',
  // Реєстри відкритих даних — local handler (ТМ/патенти, санкції, АМКУ, стенограми, фінзвітність)
  'search_registry',
  // Семантичний пошук практики АМКУ — доповнює keyword-пошук у search_registry
  'search_amcu_practice',
  // Державні реєстри OpenReyestr — remote (proxied via getAllToolDefinitions on /api/v2/mcp).
  // company/EDRPOU, beneficiaries, debtors, enforcement, bankruptcy, Prozorro, sanctions, ARMA, NAZK, notaries.
  'openreyestr_get_by_edrpou',
  'openreyestr_get_entity_details',
  'openreyestr_search_entities',
  'openreyestr_search_beneficiaries',
  'openreyestr_search_debtors',
  'openreyestr_search_enforcement_proceedings',
  'openreyestr_search_bankruptcy_cases',
  'openreyestr_search_prozorro',
  'openreyestr_search_rnbo_sanctions',
  'openreyestr_search_arma_seized_assets',
  'openreyestr_search_nazk_declarations',
  'openreyestr_search_notaries',
  // ЄДР — решта OpenReyestr: податковий борг, ЄСВ, єдиний податок, припинення,
  // арбітражні керуючі, спеціальні форми, зведена статистика реєстрів.
  'openreyestr_search_tax_debt',
  'openreyestr_search_esv_debt',
  'openreyestr_search_single_tax_payers',
  'openreyestr_search_termination_started',
  'openreyestr_search_arbitration_managers',
  'openreyestr_search_special_forms',
  'openreyestr_get_statistics',
  // Парламент — remote (rada_*). Законопроєкти, супровідні документи (висновки
  // ГНЕУ/комітетів/ГЮУ), депутати, голосування.
  // rada_search_legislation_text свідомо НЕ включено: rada.legislation — поверхневий
  // кеш карток, його full_text_plain містить навігаційний мотлох, а не текст акта.
  'rada_search_parliament_bills',
  'rada_search_bill_documents',
  'rada_get_deputy_info',
  'rada_analyze_voting_record',
  // Відкриті дані України — local handlers.
  'search_public_spending',        // Є-Data: spending_acts 8.8M, addendums 2M
  'search_edrnpa',                 // ЄДРНПА Мін'юсту: 141K карток + тексти
  'search_court_case_status',      // стан розгляду справ (лише Верховний Суд, 1.25M)
  'search_court_hearing_schedule', // розклад засідань, 481K
  'search_invalid_passports',      // недійсні паспорти, 2.89M + 195K закордонних
  'search_judges',                 // судді: judges_current + історія
  'search_vrp_judges_discipline',  // ВРП: звільнені / відсторонені / втручання
  'search_vkks',                   // ВККС: судді, оцінювання, декларації, вакансії
  // Інтелектуальна власність — ip_objects 820K + ip_object_events 2.0M.
  'search_ip_objects',
  'get_ip_object',
  'get_trademark_dossier',
  'find_similar_trademarks',
]);
