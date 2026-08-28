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
  {
    name: 'search_legal_precedents', category: 'Court',
    description: 'Пошук юридичних прецедентів з семантичним аналізом',
    cost: '$0.03–$0.10',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Пошуковий запит' },
      { name: 'domain', type: 'string', required: false, description: 'Галузь права' },
      { name: 'time_range', type: 'string', required: false, description: 'Часовий діапазон (напр. "2023-2024")' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів (за замовчуванням 10)' },
      { name: 'offset', type: 'number', required: false, description: 'Зміщення для пагінації' },
    ],
    example: {
      request: '{"query": "відшкодування моральної шкоди", "limit": 5}',
      response: '{"decisions": [{"doc_id": "123", "case_number": "756/1234/24", "court": "Верховний Суд", "date": "2024-03-15", "summary": "..."}], "total": 42}',
    },
  },
  {
    name: 'search_supreme_court_practice', category: 'Court',
    description: 'Пошук практики Верховного Суду (ВП/КЦС/КГС/КАС/ККС)',
    cost: '$0.05–$0.15',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Пошуковий запит' },
      { name: 'procedure_code', type: 'string', required: false, description: 'Код процесу (civil/criminal/admin/commercial)' },
      { name: 'court_level', type: 'string', required: false, description: 'Рівень суду' },
      { name: 'time_range', type: 'string', required: false, description: 'Часовий діапазон' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },
  { name: 'find_similar_fact_pattern_cases', category: 'Court', description: 'Пошук справ за подібними фактами', cost: '$0.03–$0.10',
    params: [
      { name: 'procedure_code', type: 'string', required: true, description: 'Код процесу' },
      { name: 'facts_text', type: 'string', required: true, description: 'Опис фактів' },
      { name: 'time_range', type: 'string', required: false, description: 'Часовий діапазон' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },
  { name: 'compare_practice_pro_contra', category: 'Court', description: 'Підбірка практики "за/проти" за тезою', cost: '$0.05–$0.15',
    params: [
      { name: 'procedure_code', type: 'string', required: true, description: 'Код процесу' },
      { name: 'query', type: 'string', required: true, description: 'Теза для порівняння' },
      { name: 'time_range', type: 'string', required: false, description: 'Часовий діапазон' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },
  {
    name: 'search_edrsr_decisions', category: 'Court',
    description: 'Пошук рішень у ЄДРСР за фільтрами',
    cost: '$0.005–$0.02',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Пошуковий запит' },
      { name: 'court_name', type: 'string', required: false, description: 'Назва суду' },
      { name: 'judge', type: 'string', required: false, description: 'ПІБ судді' },
      { name: 'date_from', type: 'string', required: false, description: 'Дата від' },
      { name: 'date_to', type: 'string', required: false, description: 'Дата до' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },
  { name: 'search_edrsr_fulltext', category: 'Court', description: 'Повнотекстовий пошук по рішеннях ЄДРСР', cost: '$0.005–$0.02' },
  { name: 'search_edrsr_semantic', category: 'Court', description: 'Семантичний пошук по рішеннях ЄДРСР через ембеддінги', cost: '$0.01–$0.03' },

  // ========== Analysis ==========
  { name: 'analyze_case_pattern', category: 'Analysis', description: 'Аналіз патернів: аргументи, ризики, статистика результатів', cost: '$0.02–$0.08',
    params: [
      { name: 'intent', type: 'string', required: true, description: 'Опис правової ситуації' },
      { name: 'case_ids', type: 'string[]', required: false, description: 'ID справ для аналізу' },
    ],
  },
  { name: 'get_citation_graph', category: 'Analysis', description: 'Граф цитувань між справами', cost: '$0.005–$0.02',
    params: [
      { name: 'case_id', type: 'string', required: true, description: 'ID справи' },
      { name: 'depth', type: 'number', required: false, description: 'Глибина графу' },
    ],
  },
  { name: 'check_precedent_status', category: 'Analysis', description: 'Актуальність прецеденту: діючий, скасований, сумнівний', cost: '$0.005–$0.015',
    params: [
      { name: 'case_id', type: 'string', required: true, description: 'ID справи' },
    ],
  },
  { name: 'count_cases_by_party', category: 'Analysis', description: 'Кількість справ за назвою сторони', cost: '$0.002–$0.005' },
  { name: 'search_court_case_status', category: 'Analysis', description: 'Пошук статусу судової справи', cost: '$0.002–$0.005' },

  // ========== Documents ==========
  {
    name: 'get_court_decision', category: 'Documents',
    description: 'Повний текст рішення з секціями (ФАКТИ, ОБҐРУНТУВАННЯ, РІШЕННЯ)',
    cost: '$0.01–$0.04',
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
    cost: '$0.005–$0.02',
    params: [
      { name: 'case_number', type: 'string', required: true, description: 'Номер справи' },
      { name: 'include_full_text', type: 'boolean', required: false, description: 'Включити повні тексти (за замовч.: true)' },
      { name: 'max_docs', type: 'number', required: false, description: 'Макс. кількість документів (за замовч.: 50)' },
    ],
  },
  { name: 'get_edrsr_decision_fulltext', category: 'Documents', description: 'Повний текст рішення з ЄДРСР', cost: '$0.005–$0.01' },
  { name: 'extract_document_sections', category: 'Documents', description: 'Структуровані секції з тексту документа', cost: '$0.005–$0.05' },
  { name: 'semantic_search', category: 'Documents', description: 'Семантичний пошук за ембеддінгами у vault', cost: '$0.01–$0.03' },

  // ========== Legislation ==========
  {
    name: 'get_legislation_articles', category: 'Legislation',
    description: 'Текст однієї або декількох статей (аліас: get_legislation_article)',
    cost: 'Мінімальна',
    params: [
      { name: 'rada_id', type: 'string', required: true, description: 'ID акту в базі ВРУ (напр. "435-15" для ЦК)' },
      { name: 'article_numbers', type: 'string[]', required: true, description: 'Номери статей' },
    ],
    example: {
      request: '{"rada_id": "435-15", "article_numbers": ["625"]}',
      response: '{"articles": [{"article_number": "625", "title": "Відповідальність за порушення грошового зобов\'язання", "text": "..."}]}',
    },
  },
  { name: 'get_legislation_section', category: 'Legislation', description: 'Фрагмент за посиланням («ст. 625 ЦК»)', cost: 'Мінімальна' },
  {
    name: 'search_legislation', category: 'Legislation',
    description: 'Семантичний пошук релевантних статей законодавства',
    cost: '$0.01–$0.03',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Пошуковий запит' },
      { name: 'rada_id', type: 'string', required: false, description: 'Обмежити пошук конкретним актом' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },
  { name: 'get_legislation_structure', category: 'Legislation', description: 'Структура акту (зміст, розділи, глави)', cost: 'Мінімальна' },
  { name: 'get_legislation_history', category: 'Legislation', description: 'Історія змін законодавчого акту', cost: 'Мінімальна' },
  { name: 'search_procedural_norms', category: 'Legislation', description: 'Пошук процесуальних норм (ЦПК/ГПК/КАС)', cost: '$0.0005–$0.003' },
  { name: 'find_relevant_law_articles', category: 'Legislation', description: 'Статті, що часто застосовуються у справах за темою (аліас search_legislation)', cost: '$0.001–$0.002' },
  { name: 'search_legal_acts', category: 'Legislation', description: 'Пошук нормативних актів (ЄДРНПА)', cost: '$0.001–$0.005' },

  // ========== Procedural ==========
  { name: 'calculate_procedural_deadlines', category: 'Procedural', description: 'Калькулятор процесуальних строків', cost: '$0.002–$0.008',
    params: [
      { name: 'procedure_code', type: 'string', required: true, description: 'Код процесу' },
      { name: 'event_type', type: 'string', required: true, description: 'Тип події' },
      { name: 'event_date', type: 'string', required: true, description: 'Дата події' },
    ],
  },
  { name: 'build_procedural_checklist', category: 'Procedural', description: 'Процесуальний чекліст з посиланнями на норми', cost: '$0.01–$0.03' },
  { name: 'calculate_monetary_claims', category: 'Procedural', description: 'Розрахунки грошових вимог (3% річних)', cost: 'Мінімальна' },
  { name: 'build_legal_decision', category: 'Procedural', description: 'Побудова юридичного рішення на основі аналізу', cost: '$0.05–$0.15' },

  // ========== Parsing ==========
  {
    name: 'parse_document', category: 'Parsing',
    description: 'Парсинг PDF/DOCX/HTML з OCR',
    cost: '$0.01–$0.10',
    params: [
      { name: 'fileBase64', type: 'string', required: true, description: 'Файл в base64' },
      { name: 'mimeType', type: 'string', required: true, description: 'MIME тип (application/pdf, application/vnd.openxmlformats...)' },
      { name: 'filename', type: 'string', required: true, description: 'Назва файлу' },
    ],
  },
  { name: 'extract_key_clauses', category: 'Parsing', description: 'Ключові положення контракту', cost: '$0.03–$0.10' },
  {
    name: 'summarize_document', category: 'Parsing',
    description: 'Резюме документа (quick/standard/deep)',
    cost: '$0.02–$0.08',
    params: [
      { name: 'documentText', type: 'string', required: true, description: 'Текст документа' },
      { name: 'detailLevel', type: 'string', required: false, description: 'Рівень деталізації: quick | standard | deep' },
    ],
  },
  { name: 'compare_documents', category: 'Parsing', description: 'Семантичне порівняння двох версій', cost: '$0.03–$0.12' },
  { name: 'batch_process_documents', category: 'Parsing', description: 'Пакетна обробка документів', cost: 'Залежить від кількості' },

  // ========== Pipeline ==========
  { name: 'classify_intent', category: 'Pipeline', description: 'Класифікація запиту: service/task/depth (entry-point для роутингу)', cost: 'Мінімальна' },
  { name: 'retrieve_legal_sources', category: 'Pipeline', description: 'RAG retrieval: повертає сирі джерела без аналізу', cost: 'Залежить від обсягу' },
  { name: 'validate_response', category: 'Pipeline', description: 'Trust layer: перевірка відповіді на галюцинації', cost: '$0.01–$0.03' },
  { name: 'format_answer_pack', category: 'Pipeline', description: 'Упаковщик результату в структуру norm/position/conclusion/risks', cost: 'Мінімальна' },

  // ========== Due Diligence ==========
  { name: 'bulk_review_runner', category: 'Due Diligence', description: 'Масова перевірка контрагентів', cost: '$0.05–$0.20' },
  { name: 'risk_scoring', category: 'Due Diligence', description: 'Скорінг ризиків по суб\'єкту', cost: '$0.02–$0.08' },
  { name: 'generate_dd_report', category: 'Due Diligence', description: 'Генерація звіту Due Diligence', cost: '$0.10–$0.30' },

  // ========== ECHR ==========
  { name: 'search_echr_practice', category: 'ECHR', description: 'Пошук практики Європейського суду з прав людини', cost: '$0.01–$0.05' },
  { name: 'get_echr_document', category: 'ECHR', description: 'Текст рішення ЄСПЛ', cost: '$0.005–$0.02' },

  // ========== Vault ==========
  { name: 'store_document', category: 'Vault', description: 'Збереження документа в vault', cost: 'Мінімальна' },
  { name: 'get_document', category: 'Vault', description: 'Отримання документа з vault за ID', cost: 'Мінімальна' },
  { name: 'list_documents', category: 'Vault', description: 'Список документів з фільтрацією', cost: 'Мінімальна' },
  { name: 'delete_document', category: 'Vault', description: 'Видалення документа з vault', cost: 'Мінімальна' },
  { name: 'update_document', category: 'Vault', description: 'Оновлення документа у vault', cost: 'Мінімальна' },

  // ========== RADA (remote proxy, rada_ prefix) ==========
  {
    name: 'rada_search_parliament_bills', category: 'RADA',
    description: 'Пошук законопроєктів ВРУ',
    cost: '$0.001–$0.005',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Пошуковий запит' },
      { name: 'status', type: 'string', required: false, description: 'Статус: registered | first_reading | adopted | rejected | all' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів' },
    ],
  },
  {
    name: 'rada_get_deputy_info', category: 'RADA',
    description: 'Інформація про депутата (біографія, комітети, фракція)',
    cost: '$0.0005–$0.001',
    params: [
      { name: 'name', type: 'string', required: true, description: 'Ім\'я депутата' },
    ],
    example: {
      request: '{"name": "Стефанчук"}',
      response: '{"name": "Стефанчук Руслан Олексійович", "faction": "Слуга народу", "committees": [...]}',
    },
  },
  { name: 'rada_search_legislation_text', category: 'RADA', description: 'Пошук у текстах законів з посиланнями на судові рішення', cost: '$0.0005–$0.002' },
  { name: 'rada_analyze_voting_record', category: 'RADA', description: 'Аналіз голосувань депутата з AI-інсайтами', cost: '$0.002–$0.010' },

  // ========== Registry (remote proxy, openreyestr_ prefix) ==========
  {
    name: 'openreyestr_search_entities', category: 'Registry',
    description: 'Пошук суб\'єктів господарювання (ЮО/ФОП/ГО)',
    cost: '$0.0001–$0.0005',
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
    cost: '$0.0001–$0.0003',
    params: [
      { name: 'record', type: 'string', required: true, description: 'Запис або код ЄДРПОУ' },
      { name: 'entityType', type: 'string', required: false, description: 'Тип суб\'єкта' },
    ],
  },
  { name: 'openreyestr_search_beneficiaries', category: 'Registry', description: 'Пошук бенефіціарних власників компаній', cost: '$0.0002–$0.0005' },
  { name: 'openreyestr_get_by_edrpou', category: 'Registry', description: 'Пошук за кодом ЄДРПОУ', cost: '$0.0001' },
  { name: 'openreyestr_search_debtors', category: 'Registry', description: 'Пошук боржників', cost: '$0.0001–$0.0005' },
  { name: 'openreyestr_search_enforcement_proceedings', category: 'Registry', description: 'Виконавчі провадження', cost: '$0.0001–$0.0005' },
  { name: 'openreyestr_search_bankruptcy_cases', category: 'Registry', description: 'Справи про банкрутство', cost: '$0.0001–$0.0005' },
  { name: 'openreyestr_search_notaries', category: 'Registry', description: 'Пошук нотаріусів', cost: '$0.0001' },
  { name: 'openreyestr_search_court_experts', category: 'Registry', description: 'Пошук судових експертів', cost: '$0.0001' },
  { name: 'openreyestr_search_arbitration_managers', category: 'Registry', description: 'Пошук арбітражних керуючих', cost: '$0.0001' },
  { name: 'openreyestr_search_prozorro', category: 'Registry', description: 'Пошук у системі Prozorro', cost: '$0.001–$0.005' },
  { name: 'openreyestr_search_vat_payers', category: 'Registry', description: 'Пошук платників ПДВ', cost: '$0.001' },
  { name: 'openreyestr_search_single_tax_payers', category: 'Registry', description: 'Пошук платників єдиного податку', cost: '$0.001' },
  { name: 'openreyestr_search_tax_debt', category: 'Registry', description: 'Пошук податкового боргу', cost: '$0.001' },
  { name: 'openreyestr_search_rnbo_sanctions', category: 'Registry', description: 'Пошук санкцій РНБО', cost: '$0.0001' },
  { name: 'openreyestr_search_termination_started', category: 'Registry', description: 'Пошук ЮО у стані припинення', cost: '$0.0001' },
  { name: 'openreyestr_get_statistics', category: 'Registry', description: 'Статистика державного реєстру', cost: '$0.0001' },

  // ========== Open Data ==========
  { name: 'search_sanctions', category: 'Open Data', description: 'Пошук у реєстрі санкцій', cost: '$0.001' },
  { name: 'search_corruption_register', category: 'Open Data', description: 'Пошук у реєстрі корупціонерів', cost: '$0.001' },
  { name: 'search_lawyers', category: 'Open Data', description: 'Реєстр адвокатів', cost: '$0.001' },
  { name: 'search_judges', category: 'Open Data', description: 'Реєстр суддів', cost: '$0.0003' },
  { name: 'search_wanted_persons', category: 'Open Data', description: 'Реєстр розшукуваних осіб', cost: '$0.0003' },
  { name: 'search_missing_persons', category: 'Open Data', description: 'Реєстр зниклих безвісти', cost: '$0.0003' },
  { name: 'search_trademarks', category: 'Open Data', description: 'Пошук торгових марок', cost: '$0.001' },
  { name: 'search_patents', category: 'Open Data', description: 'Пошук патентів', cost: '$0.001' },
  { name: 'search_vrp_decisions', category: 'Open Data', description: 'Рішення Вищої ради правосуддя', cost: '$0.0003' },
  { name: 'search_edrnpa', category: 'Open Data', description: 'Реєстр нормативно-правових актів', cost: '$0.001' },
  { name: 'search_public_spending', category: 'Open Data', description: 'Пошук державних витрат', cost: '$0.001–$0.005' },
  { name: 'search_nbu_banks', category: 'Open Data', description: 'Реєстр банків НБУ', cost: '$0.001' },
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
