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

  {
    name: 'search_court_decisions', category: 'Court',
    description: 'Пошук у ЄДРСР (82M+ рішень з 2006): режими structured, exact, fulltext, hybrid, semantic; фільтри за судом, суддею, видом судочинства, датою, стороною',
    cost: '$0.022',
    params: [
      { name: 'mode', type: 'string', required: true, description: 'structured | exact | fulltext | hybrid | semantic' },
      { name: 'query', type: 'string', required: false, description: 'Запит (обов’язковий для exact/fulltext/hybrid/semantic)' },
      { name: 'party_name', type: 'string', required: false, description: 'Назва сторони без ОПФ (fulltext/hybrid)' },
      { name: 'party_role', type: 'string', required: false, description: 'plaintiff | defendant | any' },
      { name: 'cause_num', type: 'string', required: false, description: 'Номер справи' },
      { name: 'judge', type: 'string', required: false, description: 'ПІБ судді' },
      { name: 'court_code', type: 'number', required: false, description: 'Код суду' },
      { name: 'court_name', type: 'string', required: false, description: 'Назва суду' },
      { name: 'justice_kind', type: 'number', required: false, description: '1 цивільне, 2 кримінальне, 3 господарське, 4 адміністративне, 5 адмінправопорушення' },
      { name: 'judgment_code', type: 'number', required: false, description: 'Форма рішення: 1 вирок, 2 постанова, 3 рішення, 5 ухвала' },
      { name: 'category_code', type: 'number', required: false, description: 'Код категорії справи' },
      { name: 'instance_code', type: 'number', required: false, description: '1 касаційна, 2 апеляційна, 3 перша' },
      { name: 'court_level', type: 'string', required: false, description: 'all | SC | GrandChamber' },
      { name: 'date_from', type: 'string', required: false, description: 'Дата ухвалення від (YYYY-MM-DD)' },
      { name: 'date_to', type: 'string', required: false, description: 'Дата ухвалення до (YYYY-MM-DD)' },
      { name: 'military_preset', type: 'string', required: false, description: 'Пресет військових справ (structured)' },
      { name: 'kupap_preset', type: 'string', required: false, description: 'Пресет справ КУпАП' },
      { name: 'include_fulltext', type: 'boolean', required: false, description: 'Повний текст (лише structured)' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість результатів (до 100)' },
      { name: 'offset', type: 'number', required: false, description: 'Зсув для пагінації' },
      { name: 'oversample', type: 'number', required: false, description: 'Множник кандидатів для hybrid (до 5)' },
      { name: 'rrf_k', type: 'number', required: false, description: 'Параметр RRF для hybrid (60)' },
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
    name: 'edrsr_get_decision_dispositive', category: 'Documents',
    description: 'Лише резолютивна частина рішення (ВИРІШИВ / УХВАЛИВ / ПОСТАНОВИВ / ВИРОК): 2–8 КБ замість повного тексту',
    cost: '$0.006',
    params: [
      { name: 'doc_id', type: 'string', required: true, description: 'ID документа в ЄДРСР' },
    ],
  },
  {
    name: 'get_decision_cited_norms', category: 'Documents',
    description: 'Норми законодавства, на які посилається рішення (rada_id, номер статті, кількість згадок)',
    cost: '$0.006',
    params: [
      { name: 'doc_id', type: 'string', required: true, description: 'ID документа в ЄДРСР' },
    ],
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

  {
    name: 'load_full_texts', category: 'Documents',
    description: 'Пакетне завантаження повних текстів рішень за масивом doc_id; з return_texts=true — мотивувальна й резолютивна частини кожного',
    cost: '$0.022',
    params: [
      { name: 'doc_ids', type: 'array', required: true, description: 'Масив doc_id' },
      { name: 'max_docs', type: 'number', required: false, description: 'Макс. документів (1000)' },
      { name: 'batch_size', type: 'number', required: false, description: 'Розмір батчу (100)' },
      { name: 'return_texts', type: 'boolean', required: false, description: 'Повернути ключові секції кожного документа' },
      { name: 'snippet_chars', type: 'number', required: false, description: 'Макс. символів на документ (4000)' },
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

  {
    name: 'list_legislation_editions', category: 'Legislation',
    description: 'Перелік історичних редакцій акта з датами набрання чинності (для as_of_date)',
    cost: '$0.011',
    params: [
      { name: 'rada_id', type: 'string', required: true, description: 'ID акта, напр. 435-15 (ЦК)' },
    ],
  },
  {
    name: 'search_npa', category: 'Legislation',
    description: 'Повний корпус НПА України (293K актів, 439K редакцій): повнотекстовий пошук або пошук за назвою',
    cost: '$0.011',
    params: [
      { name: 'query', type: 'string', required: false, description: 'Пошук по тексту актів' },
      { name: 'title', type: 'string', required: false, description: 'Нечіткий пошук за назвою' },
      { name: 'status', type: 'string', required: false, description: 'Стан акта (типово «чинний»)' },
      { name: 'doc_type', type: 'string', required: false, description: 'Закон, Кодекс, Постанова, Указ, Наказ…' },
      { name: 'as_of_date', type: 'string', required: false, description: 'Редакція на дату (YYYY-MM-DD)' },
      { name: 'limit', type: 'number', required: false, description: 'Макс. результатів (до 50)' },
    ],
  },
  {
    name: 'get_npa_act', category: 'Legislation',
    description: 'Картка акта НПА за nreg: метадані, редакції, зміст, стаття або повний текст; редакція на дату',
    cost: '$0.006',
    params: [
      { name: 'nreg', type: 'string', required: true, description: 'Реєстраційний номер, напр. 2755-17' },
      { name: 'mode', type: 'string', required: false, description: 'card | editions | toc | article | text' },
      { name: 'article_number', type: 'string', required: false, description: 'Номер статті для mode=article' },
      { name: 'as_of_date', type: 'string', required: false, description: 'Редакція, чинна на дату' },
      { name: 'offset', type: 'number', required: false, description: 'Зсув у символах для mode=text' },
      { name: 'limit', type: 'number', required: false, description: 'Ліміт редакцій або статей (до 200)' },
    ],
  },
  {
    name: 'search_amcu_practice', category: 'Legislation',
    description: 'Семантичний пошук по рішеннях АМКУ: 2 600 рішень, 174K фрагментів',
    cost: '$0.017',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Опис ситуації або правового питання' },
      { name: 'date_from', type: 'string', required: false, description: 'Не раніше дати' },
      { name: 'date_to', type: 'string', required: false, description: 'Не пізніше дати' },
      { name: 'limit', type: 'number', required: false, description: 'Макс. рішень (до 25)' },
    ],
  },

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

  {
    name: 'rada_search_bill_documents', category: 'RADA',
    description: 'Супровідні документи законопроєктів: висновки ГНЕУ, комітетів, зауваження ГЮУ',
    cost: '$0.009',
    params: [
      { name: 'query', type: 'string', required: false, description: 'Пошук по тексту вердикту або назві законопроєкту' },
      { name: 'bill_number', type: 'string', required: false, description: 'Номер законопроєкту' },
      { name: 'doc_kind', type: 'string', required: false, description: 'gneu | committee | legal | all' },
      { name: 'convocation', type: 'number', required: false, description: 'Скликання' },
      { name: 'initiator', type: 'string', required: false, description: 'Ініціатор' },
      { name: 'date_from', type: 'string', required: false, description: 'Дата реєстрації від' },
      { name: 'date_to', type: 'string', required: false, description: 'Дата реєстрації до' },
      { name: 'limit', type: 'number', required: false, description: 'Макс. результатів (до 100)' },
    ],
  },

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

  {
    name: 'get_company_dossier', category: 'Due Diligence',
    description: 'Досьє юрособи за ЄДРПОУ в одному виклику: ЄДР, санкції, борги, ProZorro, ЄДЕССБ, суди; джерело й дата на кожен розділ',
    cost: '$0.176',
    params: [
      { name: 'edrpou', type: 'string', required: true, description: 'Код ЄДРПОУ (8 цифр)' },
    ],
  },
  {
    name: 'get_financial_statements', category: 'Due Diligence',
    description: 'Фінансова звітність за ЄДРПОУ: баланс (Ф1) і фінрезультати (Ф2) за роками, з 2020',
    cost: '$0.044',
    params: [
      { name: 'edrpou', type: 'string', required: true, description: 'Код ЄДРПОУ' },
      { name: 'year_from', type: 'number', required: false, description: 'Рік від' },
      { name: 'year_to', type: 'number', required: false, description: 'Рік до' },
      { name: 'include_interim', type: 'boolean', required: false, description: 'Додати квартальну звітність' },
    ],
  },
  {
    name: 'openreyestr_company_as_of', category: 'Registry',
    description: 'Юрособа станом на дату за знімками ЄДР (2016, 2018, 2021, щотижня з 2026)',
    cost: '$0.044',
    params: [
      { name: 'edrpou', type: 'string', required: true, description: 'Код ЄДРПОУ' },
      { name: 'date', type: 'string', required: true, description: 'Дата (YYYY-MM-DD)' },
    ],
  },
  {
    name: 'openreyestr_company_history', category: 'Registry',
    description: 'Історія змін юрособи за знімками ЄДР: назва, стан, адреса, КВЕД, керівники, засновники, бенефіціари',
    cost: '$0.044',
    params: [
      { name: 'edrpou', type: 'string', required: true, description: 'Код ЄДРПОУ' },
    ],
  },
  {
    name: 'openreyestr_search_founders', category: 'Registry',
    description: 'Зворотний пошук за засновниками: усі юрособи, де особа чи компанія є засновником',
    cost: '$0.033',
    params: [
      { name: 'query', type: 'string', required: false, description: 'Назва або ПІБ засновника' },
      { name: 'country', type: 'string', required: false, description: 'Країна українською, напр. «Кіпр»' },
      { name: 'foreign_only', type: 'boolean', required: false, description: 'Лише іноземні засновники' },
      { name: 'entity_type', type: 'string', required: false, description: 'UO | FSU' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
      { name: 'offset', type: 'number', required: false, description: 'Зсув' },
    ],
  },
  {
    name: 'openreyestr_search_founders_history', category: 'Registry',
    description: 'Засновники з урахуванням минулих знімків ЄДР, зокрема колишні; пошук латиницею',
    cost: '$0.055',
    params: [
      { name: 'query', type: 'string', required: false, description: 'Назва або ПІБ будь-якою мовою' },
      { name: 'code', type: 'string', required: false, description: 'ЄДРПОУ засновника-юрособи' },
      { name: 'country', type: 'string', required: false, description: 'ISO-код або назва країни' },
      { name: 'current_only', type: 'boolean', required: false, description: 'Лише записи з найновішого знімка' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 200)' },
    ],
  },
  {
    name: 'openreyestr_search_beneficiaries_history', category: 'Registry',
    description: 'Кінцеві бенефіціари з урахуванням минулих знімків ЄДР; пошук латиницею',
    cost: '$0.055',
    params: [
      { name: 'query', type: 'string', required: false, description: 'ПІБ будь-якою мовою' },
      { name: 'country', type: 'string', required: false, description: 'Країна громадянства' },
      { name: 'current_only', type: 'boolean', required: false, description: 'Лише записи з найновішого знімка' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 200)' },
    ],
  },
  {
    name: 'openreyestr_search_nazk_declarations', category: 'Registry',
    description: 'Декларації НАЗК: за ПІБ, місцем роботи, роком, типом, регіоном, доходом',
    cost: '$0.044',
    params: [
      { name: 'declarant_name', type: 'string', required: false, description: 'Ім’я декларанта' },
      { name: 'declarant_workplace', type: 'string', required: false, description: 'Місце роботи' },
      { name: 'declaration_year', type: 'number', required: false, description: 'Рік' },
      { name: 'declaration_type', type: 'number', required: false, description: '1 щорічна, 2 перед звільненням, 3 після, 4 кандидата' },
      { name: 'declarant_region', type: 'string', required: false, description: 'Регіон' },
      { name: 'min_income', type: 'number', required: false, description: 'Мінімальний дохід, грн' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
      { name: 'offset', type: 'number', required: false, description: 'Зсув' },
    ],
  },
  {
    name: 'openreyestr_search_arma_seized_assets', category: 'Registry',
    description: 'Реєстр АРМА: арештовані активи у кримінальних провадженнях',
    cost: '$0.011',
    params: [
      { name: 'case_number', type: 'string', required: false, description: 'Номер судової справи' },
      { name: 'criminal_proceeding_number', type: 'string', required: false, description: 'Номер ЄРДР (17 цифр)' },
      { name: 'asset_type', type: 'string', required: false, description: 'Тип активу' },
      { name: 'description', type: 'string', required: false, description: 'Слова з опису активу' },
      { name: 'court_name', type: 'string', required: false, description: 'Суд' },
      { name: 'region', type: 'string', required: false, description: 'Регіон суду' },
      { name: 'status', type: 'string', required: false, description: 'arrested | transferred | returned | sold | confiscated' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
      { name: 'offset', type: 'number', required: false, description: 'Зсув' },
    ],
  },
  {
    name: 'openreyestr_search_esv_debt', category: 'Registry',
    description: 'Реєстр боргу зі сплати ЄСВ',
    cost: '$0.011',
    params: [
      { name: 'query', type: 'string', required: false, description: 'Назва компанії або ФОП' },
      { name: 'tin', type: 'string', required: false, description: 'ІПН або ЄДРПОУ' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
      { name: 'offset', type: 'number', required: false, description: 'Зсув' },
    ],
  },
  {
    name: 'openreyestr_search_special_forms', category: 'Registry',
    description: 'Спеціальні бланки нотаріальних документів',
    cost: '$0.006',
    params: [
      { name: 'series', type: 'string', required: false, description: 'Серія' },
      { name: 'form_number', type: 'string', required: false, description: 'Номер' },
      { name: 'recipient', type: 'string', required: false, description: 'Отримувач' },
      { name: 'status', type: 'string', required: false, description: 'Статус бланка' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
      { name: 'offset', type: 'number', required: false, description: 'Зсув' },
    ],
  },

  // ========== Open Data ==========
  { name: 'search_judges', category: 'Open Data', description: 'Реєстр суддів', cost: '$0.006' },
  { name: 'search_edrnpa', category: 'Open Data', description: 'Реєстр нормативно-правових актів', cost: '$0.006' },
  { name: 'search_public_spending', category: 'Open Data', description: 'Пошук державних витрат', cost: '$0.017' },
  {
    name: 'search_registry', category: 'Open Data',
    description: 'Єдиний вхід у 30 реєстрів відкритих даних: санкції, адвокати, особи, які вчинили корупційні правопорушення, банки НБУ, ТМ, патенти, фінзвітність та ін.',
    cost: '$0.011',
    params: [
      { name: 'registry', type: 'string', required: true, description: 'Назва реєстру' },
      { name: 'filters', type: 'object', required: false, description: 'Фільтри JSON, напр. {"name": "Іваненко"}; поля залежать від реєстру' },
      { name: 'aggregate', type: 'object', required: false, description: 'Агрегація: group_by, count_distinct, min_count' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
    ],
  },
  {
    name: 'search_court_hearing_schedule', category: 'Open Data',
    description: 'Розклад судових засідань і архів з 2020 (30M+ записів): дата, час, зал, учасники',
    cost: '$0.011',
    params: [
      { name: 'query', type: 'string', required: false, description: 'Номер справи або учасник' },
      { name: 'case_number', type: 'string', required: false, description: 'Номер справи' },
      { name: 'participant', type: 'string', required: false, description: 'Учасник' },
      { name: 'judge', type: 'string', required: false, description: 'Суддя' },
      { name: 'court_name', type: 'string', required: false, description: 'Суд' },
      { name: 'date_from', type: 'string', required: false, description: 'Дата від' },
      { name: 'date_to', type: 'string', required: false, description: 'Дата до' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 1000)' },
    ],
  },
  {
    name: 'search_invalid_passports', category: 'Open Data',
    description: 'Недійсні паспорти МВС: 2.9M внутрішніх і 195K закордонних',
    cost: '$0.011',
    params: [
      { name: 'd_series', type: 'string', required: false, description: 'Серія' },
      { name: 'd_number', type: 'string', required: false, description: 'Номер' },
      { name: 'd_status', type: 'string', required: false, description: 'Статус' },
      { name: 'ovd', type: 'string', required: false, description: 'Орган' },
      { name: 'include_foreign', type: 'boolean', required: false, description: 'Включити закордонні' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
    ],
  },
  {
    name: 'search_vkks', category: 'Open Data',
    description: 'Дані ВККС: досьє суддів, оцінювання, декларації, вакансії, ефективність',
    cost: '$0.006',
    params: [
      { name: 'category', type: 'string', required: true, description: 'judges | evaluations | declarations | vacancies | efficiency' },
      { name: 'judge_name', type: 'string', required: false, description: 'ПІБ судді' },
      { name: 'court_name', type: 'string', required: false, description: 'Суд' },
      { name: 'year', type: 'number', required: false, description: 'Рік' },
      { name: 'region', type: 'string', required: false, description: 'Регіон' },
      { name: 'court_level', type: 'string', required: false, description: 'Рівень суду' },
      { name: 'dossier_number', type: 'string', required: false, description: 'Номер досьє' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
    ],
  },
  {
    name: 'search_vrp_judges_discipline', category: 'Open Data',
    description: 'Дисциплінарні дані ВРП: звільнені, відсторонені судді, повідомлення про втручання',
    cost: '$0.006',
    params: [
      { name: 'judge_name', type: 'string', required: false, description: 'ПІБ судді' },
      { name: 'court_name', type: 'string', required: false, description: 'Суд' },
      { name: 'type', type: 'string', required: false, description: 'dismissed | suspended | interference' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
    ],
  },

  // ========== Intellectual Property ==========
  {
    name: 'search_ip_objects', category: 'IP',
    description: 'Реєстр об’єктів ІВ (НІПО/УІПВ): торговельні марки, винаходи, корисні моделі, промзразки',
    cost: '$0.022',
    params: [
      { name: 'query', type: 'string', required: false, description: 'Назва або позначення' },
      { name: 'obj_type', type: 'number', required: false, description: '1 винаходи, 2 корисні моделі, 4 ТМ, 6 промзразки' },
      { name: 'obj_state', type: 'number', required: false, description: '1 заявка, 2 зареєстровано' },
      { name: 'classes', type: 'array', required: false, description: 'Коди МКТП/МПК/Локарно' },
      { name: 'owner', type: 'string', required: false, description: 'Власник або заявник' },
      { name: 'owner_edrpou', type: 'string', required: false, description: 'ЄДРПОУ власника' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
    ],
  },
  {
    name: 'get_ip_object', category: 'IP',
    description: 'Картка об’єкта ІВ за номером заявки або свідоцтва/патенту',
    cost: '$0.011',
    params: [
      { name: 'app_number', type: 'string', required: false, description: 'Номер заявки' },
      { name: 'registration_number', type: 'string', required: false, description: 'Номер свідоцтва/патенту' },
      { name: 'obj_type', type: 'number', required: false, description: 'Тип об’єкта' },
    ],
  },
  {
    name: 'find_similar_trademarks', category: 'IP',
    description: 'Тотожні та схожі ТМ у тих самих класах МКТП — перевірка на «зіткнення»',
    cost: '$0.066',
    params: [
      { name: 'app_number', type: 'string', required: false, description: 'Номер заявки еталонної марки' },
      { name: 'query', type: 'string', required: false, description: 'Позначення (разом з classes)' },
      { name: 'classes', type: 'array', required: false, description: 'Класи МКТП' },
      { name: 'obj_state', type: 'number', required: false, description: '1 лише заявки, 2 лише зареєстровані' },
      { name: 'min_similarity', type: 'number', required: false, description: 'Поріг схожості 0..1' },
      { name: 'limit', type: 'number', required: false, description: 'Кількість (до 100)' },
    ],
  },
  {
    name: 'get_trademark_dossier', category: 'IP',
    description: 'Повне досьє ТМ: реєстрові дані, хронологія, правоволодіння, схожі позначення, судова практика, ст. 6 на дату заявки',
    cost: '$0.176',
    params: [
      { name: 'number', type: 'string', required: true, description: 'Номер свідоцтва або заявки' },
    ],
  },
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
  IP: 'bg-pink-50 text-pink-700',
};
