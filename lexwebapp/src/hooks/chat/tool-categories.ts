/**
 * Tool category configuration for the manual tool picker UI.
 */

export interface ToolOption {
  name: string;
  label: string;
}

export interface ToolCategory {
  id: string;
  label: string;
  tools: ToolOption[];
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: 'court',
    label: 'Судові справи',
    tools: [
      { name: 'search_legal_precedents', label: 'Пошук справ' },
      { name: 'get_court_decision', label: 'Рішення суду' },
      { name: 'get_case_documents_chain', label: 'Ланцюг документів' },
      { name: 'find_similar_fact_pattern_cases', label: 'Схожі справи' },
      { name: 'compare_practice_pro_contra', label: 'За і проти' },
      { name: 'count_cases_by_party', label: 'Справи сторони' },
      { name: 'get_case_text', label: 'Текст справи' },
    ],
  },
  {
    id: 'analysis',
    label: 'Аналіз',
    tools: [
      { name: 'analyze_case_pattern', label: 'Аналіз патерну' },
      { name: 'get_citation_graph', label: 'Граф цитувань' },
      { name: 'check_precedent_status', label: 'Статус прецеденту' },
    ],
  },
  {
    id: 'legislation',
    label: 'Законодавство',
    tools: [
      { name: 'search_legislation', label: 'Пошук законів' },
      { name: 'get_legislation_articles', label: 'Статті закону' },
      { name: 'get_legislation_section', label: 'Розділ закону' },
      { name: 'get_legislation_structure', label: 'Структура закону' },
      { name: 'search_procedural_norms', label: 'Процесуальні норми' },
    ],
  },
  {
    id: 'documents',
    label: 'Документи',
    tools: [
      { name: 'store_document', label: 'Зберегти документ' },
      { name: 'list_documents', label: 'Список документів' },
      { name: 'semantic_search', label: 'Семантичний пошук' },
      { name: 'get_document', label: 'Отримати документ' },
      { name: 'parse_document', label: 'Розібрати документ' },
      { name: 'extract_document_sections', label: 'Секції документу' },
      { name: 'summarize_document', label: 'Резюме документу' },
      { name: 'compare_documents', label: 'Порівняти документи' },
      { name: 'extract_key_clauses', label: 'Ключові положення' },
    ],
  },
  {
    id: 'procedural',
    label: 'Процесуальне',
    tools: [
      { name: 'calculate_procedural_deadlines', label: 'Строки' },
      { name: 'build_procedural_checklist', label: 'Чеклист' },
      { name: 'calculate_monetary_claims', label: 'Грошові вимоги' },
    ],
  },
  {
    id: 'dd',
    label: 'Due Diligence',
    tools: [
      { name: 'generate_dd_report', label: 'DD звіт' },
      { name: 'risk_scoring', label: 'Скоринг ризиків' },
      { name: 'format_answer_pack', label: 'Пакет відповідей' },
    ],
  },
  {
    id: 'parliament',
    label: 'Парламент',
    tools: [
      { name: 'rada_search_parliament_bills', label: 'Законопроекти' },
      { name: 'rada_get_deputy_info', label: 'Депутати' },
      { name: 'rada_search_legislation_text', label: 'Текст законів' },
      { name: 'rada_analyze_voting_record', label: 'Голосування' },
    ],
  },
  {
    id: 'registry',
    label: 'Реєстри',
    tools: [
      { name: 'openreyestr_search_entities', label: 'Пошук юросіб' },
      { name: 'openreyestr_get_entity_details', label: 'Деталі юрособи' },
      { name: 'openreyestr_search_beneficiaries', label: 'Бенефіціари' },
      { name: 'openreyestr_get_by_edrpou', label: 'За ЄДРПОУ' },
      { name: 'openreyestr_get_statistics', label: 'Статистика' },
      { name: 'openreyestr_search_enforcement_proceedings', label: 'Виконавчі провадження' },
      { name: 'openreyestr_search_debtors', label: 'Боржники' },
      { name: 'openreyestr_search_bankruptcy_cases', label: 'Банкрутство' },
      { name: 'openreyestr_search_notaries', label: 'Нотаріуси' },
      { name: 'openreyestr_search_court_experts', label: 'Судові експерти' },
      { name: 'openreyestr_search_arbitration_managers', label: 'Арбітражні керуючі' },
    ],
  },
];

export const AI_CHAT_MODE = 'ai_chat';
