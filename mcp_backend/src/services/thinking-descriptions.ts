/**
 * Thinking Description Generator
 *
 * Generates human-readable Ukrainian descriptions for tool calls
 * displayed in thinking SSE events. Template-based, no LLM call.
 */

function truncate(text: string, max = 60): string {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max) + '…';
}

function param(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (val === undefined || val === null) return '';
  return String(val);
}

const TOOL_DESCRIPTIONS: Record<string, (p: Record<string, unknown>) => string> = {
  // Court case tools
  search_legal_precedents: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю судову практику: «${truncate(q)}»` : 'Шукаю судову практику';
  },
  search_supreme_court_practice: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю практику ВС: «${truncate(q)}»` : 'Шукаю практику Верховного Суду';
  },
  get_court_decision: (p) => {
    const id = param(p, 'doc_id') || param(p, 'case_number');
    return id ? `Завантажую рішення: ${truncate(id, 30)}` : 'Завантажую судове рішення';
  },
  get_case_documents_chain: (p) => {
    const id = param(p, 'case_number') || param(p, 'doc_id');
    return id ? `Будую ланцюг документів: ${truncate(id, 30)}` : 'Будую ланцюг документів справи';
  },
  find_similar_fact_pattern_cases: (p) => {
    const q = param(p, 'fact_pattern') || param(p, 'query');
    return q ? `Шукаю справи зі схожими фактами: «${truncate(q, 40)}»` : 'Шукаю справи зі схожими фактами';
  },
  compare_practice_pro_contra: (p) => {
    const q = param(p, 'query') || param(p, 'topic');
    return q ? `Аналізую практику за і проти: «${truncate(q, 40)}»` : 'Аналізую практику за і проти';
  },
  count_cases_by_party: (p) => {
    const name = param(p, 'party_name') || param(p, 'query');
    return name ? `Рахую справи сторони: ${truncate(name, 40)}` : 'Рахую справи сторони';
  },
  get_case_text: (p) => {
    const id = param(p, 'doc_id') || param(p, 'case_number');
    return id ? `Отримую повний текст: ${truncate(id, 30)}` : 'Отримую повний текст справи';
  },
  analyze_case_pattern: (p) => {
    const q = param(p, 'query') || param(p, 'pattern');
    return q ? `Аналізую правовий патерн: «${truncate(q, 40)}»` : 'Аналізую правовий патерн';
  },
  get_similar_reasoning: (p) => {
    const q = param(p, 'query') || param(p, 'reasoning');
    return q ? `Шукаю схоже обґрунтування: «${truncate(q, 40)}»` : 'Шукаю схоже обґрунтування';
  },

  // Shepardization tools
  get_citation_graph: (p) => {
    const id = param(p, 'doc_id') || param(p, 'case_number');
    return id ? `Будую граф цитувань: ${truncate(id, 30)}` : 'Будую граф цитувань';
  },
  check_precedent_status: (p) => {
    const id = param(p, 'doc_id') || param(p, 'case_number');
    return id ? `Перевіряю статус прецеденту: ${truncate(id, 30)}` : 'Перевіряю статус прецеденту';
  },

  // Legislation tools
  search_legislation: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю у законодавстві: «${truncate(q)}»` : 'Шукаю у законодавстві';
  },
  get_legislation_article: (p) => {
    const art = param(p, 'article');
    const law = param(p, 'law_name') || param(p, 'law_id');
    if (art && law) return `Завантажую статтю ${art} — ${truncate(law, 40)}`;
    if (art) return `Завантажую статтю ${art}`;
    return 'Завантажую статтю закону';
  },
  get_legislation_articles: (p) => {
    const law = param(p, 'law_name') || param(p, 'law_id');
    return law ? `Завантажую статті: ${truncate(law, 40)}` : 'Завантажую статті закону';
  },
  get_legislation_section: (p) => {
    const law = param(p, 'law_name') || param(p, 'law_id');
    return law ? `Завантажую розділ: ${truncate(law, 40)}` : 'Завантажую розділ закону';
  },
  get_legislation_structure: (p) => {
    const law = param(p, 'law_name') || param(p, 'law_id');
    return law ? `Отримую структуру: ${truncate(law, 40)}` : 'Отримую структуру закону';
  },
  search_procedural_norms: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю процесуальні норми: «${truncate(q, 40)}»` : 'Шукаю процесуальні норми';
  },
  find_relevant_law_articles: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю релевантні статті: «${truncate(q, 40)}»` : 'Шукаю релевантні статті';
  },

  // Document/vault tools
  store_document: () => 'Зберігаю документ у сховище',
  list_documents: () => 'Отримую список документів',
  semantic_search: (p) => {
    const q = param(p, 'query');
    return q ? `Семантичний пошук: «${truncate(q)}»` : 'Виконую семантичний пошук';
  },
  get_document: (p) => {
    const id = param(p, 'document_id') || param(p, 'id');
    return id ? `Завантажую документ: ${truncate(id, 30)}` : 'Завантажую документ';
  },
  parse_document: () => 'Аналізую структуру документу',
  extract_document_sections: () => 'Виділяю секції документу',
  summarize_document: () => 'Створюю резюме документу',
  compare_documents: () => 'Порівнюю документи',
  extract_key_clauses: () => 'Виділяю ключові положення',

  // Procedural tools
  calculate_procedural_deadlines: (p) => {
    const q = param(p, 'case_type') || param(p, 'query');
    return q ? `Розраховую строки: ${truncate(q, 40)}` : 'Розраховую процесуальні строки';
  },
  build_procedural_checklist: (p) => {
    const q = param(p, 'case_type') || param(p, 'query');
    return q ? `Будую чеклист: ${truncate(q, 40)}` : 'Будую процесуальний чеклист';
  },
  calculate_monetary_claims: () => 'Розраховую грошові вимоги',

  // Analytical tools
  generate_dd_report: () => 'Генерую DD звіт',
  risk_scoring: () => 'Оцінюю ризики',
  format_answer_pack: () => 'Формую пакет відповідей',

  // RADA tools
  rada_search_parliament_bills: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю законопроекти Ради: «${truncate(q)}»` : 'Шукаю законопроекти Верховної Ради';
  },
  rada_get_deputy_info: (p) => {
    const name = param(p, 'name') || param(p, 'query');
    return name ? `Отримую інфо про депутата: ${truncate(name, 40)}` : 'Отримую інформацію про депутата';
  },
  rada_search_legislation_text: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю у текстах законів: «${truncate(q)}»` : 'Шукаю у текстах законів';
  },
  rada_analyze_voting_record: (p) => {
    const name = param(p, 'deputy_name') || param(p, 'name');
    return name ? `Аналізую голосування: ${truncate(name, 40)}` : 'Аналізую голосування депутата';
  },

  // OpenReyestr tools
  openreyestr_search_entities: (p) => {
    const q = param(p, 'query') || param(p, 'name');
    return q ? `Шукаю юридичну особу: «${truncate(q)}»` : 'Шукаю юридичних осіб';
  },
  openreyestr_get_entity_details: (p) => {
    const id = param(p, 'edrpou') || param(p, 'id');
    return id ? `Отримую деталі юрособи: ${id}` : 'Отримую деталі юридичної особи';
  },
  openreyestr_search_beneficiaries: (p) => {
    const q = param(p, 'query') || param(p, 'name');
    return q ? `Шукаю бенефіціарів: «${truncate(q)}»` : 'Шукаю бенефіціарних власників';
  },
  openreyestr_get_by_edrpou: (p) => {
    const code = param(p, 'edrpou') || param(p, 'code');
    return code ? `Перевіряю ЄДРПОУ: ${code}` : 'Шукаю за кодом ЄДРПОУ';
  },
  openreyestr_get_statistics: () => 'Отримую статистику реєстру',
  openreyestr_search_notaries: (p) => {
    const q = param(p, 'query') || param(p, 'name');
    return q ? `Шукаю нотаріуса: «${truncate(q)}»` : 'Шукаю нотаріусів';
  },
  openreyestr_search_court_experts: (p) => {
    const q = param(p, 'query') || param(p, 'name');
    return q ? `Шукаю судового експерта: «${truncate(q)}»` : 'Шукаю судових експертів';
  },
  openreyestr_search_arbitration_managers: (p) => {
    const q = param(p, 'query') || param(p, 'name');
    return q ? `Шукаю арбітражного керуючого: «${truncate(q)}»` : 'Шукаю арбітражних керуючих';
  },
  openreyestr_search_debtors: (p) => {
    const q = param(p, 'query') || param(p, 'name');
    return q ? `Шукаю боржника: «${truncate(q)}»` : 'Шукаю боржників';
  },
  openreyestr_search_enforcement_proceedings: (p) => {
    const q = param(p, 'query') || param(p, 'name');
    return q ? `Шукаю виконавче провадження: «${truncate(q)}»` : 'Шукаю виконавчі провадження';
  },
  openreyestr_search_bankruptcy_cases: (p) => {
    const q = param(p, 'query') || param(p, 'name');
    return q ? `Шукаю справу про банкрутство: «${truncate(q)}»` : 'Шукаю справи про банкрутство';
  },
  openreyestr_search_special_forms: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю спеціальний бланк: «${truncate(q)}»` : 'Шукаю спеціальні бланки';
  },
  openreyestr_search_forensic_methods: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю методику експертизи: «${truncate(q)}»` : 'Шукаю методики експертиз';
  },
  openreyestr_search_legal_acts: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю нормативний акт: «${truncate(q)}»` : 'Шукаю нормативні акти';
  },
  openreyestr_search_administrative_units: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю адміністративну одиницю: «${truncate(q)}»` : 'Шукаю адміністративні одиниці';
  },
  openreyestr_search_streets: (p) => {
    const q = param(p, 'query');
    return q ? `Шукаю вулицю: «${truncate(q)}»` : 'Шукаю вулиці';
  },
};

/**
 * Generate a human-readable Ukrainian description for a tool call.
 * Used in thinking SSE events to show users what the agent is doing.
 */
export function generateThinkingDescription(
  toolName: string,
  params: Record<string, unknown>
): string {
  const generator = TOOL_DESCRIPTIONS[toolName];
  if (generator) {
    return generator(params || {});
  }
  // Fallback: return tool name as-is (frontend has its own TOOL_LABELS fallback)
  return toolName;
}
