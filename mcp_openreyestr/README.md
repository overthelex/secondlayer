# OpenReyestr MCP Server

MCP-сервер для доступу до реєстрів НАІС (Національні інформаційні системи) та інших відкритих джерел даних України через Model Context Protocol.

## Огляд

Сервер надає 27 MCP-інструментів для пошуку у державних реєстрах:

### Реєстри НАІС (ЄДР)
- **Юридичні особи (UO)** -- пошук, деталі, бенефіціари
- **ФОП (FOP)** -- фізичні особи-підприємці
- **Громадські формування (FSU)** -- громадські організації та відокремлені підрозділи

### Реєстри НАІС (додаткові)
- **Нотаріуси** -- Єдиний реєстр нотаріусів
- **Судові експерти** -- атестовані судові експерти
- **Арбітражні керуючі** -- реєстр арбітражних керуючих
- **Боржники** -- Єдиний реєстр боржників
- **Виконавчі провадження** -- автоматизована система виконавчого провадження
- **Справи про банкрутство** -- реєстр підприємств-банкрутів
- **Спеціальні бланки** -- бланки нотаріальних документів
- **Методики судових експертиз** -- зареєстровані методики
- **Нормативно-правові акти** -- ЄДРНПА
- **Адміністративно-територіальний устрій** -- словник АТУ (КОАТУУ)
- **Вулиці** -- словник вулиць населених пунктів
- **Дані обміну з держорганами** -- 23.2M записів

### Інші джерела
- **АРМА** -- активи під арештом у кримінальних провадженнях
- **ProZorro** -- тендери публічних закупівель (662K тендерів з 2015)
- **НАЗК** -- декларації чиновників (322K декларацій)
- **РНБО** -- санкційні списки (21K записів)
- **ДПС** -- реєстр платників ПДВ, єдиного податку, податковий борг, борг з ЄСВ
- **Перейменування вулиць** -- історія перейменувань (дані OpenStreetMap, ~64K вулиць)
- **Процедури припинення** -- юридичні особи у процедурі припинення (148K записів)

## Транспорт

- **MCP stdio** -- для Claude Desktop та інших MCP-клієнтів
- **HTTP API** -- REST-ендпоінти з Bearer-автентифікацією
- **SSE** -- Server-Sent Events для стрімінгу

## Встановлення

```bash
cd mcp_openreyestr
npm install
```

## Налаштування бази даних

```bash
# Скопіювати шаблон .env
cp .env.example .env

# Відредагувати .env з вашими параметрами
nano .env

# Створити БД та виконати міграції
npm run db:setup
```

## Імпорт даних

### Автоматичний синхронізація всіх реєстрів НАІС

```bash
# Завантажити та імпортувати всі реєстри НАІС
npm run import:nais

# Синхронізувати всі реєстри (завантаження + імпорт)
npm run sync:registries

# Синхронізувати лише щотижневі реєстри
npm run sync:weekly

# Синхронізувати конкретний реєстр
npm run sync:registry -- --only=notaries
```

### Окремі імпорти

```bash
# Імпорт юридичних осіб / ФОП / громадських організацій з XML
npm run import:entities

# Імпорт боржників з CSV
npm run import:debtors

# Імпорт ЄДРПОУ
npm run sync:edrpou

# Імпорт перейменувань вулиць (OpenStreetMap)
npm run import:street-renamings

# Перейменування вулиць з прив'язкою до населеного пункту (street_renamings_scoped):
# з історії адрес ЄДР і з OpenStreetMap (дамп Geofabrik, див. scripts/osm/README.md)
npm run derive:street-renamings -- --dry-run --out /tmp/edr.csv
npm run import:osm-street-renamings -- --dir /mnt/bulk_storage/opendata/osm/extract --dry-run --out /mnt/bulk_storage/opendata/osm/out
```

Рядки `street_renamings_scoped` з `source='osm'` і таблиця `street_renamings` — похідні бази даних
OpenStreetMap під ліцензією [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/):
усюди, де вони показуються, потрібне посилання «© OpenStreetMap contributors»
(https://www.openstreetmap.org/copyright). Дані OSM у репозиторій не комітяться.

## Запуск

### MCP stdio (для Claude Desktop)

```bash
npm run build
npm start
```

### HTTP API

```bash
# Розробка з авто-перезавантаженням
npm run dev:http

# Продакшн
npm run build
npm run start:http
```

Сервер стартує на порту 3004 (налаштовується через `HTTP_PORT`).

## API-ендпоінти

Всі ендпоінти вимагають Bearer-токен автентифікації (`SECONDARY_LAYER_KEYS` або `OPENREYESTR_API_KEYS`).

| Метод | Шлях | Опис |
|-------|------|------|
| `GET` | `/health` | Повна перевірка здоров'я (PostgreSQL) |
| `GET` | `/health/live` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe (перевірка БД) |
| `GET` | `/metrics` | Prometheus-метрики (без автентифікації) |
| `GET` | `/api/stats` | Статистика по всіх таблицях (без автентифікації) |
| `GET` | `/api/tools` | Список доступних інструментів |
| `POST` | `/api/tools/:toolName` | Виклик інструменту (JSON або SSE) |
| `POST` | `/api/tools/:toolName/stream` | Стрімінг виконання (SSE) |
| `POST` | `/api/admin/sync-registry` | Тригер синхронізації реєстру |

### Приклади

```bash
# Пошук юридичних осіб
curl -X POST http://localhost:3004/api/tools/search_entities \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"query": "Приватбанк", "entityType": "UO", "limit": 10}}'

# Деталі за номером запису
curl -X POST http://localhost:3004/api/tools/get_entity_details \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"record": "14426646"}}'

# Пошук за ЄДРПОУ
curl -X POST http://localhost:3004/api/tools/get_by_edrpou \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"edrpou": "14360570"}}'

# Пошук бенефіціарів
curl -X POST http://localhost:3004/api/tools/search_beneficiaries \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"query": "Коломойський", "limit": 50}}'

# Пошук нотаріусів
curl -X POST http://localhost:3004/api/tools/search_notaries \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"region": "Київська", "limit": 20}}'

# Статистика реєстру
curl -X POST http://localhost:3004/api/tools/get_statistics \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {}}'
```

## MCP-інструменти (27)

### ЄДР (5 інструментів)

| Інструмент | Опис |
|------------|------|
| `search_entities` | Пошук юридичних осіб, ФОП, громадських організацій |
| `get_entity_details` | Повна інформація про суб'єкт (засновники, бенефіціари, керівники, філії) |
| `search_beneficiaries` | Пошук кінцевих бенефіціарних власників |
| `get_by_edrpou` | Пошук за кодом ЄДРПОУ |
| `get_statistics` | Статистика реєстру за типами та статусами |

### Реєстри НАІС (11 інструментів)

| Інструмент | Опис |
|------------|------|
| `search_notaries` | Пошук нотаріусів за ім'ям, регіоном, статусом |
| `search_court_experts` | Пошук судових експертів за ім'ям, типом експертизи |
| `search_arbitration_managers` | Пошук арбітражних керуючих |
| `search_debtors` | Пошук боржників за ім'ям, ЄДРПОУ, категорією |
| `search_enforcement_proceedings` | Пошук виконавчих проваджень |
| `search_bankruptcy_cases` | Пошук справ про банкрутство |
| `search_special_forms` | Пошук спеціальних бланків нотаріальних документів |
| `search_forensic_methods` | Пошук методик судових експертиз |
| `search_legal_acts` | Пошук НПА за назвою, типом, видавником |
| `search_administrative_units` | Пошук адміністративно-територіальних одиниць (КОАТУУ) |
| `search_streets` | Пошук вулиць за назвою, населеним пунктом |

### Інші реєстри (11 інструментів)

| Інструмент | Опис |
|------------|------|
| `search_exchange_data` | Дані обміну з державними органами (23.2M записів) |
| `search_arma_seized_assets` | Активи під арештом АРМА |
| `search_prozorro` | Тендери ProZorro |
| `search_nazk_declarations` | Декларації НАЗК (322K) |
| `search_rnbo_sanctions` | Санкційні списки РНБО (21K) |
| `search_vat_payers` | Реєстр платників ПДВ (дані станом на 23.02.2022) |
| `search_single_tax_payers` | Реєстр платників єдиного податку |
| `search_tax_debt` | Реєстр податкового боргу |
| `search_esv_debt` | Реєстр боргу з ЄСВ |
| `search_street_renamings` | Історія перейменувань вулиць (© OpenStreetMap contributors, ODbL; ~64K) |
| `search_termination_started` | Юридичні особи у процедурі припинення (148K) |

## Схема бази даних

### Основні таблиці ЄДР

| Таблиця | Опис |
|---------|------|
| `legal_entities` | Юридичні особи (UO) |
| `individual_entrepreneurs` | ФОП (FOP) |
| `public_associations` | Громадські формування (FSU) |
| `founders` | Засновники / учасники |
| `beneficiaries` | Бенефіціарні власники |
| `signers` | Керівники та підписанти |
| `members` | Члени органів управління |
| `branches` | Філії |
| `predecessors` | Правопопередники |
| `assignees` | Правонаступники |
| `termination_started` | Дані про припинення |
| `exchange_data` | Дані обміну з держорганами |

### Реєстри НАІС

| Таблиця | Опис |
|---------|------|
| `notaries` | Нотаріуси |
| `court_experts` | Судові експерти |
| `arbitration_managers` | Арбітражні керуючі |
| `debtors` | Боржники |
| `enforcement_proceedings` | Виконавчі провадження |
| `bankruptcy_cases` | Справи про банкрутство |
| `special_forms` | Спеціальні бланки |
| `forensic_methods` | Методики судових експертиз |
| `legal_acts` | Нормативно-правові акти |
| `administrative_units` | Адмін-територіальний устрій |
| `streets` | Вулиці населених пунктів |

### Службові таблиці

| Таблиця | Опис |
|---------|------|
| `registry_metadata` | Метадані реєстрів |
| `import_log` | Журнал імпорту |
| `cost_tracking` | Відстеження витрат API |

## Змінні оточення

```bash
# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5435
POSTGRES_USER=openreyestr
POSTGRES_PASSWORD=your-password
POSTGRES_DB=openreyestr
DATABASE_URL=postgresql://openreyestr:password@localhost:5435/openreyestr

# Redis (для кешування)
REDIS_HOST=localhost
REDIS_PORT=6382

# HTTP-сервер
HTTP_PORT=3004
HTTP_HOST=0.0.0.0
NODE_ENV=development

# Автентифікація
SECONDARY_LAYER_KEYS=key1,key2
OPENREYESTR_API_KEYS=key1,key2
JWT_SECRET=your-jwt-secret

# OpenAI (для AI-аналізу)
OPENAI_API_KEY=sk-...

# Дозволені CORS origins
ALLOWED_ORIGINS=https://legal.org.ua
```

## Джерело даних

Дані з реєстрів НАІС: https://nais.gov.ua/pass_opendata

Додаткові джерела: data.gov.ua (АРМА, ProZorro, НАЗК, РНБО, ДПС), OpenStreetMap (перейменування вулиць).

## Структура проєкту

```
src/
  api/              -- MCP-інструменти та API-обробники
    mcp-openreyestr-api.ts  -- визначення 27 інструментів та роутинг
    openreyestr-tools.ts    -- реалізація інструментів (SQL-запити)
  config/
    registries.ts   -- конфігурація всіх реєстрів НАІС (URL, формат, маппінг полів)
  database/
    database.ts     -- підключення до PostgreSQL
  middleware/
    dual-auth.ts    -- Bearer-токен + JWT автентифікація
    rate-limit.ts   -- rate limiting
  migrations/       -- SQL-міграції (001-014)
  scripts/          -- скрипти імпорту (download-nais, sync-all, import-*)
  services/         -- бізнес-логіка (XML/CSV парсери, імпортери, метрики)
  types/            -- TypeScript типи
  utils/
    logger.ts       -- Winston логування
  http-server.ts    -- HTTP REST entry point
  index.ts          -- MCP stdio entry point
```

## Розробка

```bash
npm install       # Встановити залежності
npm test          # Запустити тести (Jest)
npm run lint      # Перевірка коду (ESLint)
npm run dev:http  # Розробка з авто-перезавантаженням
npm run build     # Збірка TypeScript
```

## Ліцензія

MIT
