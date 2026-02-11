# Migration Summary - SecondLayer Project Restructure

## Что было сделано

### 1. Перенос MCP сервера

Весь код MCP сервера перенесен из корня в `mcp_backend/`:

```
✅ Скопировано из Docker контейнера 56522ea5ede8:
- src/              → mcp_backend/src/
- scripts/          → mcp_backend/scripts/
- migrations/       → mcp_backend/migrations/
- docs/             → mcp_backend/docs/
- package.json      → mcp_backend/package.json
- tsconfig.json     → mcp_backend/tsconfig.json
- Dockerfile        → mcp_backend/Dockerfile
- docker-compose.yml → mcp_backend/docker-compose.yml
- jest configs      → mcp_backend/
```

### 2. Удалено из корня

```
❌ Удалены дубликаты:
- src/
- dist/
- migrations/
- scripts/
- docs/
- tsconfig.json
- jest.config.js
- jest.setup.js
- .eslintrc.json
- Dockerfile
- docker-compose.yml

❌ Удалены временные файлы:
- extract-cases-batch.js
- extract-more-cases.js
- html-to-text-converter.js
- rebuild-combined-file.js
- test-html-parser.js
- test-*.html
- test-*.txt
- description.txt
- docs.txt
- implementation.txt
- extraction.log
- extracted_cases/
- logs/

❌ Удалены старые markdown:
- architecture-mvp.md
- implementation-plan.md
- CLEANUP.md
- EXTRACTION_REPORT.md
- FINAL_RESULTS.md
- и др.

❌ Удалена неиспользуемая папка:
- api-server/
```

### 3. Создано новое

```
✨ Новые файлы:
- README.md (корневой с описанием всего проекта)
- package.json (root, с workspaces)
- .gitignore (обновленный)
- mcp_backend/README.md
- MIGRATION_SUMMARY.md (этот файл)
```

## Текущая структура проекта

```
SecondLayer/
├── .env                    # Конфигурация (не в git)
├── .gitignore             # Игнорируемые файлы
├── README.md              # Главная документация
├── package.json           # Root package с workspaces
│
├── mcp_backend/           # MCP сервер
│   ├── src/              
│   │   ├── adapters/      # API адаптеры
│   │   ├── api/           # MCP endpoints
│   │   ├── database/      # PostgreSQL
│   │   ├── middleware/    # Express middleware
│   │   ├── migrations/    # DB migrations
│   │   ├── services/      # Бизнес-логика
│   │   ├── types/         # TypeScript types
│   │   ├── utils/         # Утилиты
│   │   ├── index.ts       # MCP entry point
│   │   └── http-server.ts # HTTP entry point
│   ├── scripts/           # Bash скрипты
│   ├── docs/              # Документация
│   ├── migrations/        # SQL миграции
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── docker-compose.yml
│
└── frontend/              # Веб-админка
    ├── src/
    │   ├── pages/         # Страницы
    │   ├── providers/     # Data providers
    │   ├── styles/        # Темы
    │   ├── config/        # Конфигурация
    │   └── App.tsx
    ├── public/
    ├── package.json
    ├── vite.config.ts
    └── README.md
```

## Конфигурация

### Root `.env`
```bash
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456
```

### `mcp_backend/.env`
```bash
DATABASE_URL=postgresql://...
REDIS_HOST=localhost
QDRANT_URL=http://localhost:6333
OPENAI_API_KEY=...
ZAKONONLINE_API_TOKEN=...
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456
```

### `frontend/.env`
```bash
VITE_API_URL=http://localhost:3000/api
VITE_SECONDARY_LAYER_KEY=test-key-123
```

## Запуск

### Вариант 1: Отдельные терминалы

**Backend:**
```bash
cd mcp_backend
npm install
npm run dev:http
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

### Вариант 2: Из корня (рекомендуется)

```bash
npm run install:all    # Установить все зависимости
npm run backend        # Запустить backend
npm run frontend       # Запустить frontend (в другом терминале)
```

## Проверка

1. Backend запущен: http://localhost:3000/health
2. Frontend запущен: http://localhost:5173
3. API работает с авторизацией

## Docker

Контейнер `56522ea5ede8` продолжает работать с актуальным кодом.

Для пересборки:
```bash
cd mcp_backend
docker-compose up -d --build
```

## Следующие шаги

- [ ] Протестировать MCP сервер в новой структуре
- [ ] Проверить frontend подключение к backend
- [ ] Обновить docker-compose для работы с новой структурой
- [ ] Добавить GitHub Actions для CI/CD
- [ ] Написать тесты

## Дата миграции

17 января 2026
