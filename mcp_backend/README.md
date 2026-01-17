# SecondLayer MCP Server

Model Context Protocol server для работы с юридическими документами из Zakononline.

## Описание

MCP сервер предоставляет инструменты для:
- Поиска судебных решений
- Семантического анализа документов  
- Работы с юридическими паттернами
- Валидации цитат

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

HTTP сервер запустится на http://localhost:3000

## Конфигурация

Создайте `.env` файл:

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

# Zakononline API
ZAKONONLINE_API_TOKEN=your-token

# Security (для HTTP mode)
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456
```

## Структура

```
mcp_backend/
├── src/
│   ├── adapters/       # Адаптеры для внешних API
│   ├── api/            # MCP API endpoints
│   ├── database/       # Подключение к БД
│   ├── middleware/     # Express middleware
│   ├── migrations/     # DB migrations
│   ├── services/       # Бизнес-логика
│   ├── types/          # TypeScript типы
│   ├── utils/          # Утилиты
│   ├── index.ts        # MCP server entry point
│   └── http-server.ts  # HTTP server entry point
├── scripts/            # Вспомогательные скрипты
├── docs/               # Документация
└── migrations/         # SQL миграции
```

## Docker

### Сборка

```bash
docker build -t secondlayer-mcp .
```

### Запуск через docker-compose

```bash
docker-compose up -d
```

## Команды

```bash
npm run build       # Сборка TypeScript
npm run dev         # Dev режим (MCP)
npm run dev:http    # Dev режим (HTTP)
npm start           # Prod MCP server
npm start:http      # Prod HTTP server
npm run migrate     # Запустить миграции
npm test            # Запустить тесты
npm run lint        # Линтинг
```

## API Endpoints (HTTP mode)

Когда запущен в HTTP режиме:

- `GET /health` - Health check
- `POST /api/search` - Поиск документов
- `POST /api/analyze` - Анализ документа
- `GET /api/patterns` - Юридические паттерны

## MCP Tools

В MCP режиме доступны инструменты:

- `search_court_cases` - Поиск судебных дел
- `get_document_text` - Получить текст документа
- `semantic_search` - Семантический поиск
- `validate_citations` - Валидация цитат
- `find_patterns` - Поиск паттернов

## Технологии

- TypeScript
- Model Context Protocol SDK
- PostgreSQL
- Redis
- Qdrant (vector DB)
- OpenAI API
- Express (HTTP mode)

## Лицензия

MIT
