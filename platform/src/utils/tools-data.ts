export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface Tool {
  name: string;
  category: string;
  description: string;
  cost?: string;
  params?: ToolParam[];
  example?: { request: string; response: string };
}

export const tools: Tool[] = [
  // ========== Court Search ==========
  { name: 'find_similar_fact_pattern_cases', category: 'Court', description: 'Пошук справ за подібними фактами', cost: '$0.066',
    params: [
      { name: 'procedure_code', type: 'string', required: true, description: 'Код процесу' },
      { name: 'facts_text', type: 'string', required: true, description: 'Опис фактів' },
      { name: 'time_range', type: 'string', required: false, description: 'Часовий діапазон' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },
  { name: 'compare_practice_pro_contra', category: 'Court', description: 'Підбірка практики "за/проти" за тезою', cost: '$0.110',
    params: [
      { name: 'procedure_code', type: 'string', required: true, description: 'Код процесу' },
      { name: 'query', type: 'string', required: true, description: 'Теза для порівняння' },
      { name: 'time_range', type: 'string', required: false, description: 'Часовий діапазон' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },

  // ========== Analysis ==========
  { name: 'get_citation_graph', category: 'Analysis', description: 'Граф цитувань між справами', cost: '$0.022',
    params: [
      { name: 'case_id', type: 'string', required: true, description: 'ID справи' },
      { name: 'depth', type: 'number', required: false, description: 'Глибина графу' },
    ],
  },
  { name: 'check_precedent_status', category: 'Analysis', description: 'Актуальність прецеденту: діючий, скасований, сумнівний', cost: '$0.033',
    params: [
      { name: 'case_id', type: 'string', required: true, description: 'ID справи' },
    ],
  },
  { name: 'count_cases_by_party', category: 'Analysis', description: 'Кількість справ за назвою сторони', cost: '$0.088' },
  { name: 'search_court_case_status', category: 'Analysis', description: 'Пошук статусу судової справи', cost: '$0.006' },
  {
    name: 'search_case_status_by_party', category: 'Analysis',
    description: 'Справи за стороною (ПІБ або назва): стадії розгляду та засідання',
    cost: '$0.080',
    params: [
      { name: 'party', type: 'string', required: true, description: 'Сторона справи: прізвище, ПІБ, прізвище з ініціалами або назва юрособи (щонайменше 3 символи)' },
      { name: 'region', type: 'string', required: false, description: 'Регіон: область (напр. «Львівська») або «м. Київ»' },
      { name: 'court_name', type: 'string', required: false, description: 'Назва суду або її частина' },
      { name: 'case_number', type: 'string', required: false, description: 'Номер справи або його початок (напр. 757/12345/24)' },
      { name: 'proceeding_number', type: 'string', required: false, description: 'Номер провадження або його початок (напр. 2/757/1234/24)' },
      { name: 'date_from', type: 'string', required: false, description: 'Від дати (YYYY-MM-DD): дата реєстрації справи, для засідань — дата засідання' },
      { name: 'date_to', type: 'string', required: false, description: 'До дати (YYYY-MM-DD)' },
      { name: 'include_sessions', type: 'boolean', required: false, description: 'Шукати також в архіві засідань (за замовчуванням true)' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість справ на сторінці (за замовчуванням 20, максимум 100)' },
      { name: 'offset', type: 'number', required: false, description: 'Зсув для пагінації' },
    ],
  },
  {
    name: 'get_case_status_details', category: 'Analysis',
    description: 'Картка справи: усі стадії розгляду, сторони, засідання',
    cost: '$0.022',
    params: [
      { name: 'case_number', type: 'string', required: true, description: 'Номер справи (напр. 533/318/15-ц; суфікс провадження можна не вказувати)' },
      { name: 'court_name', type: 'string', required: false, description: 'Назва суду або її частина (для старих номерів без коду суду)' },
    ],
  },

  // ========== Documents ==========
  {
    name: 'get_court_decision', category: 'Documents',
    description: 'Повний текст рішення з секціями (ФАКТИ, ОБҐРУНТУВАННЯ, РІШЕННЯ)',
    cost: '$0.006',
    params: [
      { name: 'doc_id', type: 'string', required: false, description: 'ID документа' },
      { name: 'case_number', type: 'string', required: false, description: 'Номер справи' },
      { name: 'depth', type: 'string', required: false, description: 'Глибина аналізу (quick/standard/deep)' },
    ],
    example: {
      request: '{"case_number": "756/1234/24"}',
      response: '{"doc_id": "123", "case_number": "756/1234/24", "court": "...", "sections": {"facts": "...", "reasoning": "...", "decision": "..."}}',
    },
  },
  {
    name: 'get_case_documents_chain', category: 'Documents',
    description: 'Всі документи справи через усі інстанції',
    cost: '$0.017',
    params: [
      { name: 'case_number', type: 'string', required: true, description: 'Номер справи' },
      { name: 'include_full_text', type: 'boolean', required: false, description: 'Включити повні тексти (за замовч.: true)' },
      { name: 'max_docs', type: 'number', required: false, description: 'Макс. кількість документів (за замовч.: 50)' },
    ],
  },

  // ========== Legislation ==========
  {
    name: 'get_legislation_articles', category: 'Legislation',
    description: 'Текст однієї або декількох статей (аліас: get_legislation_article)',
    cost: '$0.006',
    params: [
      { name: 'rada_id', type: 'string', required: true, description: 'ID акту в базі ВРУ (напр. "435-15" для ЦК)' },
      { name: 'article_numbers', type: 'string[]', required: true, description: 'Номери статей' },
    ],
    example: {
      request: '{"rada_id": "435-15", "article_numbers": ["625"]}',
      response: '{"articles": [{"article_number": "625", "title": "Відповідальність за порушення грошового зобов\'язання", "text": "..."}]}',
    },
  },
  { name: 'get_legislation_section', category: 'Legislation', description: 'Фрагмент за посиланням («ст. 625 ЦК»)', cost: '$0.006' },
  {
    name: 'search_legislation', category: 'Legislation',
    description: 'Семантичний пошук релевантних статей законодавства',
    cost: '$0.022',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Пошуковий запит' },
      { name: 'rada_id', type: 'string', required: false, description: 'Обмежити пошук конкретним актом' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },
  { name: 'get_legislation_structure', category: 'Legislation', description: 'Структура акту (зміст, розділи, глави)', cost: '$0.006' },
  { name: 'get_legislation_history', category: 'Legislation', description: 'Історія змін законодавчого акту', cost: '$0.011' },

  // ========== RADA (remote proxy, rada_ prefix) ==========
  {
    name: 'rada_search_parliament_bills', category: 'RADA',
    description: 'Пошук законопроєктів ВРУ',
    cost: '$0.007',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Пошуковий запит' },
      { name: 'status', type: 'string', required: false, description: 'Статус: registered | first_reading | adopted | rejected | all' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },
  {
    name: 'rada_get_deputy_info', category: 'RADA',
    description: 'Інформація про депутата (біографія, комітети, фракція)',
    cost: '$0.006',
    params: [
      { name: 'name', type: 'string', required: true, description: 'Ім\'я депутата' },
    ],
    example: {
      request: '{"name": "Стефанчук"}',
      response: '{"name": "Стефанчук Руслан Олексійович", "faction": "Слуга народу", "committees": [...]}',
    },
  },
  { name: 'rada_analyze_voting_record', category: 'RADA', description: 'Аналіз голосувань депутата з AI-інсайтами', cost: '$0.011' },

  // ========== Registry (remote proxy, openreyestr_ prefix) ==========
  {
    name: 'openreyestr_search_entities', category: 'Registry',
    description: 'Пошук суб\'єктів господарювання (ЮО/ФОП/ГО)',
    cost: '$0.022',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Назва або код ЄДРПОУ' },
      { name: 'entityType', type: 'string', required: false, description: 'Тип: UO | FOP | FSU | ALL' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
    example: {
      request: '{"query": "Приватбанк", "entityType": "UO", "limit": 5}',
      response: '{"entities": [{"name": "АТ КБ ПРИВАТБАНК", "edrpou": "14360570", "status": "зареєстровано"}], "total": 3}',
    },
  },
  {
    name: 'openreyestr_get_entity_details', category: 'Registry',
    description: 'Повна інформація: засновники, бенефіціари, керівники',
    cost: '$0.017',
    params: [
      { name: 'record', type: 'string', required: true, description: 'Запис або код ЄДРПОУ' },
      { name: 'entityType', type: 'string', required: false, description: 'Тип суб\'єкта' },
    ],
  },
  { name: 'openreyestr_search_beneficiaries', category: 'Registry', description: 'Пошук бенефіціарних власників компаній', cost: '$0.033' },
  { name: 'openreyestr_get_by_edrpou', category: 'Registry', description: 'Пошук за кодом ЄДРПОУ', cost: '$0.011' },
  { name: 'openreyestr_search_debtors', category: 'Registry', description: 'Пошук боржників', cost: '$0.022' },
  { name: 'openreyestr_search_enforcement_proceedings', category: 'Registry', description: 'Виконавчі провадження', cost: '$0.022' },
  { name: 'openreyestr_search_bankruptcy_cases', category: 'Registry', description: 'Справи про банкрутство', cost: '$0.022' },
  { name: 'openreyestr_search_notaries', category: 'Registry', description: 'Пошук нотаріусів', cost: '$0.006' },
  { name: 'openreyestr_search_arbitration_managers', category: 'Registry', description: 'Пошук арбітражних керуючих', cost: '$0.006' },
  { name: 'openreyestr_search_prozorro', category: 'Registry', description: 'Пошук у системі Prozorro', cost: '$0.022' },
  { name: 'openreyestr_search_single_tax_payers', category: 'Registry', description: 'Пошук платників єдиного податку', cost: '$0.006' },
  { name: 'openreyestr_search_tax_debt', category: 'Registry', description: 'Пошук податкового боргу', cost: '$0.022' },
  { name: 'openreyestr_search_rnbo_sanctions', category: 'Registry', description: 'Пошук санкцій РНБО', cost: '$0.055' },
  { name: 'openreyestr_search_termination_started', category: 'Registry', description: 'Пошук ЮО у стані припинення', cost: '$0.006' },
  { name: 'openreyestr_get_statistics', category: 'Registry', description: 'Статистика державного реєстру', cost: '$0.0001' },

  // ========== Open Data ==========
  { name: 'search_judges', category: 'Open Data', description: 'Реєстр суддів', cost: '$0.006' },
  { name: 'search_edrnpa', category: 'Open Data', description: 'Реєстр нормативно-правових актів', cost: '$0.006' },
  { name: 'search_public_spending', category: 'Open Data', description: 'Пошук державних витрат', cost: '$0.017' },
];

export const categories = [...new Set(tools.map(t => t.category))];

export const categoryColors: Record<string, string> = {
  Court: 'bg-blue-50 text-blue-700',
  Analysis: 'bg-indigo-50 text-indigo-700',
  Documents: 'bg-cyan-50 text-cyan-700',
  Legislation: 'bg-emerald-50 text-emerald-700',
  Procedural: 'bg-green-50 text-green-700',
  Parsing: 'bg-amber-50 text-amber-700',
  Pipeline: 'bg-purple-50 text-purple-700',
  'Due Diligence': 'bg-rose-50 text-rose-700',
  ECHR: 'bg-violet-50 text-violet-700',
  Vault: 'bg-orange-50 text-orange-700',
  RADA: 'bg-yellow-50 text-yellow-700',
  Registry: 'bg-lime-50 text-lime-700',
  'Open Data': 'bg-teal-50 text-teal-700',
};
