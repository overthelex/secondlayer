# SecondLayer MCP Server

Model Context Protocol сервер для юридичного аналізу: судові рішення, законодавство, реєстри, due diligence.

## Опис

MCP сервер надає інструменти для:
- Пошуку судових рішень (ЄДРСР, відкриті дані)
- Семантичного пошуку та аналізу документів
- Роботи із законодавством (класифікація, моніторинг змін)
- Юридичних консультацій з AI (format_answer_pack, search_legal_precedents)
- Due diligence та перевірки контрагентів
- Пошуку у відкритих реєстрах (санкції, торгові марки, патенти, ЄДРПОУ тощо)
- Зберігання документів (vault) з шифруванням
- Процесуальних інструментів (строки, чеклісти, грошові вимоги)
- ЄСПЛ практики та іспанського законодавства (BOE, AEPD)

## Запуск

### Development (MCP mode)

```bash
npm install
npm run dev
```

### HTTP Server mode

```bash
npm run dev:http
```

HTTP сервер запуститься на http://localhost:3000

### SSE Server mode

```bash
npm run dev:sse
```

## Конфігурація

Створіть `.env` файл (див. `.env.example`):

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/secondlayer

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Qdrant
QDRANT_URL=http://localhost:6333

# OpenAI
OPENAI_API_KEY=your-key

# Security (для HTTP mode)
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456

# JWT
JWT_SECRET=your-secret

# MinIO (document storage)
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=your-key
MINIO_SECRET_KEY=your-secret
```

## Структура

```
mcp_backend/
├── src/
│   ├── adapters/          # Адаптери для зовнішніх API (ЄДРСР, Рада)
│   ├── api/               # MCP tool handlers (base-tool-handler pattern)
│   │   └── tools/         # Окремі tool handler файли
│   ├── database/          # Підключення до БД
│   ├── factories/         # Service factories (core, tools, billing, app)
│   ├── infrastructure/    # Infrastructure adapters (cache, LLM)
│   ├── middleware/        # Express middleware (auth, rate-limit)
│   ├── migrations/        # DB migrations
│   ├── routes/            # Express route handlers (50+ route files)
│   ├── services/          # Бізнес-логіка (80+ service files)
│   ├── types/             # TypeScript типи
│   ├── utils/             # Утиліти
│   ├── index.ts           # MCP server entry point (stdio)
│   ├── http-server.ts     # HTTP server entry point
│   └── sse-server.ts      # SSE server entry point
├── scripts/               # Допоміжні скрипти
├── config-examples/       # Приклади конфігурацій клієнтів
├── docs/                  # Документація
└── bin/                   # CLI utilities
```

## Docker

Всі Dockerfiles знаходяться в `deployment/`. Запуск через docker compose:

```bash
cd deployment
docker compose -f docker-compose.local.yml --env-file .env.local up -d
```

Для production деплой відбувається через CI/CD (merge PR to main).

## Команди

```bash
npm run build           # Збірка TypeScript
npm run dev             # Dev режим (MCP stdio)
npm run dev:http        # Dev режим (HTTP)
npm run dev:sse         # Dev режим (SSE)
npm start               # Prod MCP server
npm run start:http      # Prod HTTP server
npm run start:sse       # Prod SSE server
npm run migrate         # Запустити міграції
npm run db:setup        # Створити БД + міграції
npm test                # Запустити тести (Jest)
npm run lint            # Лінтінг
npm run seed:admin      # Seed admin user
npm run seed:test-account  # Seed test account
npm run compute:judge-analytics  # Аналітика суддів
```

## API Endpoints (HTTP mode)

### Health & Monitoring
- `GET /health` — Детальний health check (PostgreSQL, Redis, Qdrant, MinIO, OpenAI)
- `GET /health/live` — Liveness probe
- `GET /health/ready` — Readiness probe
- `GET /metrics` — Prometheus metrics

### MCP Tool Execution
- `POST /api/tools/:toolName` — Виконати MCP tool
- `POST /api/tools/:toolName/stream` — Виконати tool з SSE streaming
- `POST /api/tools/batch` — Batch execution

### Authentication
- `POST /auth/google` — Google OAuth
- `GET /auth/me` — Поточний користувач (JWT)
- `POST /oauth/authorize` — OAuth 2.0 (ChatGPT integration)

### Billing & Payments
- `GET /api/billing/balance` — Баланс користувача
- `POST /api/billing/payment/monobank/create` — Оплата через Monobank
- `GET /api/billing/pricing-info` — Тарифні плани

### Documents & Upload
- `POST /api/upload/init` — Ініціювати завантаження
- `POST /api/upload/:uploadId/chunk` — Завантажити частину
- `POST /api/upload/:uploadId/complete` — Завершити завантаження

### Admin
- `GET /api/admin/stats/overview` — Dashboard статистика
- `GET /api/admin/users` — Управління користувачами
- `GET /api/admin/transactions` — Транзакції
- `GET /api/admin/analytics/cohorts` — Аналітика когорт

### Інше
- `GET /api/geo` — Визначення країни/валюти (Cloudflare)
- `GET /api/currency/rate` — Курс USD/UAH
- `/api/conversations` — Server-side чат
- `/api/edrsr` — Прямий доступ до ЄДРСР
- `/api/matters` — Client-Matter segregation
- `/api/team` — Команди
- `/api/gdpr` — GDPR export/deletion

## MCP Tools (Backend)

Локальні інструменти, зареєстровані через `ToolRegistry` -> `BaseToolHandler`:

### Core Query Tools (mcp-query-api.ts)
- `classify_intent` — Класифікація запиту (entry-point для роутингу)
- `retrieve_legal_sources` — RAG retrieval джерел
- `validate_response` — Anti-hallucination перевірка
- `check_precedent_status` — Перевірка актуальності рішення

### Court Decision Tools
- `get_court_decision` — Отримати рішення суду
- `get_case_documents_chain` — Ланцюг документів справи
- `extract_document_sections` — Витягти секції документа
- `load_full_texts` — Завантажити повні тексти
- `bulk_ingest_court_decisions` — Масовий імпорт рішень
- `analyze_case_pattern` — Аналіз паттернів
- `count_cases_by_party` — Підрахунок справ за стороною

### EDRSR Tools
- `search_edrsr_decisions` — Пошук рішень в ЄДРСР
- `get_edrsr_decision_fulltext` — Повний текст рішення з ЄДРСР
- `search_edrsr_fulltext` — Повнотекстовий пошук в ЄДРСР
- `search_edrsr_semantic` — Семантичний пошук в ЄДРСР
- `vectorize_edrsr_results` — Векторизація результатів ЄДРСР

### Legal Advice Tools
- `format_answer_pack` — Форматування відповіді
- `search_legal_precedents` — Пошук прецедентів
- `get_similar_reasoning` — Пошук схожих обґрунтувань
- `get_citation_graph` — Граф цитувань

### Legislation Tools
- `get_legislation_section` — Отримати секцію законодавства (з AI-класифікацією)

### Procedural Tools
- `search_procedural_norms` — Пошук процесуальних норм
- `compare_practice_pro_contra` — Порівняння практики
- `find_similar_fact_pattern_cases` — Пошук схожих справ
- `calculate_procedural_deadlines` — Розрахунок строків
- `build_procedural_checklist` — Процесуальний чекліст
- `calculate_monetary_claims` — Розрахунок грошових вимог

### Document Analysis Tools
- `parse_document` — Парсинг документа
- `extract_key_clauses` — Витягти ключові положення
- `summarize_document` — Резюме документа
- `compare_documents` — Порівняння документів

### Vault Tools
- `store_document` — Зберегти документ
- `get_document` — Отримати документ
- `list_documents` — Список документів
- `semantic_search` — Семантичний пошук у vault
- `delete_document` — Видалити документ
- `update_document` — Оновити документ

### Due Diligence Tools
- `bulk_review_runner` — Масова перевірка
- `risk_scoring` — Оцінка ризиків
- `generate_dd_report` — Генерація звіту DD

### OpenData Tools
- `search_sanctions` — Пошук у санкційних списках
- `search_trademarks` — Торгові марки
- `search_patents` — Патенти
- `search_edrnpa` — ЄДРНПА (нормативно-правові акти)
- `search_corruption_register` — Реєстр корупціонерів
- `search_lawyers` — Реєстр адвокатів
- `search_vrp_decisions` — Рішення ВРП
- `search_vrp_judges_discipline` — Дисциплінарні рішення щодо суддів
- `search_vkks` — ВККС
- `search_declaration_checks` — Перевірки декларацій
- `search_wage_debtors` — Боржники по зарплаті
- `search_large_taxpayers` — Великі платники податків

### OpenData Registries Tools
- `search_public_organizations` — Публічні організації
- `search_case_distribution` — Розподіл справ
- `search_missing_persons` — Зниклі безвісти
- `search_securities_owners` — Власники цінних паперів
- `search_wanted_persons` — Розшук осіб
- `search_wanted_vehicles` — Розшук ТЗ
- `search_court_experts_registry` — Реєстр судових експертів
- `search_vat_payers_registry` — Реєстр платників ПДВ
- `search_judges` — Пошук суддів

### Other Tools
- `search_court_sessions` — Пошук судових засідань
- `bulk_ingest_court_sessions` — Масовий імпорт засідань
- `search_court_case_status` — Статус справи
- `search_case_status_by_party` — Справи за стороною (ПІБ або назва): стан розгляду ДСА + архів засідань
- `get_case_status_details` — Картка справи: усі стадії, сторони, засідання
- `search_legal_acts` — Пошук правових актів
- `get_legal_act_meta` — Метадані правового акту
- `search_public_spending` — Публічні витрати
- `search_nbu_banks` — Реєстр банків НБУ
- `build_legal_decision` — Побудова юридичного рішення
- `batch_process_documents` — Масова обробка документів
- `search_echr_practice` — Практика ЄСПЛ
- `get_echr_document` — Документ ЄСПЛ
- `nextcloud_upload` / `nextcloud_share` — Nextcloud інтеграція
- `list_import_sources` / `start_import` / `get_import_status` / `cancel_import` — Import tasks
- `spain_boe_search` / `spain_boe_get_text` / `spain_aepd_search` / `spain_aepd_get_resolution` / `spain_aepd_stats` — Іспанське законодавство

### Remote Tools (via Unified Gateway)
- `rada_*` (4 tools) — Парламентські дані (законопроекти, депутати, голосування)
- `openreyestr_*` (27 tools) — Державні реєстри (ЄДРПОУ, бенефіціари, боржники, нотаріуси, санкції тощо)

## Адаптери (src/adapters/)

- **RadaLegislationAdapter** — Завантаження законодавства з API Верховної Ради (zakon.rada.gov.ua)
- **EDRSRLocalAdapter** — Локальний адаптер для ЄДРСР
- **ZOAdapter** — Legacy адаптер (deprecated, не використовується у production)

## Технології

- TypeScript 5.3
- Model Context Protocol SDK
- Express 5
- PostgreSQL 15
- Redis 7
- Qdrant (vector DB)
- MinIO (object storage)
- OpenAI API (GPT-4o, text-embedding-ada-002)
- BullMQ (job queues)
- Playwright (court registry scraping)
- Monobank / Binance Pay / NOWPayments (платежі)

## Ліцензія

MIT
