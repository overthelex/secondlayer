-- Migration 053: Add tool_pricing table for per-tool cost management
-- Stores base cost per call and markup % for each MCP tool

CREATE TABLE IF NOT EXISTS tool_pricing (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name     VARCHAR(100) UNIQUE NOT NULL,
  service       VARCHAR(50)  NOT NULL DEFAULT 'backend', -- 'backend', 'rada', 'openreyestr'
  display_name  VARCHAR(200) NOT NULL,
  base_cost_usd DECIMAL(14, 8) NOT NULL DEFAULT 0,
  markup_percent DECIMAL(8, 4) NOT NULL DEFAULT 0,       -- % надбавка до ціни для клієнта
  is_active     BOOLEAN NOT NULL DEFAULT true,
  notes         TEXT,
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_by    VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_tool_pricing_service   ON tool_pricing(service);
CREATE INDEX IF NOT EXISTS idx_tool_pricing_tool_name ON tool_pricing(tool_name);

-- ============================================================
-- Seed: Backend tools (mcp_backend, 36 основних інструментів)
-- ============================================================
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, notes) VALUES

-- Pipeline entry points
('classify_intent',              'backend', 'Класифікація запиту',                     0.00200000, 'Роутинг pipeline, мінімальна вартість'),
('retrieve_legal_sources',       'backend', 'RAG: отримання правових джерел',           0.01000000, 'Залежить від обсягу документів'),
('analyze_legal_patterns',       'backend', 'Аналіз юридичних паттернів',               0.05000000, 'Success arguments + risk factors'),
('validate_response',            'backend', 'Валідація відповіді (anti-hallucination)',  0.02000000, 'Trust layer, перевірка джерел'),

-- Пошук судових справ
('search_legal_precedents',      'backend', 'Пошук юридичних прецедентів',              0.06500000, 'OpenAI embeddings + ZakonOnline API'),
('search_supreme_court_practice','backend', 'Практика Верховного Суду',                 0.10000000, 'ВП/КЦС/КГС/КАС/ККС'),
('find_similar_fact_pattern_cases','backend','Пошук за схожими фактами',                0.06500000, 'Екстракція термінів + пошук'),
('compare_practice_pro_contra',  'backend', 'Підбірка практики «за/проти»',             0.10000000, 'Дві лінії практики'),

-- Аналіз судової практики
('analyze_case_pattern',         'backend', 'Аналіз паттернів судової практики',        0.05000000, 'Аргументи, ризики, статистика'),
('get_similar_reasoning',        'backend', 'Схожі судові обґрунтування',               0.02000000, 'OpenAI embeddings + Qdrant'),
('get_citation_graph',           'backend', 'Граф цитувань між справами',               0.01000000, 'Прямі та зворотні зв''язки'),
('check_precedent_status',       'backend', 'Перевірка статусу прецеденту',             0.01000000, 'Чинний/скасований/сумнівний'),

-- Робота з документами
('get_court_decision',           'backend', 'Завантаження рішення суду',                0.02500000, 'Секції: ФАКТИ, ОБҐРУНТУВАННЯ, РІШЕННЯ'),
('get_case_text',                'backend', 'Отримання тексту судового рішення',        0.02500000, 'Аліас для get_court_decision'),
('get_case_documents_chain',     'backend', 'Всі документи справи по всіх інстанціях',  0.01000000, 'Перша → Апеляція → Касація → ВП ВС'),
('semantic_search',              'backend', 'Семантичний пошук у vault',                0.02000000, 'Qdrant векторна БД'),
('get_related_cases',            'backend', 'Пов''язані судові справи',                 0.01500000, 'За номером справи або embeddings'),
('extract_document_sections',    'backend', 'Вилучення структурованих секцій',          0.02000000, 'Залежить від use_llm'),
('load_full_texts',              'backend', 'Завантаження повних текстів рішень',       0.00700000, 'PG + Redis кеш перед завантаженням'),
('bulk_ingest_court_decisions',  'backend', 'Масове завантаження та індексація рішень', 0.05000000, 'Пошук → Scraping → Embeddings → Qdrant'),

-- Підрахунки та статистика
('count_cases_by_party',         'backend', 'Кількість справ за стороною',              0.00700000, '~$0.007 за сторінку (1000 справ)'),

-- Нормативна база
('find_relevant_law_articles',   'backend', 'Статті законів за темою',                  0.01500000, 'Legal patterns DB'),
('search_procedural_norms',      'backend', 'Пошук процесуальних норм (ЦПК/ГПК)',       0.01500000, 'Через RADA MCP'),

-- Законодавство
('get_legislation_article',      'backend', 'Отримати статтю законодавчого акту',       0.00100000, 'Мінімальна вартість'),
('get_legislation_section',      'backend', 'Отримати фрагмент за посиланням',          0.00100000, 'Мінімальна вартість'),
('get_legislation_articles',     'backend', 'Кілька статей одночасно',                  0.00200000, 'Мінімальна вартість'),
('search_legislation',           'backend', 'Семантичний пошук у законодавстві',        0.02000000, 'Векторний пошук'),
('get_legislation_structure',    'backend', 'Структура законодавчого акту',             0.00100000, 'Мінімальна вартість'),

-- Процесуальні інструменти
('calculate_procedural_deadlines','backend','Калькулятор процесуальних строків',        0.05000000, 'ЦПК/ГПК/КПК строки'),
('build_procedural_checklist',   'backend', 'Процесуальний чекліст',                   0.02000000, 'Шаблон + посилання на норму'),
('calculate_monetary_claims',    'backend', 'Розрахунок грошових вимог',               0.00500000, '3% річних, інфляція, пеня'),

-- Парсинг документів
('parse_document',               'backend', 'Парсинг документу (PDF/DOCX/HTML)',        0.05000000, 'PDF текст → OCR → Vision'),
('extract_key_clauses',          'backend', 'Вилучення ключових положень контракту',    0.06500000, 'Сторони, права, строки, штрафи'),
('summarize_document',           'backend', 'Резюме документу',                         0.05000000, 'Quick/standard/deep рівні'),
('compare_documents',            'backend', 'Порівняння двох документів',               0.07500000, 'Семантичне порівняння + embeddings'),

-- Vault
('store_document',               'backend', 'Збереження документу у vault',             0.00200000, 'Мінімальна вартість'),
('get_document',                 'backend', 'Отримання документу з vault',              0.00100000, 'Мінімальна вартість'),
('list_documents',               'backend', 'Список документів у vault',                0.00100000, 'З фільтрацією'),

-- Додатковий аналіз
('get_document_text',            'backend', 'Повний текст документу по doc_id',         0.00200000, 'Мінімальна вартість'),
('get_case_metadata',            'backend', 'Метадані справи без повного тексту',       0.00100000, 'Мінімальна вартість'),
('analyze_judicial_reasoning',   'backend', 'Глибокий аналіз судового обґрунтування',   0.03500000, 'Мотивировка'),
('extract_legal_principles',     'backend', 'Вилучення правових принципів',             0.05500000, 'З масиву рішень'),
('compare_decisions',            'backend', 'Порівняння двох або більше рішень',        0.04000000, 'Семантичне порівняння'),
('track_precedent_evolution',    'backend', 'Еволюція прецеденту в часі',               0.05500000, 'Хронологічний аналіз'),
('get_citation_network',         'backend', 'Мережа цитувань для набору справ',         0.10000000, 'Глибокий аналіз'),
('batch_process_documents',      'backend', 'Пакетна обробка документів',               0.05000000, 'Парсинг, вилучення, резюме'),
('get_judge_statistics',         'backend', 'Статистика по судді',                      0.02000000, 'Кількість справ, результати'),
('analyze_court_trends',         'backend', 'Аналіз тенденцій судової практики',        0.08500000, 'Тренди по суду/темі/часу'),

-- Головний інструмент
('get_legal_advice',             'backend', 'Комплексний юридичний аналіз',             0.20000000, 'Найдорожчий: quick~$0.10, standard~$0.18, deep~$0.28')

ON CONFLICT (tool_name) DO NOTHING;

-- ============================================================
-- Seed: RADA tools (4 інструменти)
-- ============================================================
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, notes) VALUES
('rada_search_parliament_bills',   'rada', 'Пошук законопроектів ВРУ',            0.01000000, 'Пошук по назві, статусу, автору'),
('rada_get_deputy_info',           'rada', 'Інформація про депутата',             0.00500000, 'ФІО, фракція, комітети, голосування'),
('rada_search_legislation_text',   'rada', 'Пошук у текстах законодавства',       0.01500000, 'Семантичний пошук RADA'),
('rada_analyze_voting_record',     'rada', 'Аналіз протоколу голосування',        0.02000000, 'По законопроекту або депутату')
ON CONFLICT (tool_name) DO NOTHING;

-- ============================================================
-- Seed: OpenReyestr tools (16 інструментів)
-- ============================================================
INSERT INTO tool_pricing (tool_name, service, display_name, base_cost_usd, notes) VALUES
('openreyestr_search_entities',                'openreyestr', 'Пошук юридичних осіб',                0.00500000, 'ЄДР: назва, код, статус'),
('openreyestr_get_entity_details',             'openreyestr', 'Деталі юридичної особи',              0.00300000, 'Повна інформація з ЄДР'),
('openreyestr_search_beneficiaries',           'openreyestr', 'Пошук бенефіціарів',                  0.00500000, 'Кінцеві власники'),
('openreyestr_get_by_edrpou',                  'openreyestr', 'Пошук за кодом ЄДРПОУ',              0.00300000, 'Точний пошук за кодом'),
('openreyestr_get_statistics',                 'openreyestr', 'Статистика реєстру',                  0.00100000, 'Загальна статистика ЄДР'),
('openreyestr_search_notaries',                'openreyestr', 'Пошук нотаріусів',                    0.00300000, 'Реєстр нотаріусів'),
('openreyestr_search_court_experts',           'openreyestr', 'Пошук судових експертів',             0.00300000, 'Реєстр судових експертів'),
('openreyestr_search_arbitration_managers',    'openreyestr', 'Пошук арбітражних керуючих',          0.00300000, 'Реєстр арбітражних керуючих'),
('openreyestr_search_debtors',                 'openreyestr', 'Пошук боржників',                     0.00500000, 'Реєстр боржників'),
('openreyestr_search_enforcement_proceedings', 'openreyestr', 'Виконавчі провадження',               0.00500000, 'Пошук по ВДВС'),
('openreyestr_search_bankruptcy_cases',        'openreyestr', 'Справи про банкрутство',              0.00500000, 'Реєстр банкрутів'),
('openreyestr_search_special_forms',           'openreyestr', 'Спеціальні форми власності',          0.00300000, 'Особливі форми'),
('openreyestr_search_forensic_methods',        'openreyestr', 'Методи судової експертизи',           0.00300000, 'Словник методів'),
('openreyestr_search_legal_acts',              'openreyestr', 'Нормативні акти реєстру',             0.00300000, 'Правові акти ЄДР'),
('openreyestr_search_administrative_units',    'openreyestr', 'Пошук адміністративних одиниць',      0.00100000, 'КАТОТТГ класифікатор'),
('openreyestr_search_streets',                 'openreyestr', 'Пошук вулиць',                        0.00100000, 'Класифікатор вулиць')
ON CONFLICT (tool_name) DO NOTHING;
