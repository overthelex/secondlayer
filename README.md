# SecondLayer MCP Backend

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-SDK-6E56CF)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-DB-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-Cache-DC382D?logo=redis&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-Vector%20DB-FF4D4D)
![OpenAI](https://img.shields.io/badge/OpenAI-API-000000?logo=openai&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

## 📚 Documentation

Complete documentation is available in the [docs/](docs/) directory:
- **[Getting Started](docs/guides/START_HERE.md)** - Quick start guide
- **[API Documentation](docs/api/)** - MCP tools and API reference
- **[Deployment Guide](docs/deployment/)** - Deployment and infrastructure
- **[Testing](docs/testing/)** - Testing guides and examples
- **[Security](docs/security/)** - Security configuration
- **[Backend Services](docs/backend/)** - Backend service documentation

See [docs/README.md](docs/README.md) for complete documentation index.

---

`SecondLayer` — MCP (Model Context Protocol) серверный слой для семантической работы с юридическими данными (в т.ч. интеграция с Zakononline), с поддержкой нескольких транспортов запуска:

- **MCP stdio** (для локальной интеграции с MCP-клиентами)
- **HTTP API** (для приложений/админок и прямых вызовов)
- **Remote MCP over SSE** (для удалённых клиентов по HTTPS)

Репозиторий — моно-репо, но этот `README` сфокусирован на **@/mcp_backend** как на основном исполняемом сервисе.

## Что умеет `mcp_backend`

- **MCP tools**: выполнение инструментов через MCP SDK.
- **Поиск и извлечение** юридических документов/материалов (через адаптеры).
- **Семантическая обработка** (эмбеддинги, секционирование, семантический поиск).
- **Юридические паттерны** (хранилище/поиск паттернов).
- **Валидация цитат** и защитные механизмы против галлюцинаций.
- **Cost tracking**: трекинг стоимости запросов/операций на стороне сервера.

## Быстрый старт (локально)

### 1) Установка

```bash
cd mcp_backend
npm install
```

### 2) Конфигурация

Создай файл `mcp_backend/.env` (пример есть в `mcp_backend/.env.example`). Минимально важные переменные:

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/secondlayer

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Qdrant
QDRANT_URL=http://localhost:6333

# LLM
OPENAI_API_KEY=your-key

# External data source
ZAKONONLINE_API_TOKEN=your-token

# Security (для HTTP mode)
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456
```

### 3) Запуск

- **MCP mode (stdio)**

```bash
cd mcp_backend
npm run dev
```

- **HTTP API mode** (по умолчанию `http://0.0.0.0:3000`)

```bash
cd mcp_backend
npm run dev:http
```

- **Remote MCP over SSE**

```bash
cd mcp_backend
npm run dev:sse
```

## HTTP API (когда запущено `npm run dev:http`)

- `GET /health`
- `GET /api/tools` (список доступных tools)
- `POST /api/tools/:toolName` (вызов tool)
- `POST /api/tools/:toolName/stream` (SSE стриминг выполнения)
- `POST /api/tools/batch` (batch вызовы)

**Аутентификация:**

- Для клиентского доступа используется `Authorization: Bearer <SECONDARY_LAYER_KEY>`.
- Для админских/пользовательских сценариев в коде присутствует JWT/Passport (зависит от роутов).

## Remote MCP over SSE (когда запущено `npm run dev:sse`)

- `POST /v1/sse` — MCP JSON-RPC поверх SSE
- `GET /health`

Этот режим удобен для удалённого подключения MCP-клиентов по HTTPS (не через stdio).

## Архитектура (упрощённо)

```mermaid
flowchart LR
  subgraph Clients["Клиенты"]
    MCPClient["MCP client"]
    WebApp["Web app / Admin UI"]
    RemoteClient["Remote MCP client"]
  end

  subgraph Transports["Транспорты"]
    STDIO["stdio (MCP)"]
    HTTP["HTTP API"]
    SSE["MCP over SSE"]
  end

  subgraph Backend["mcp_backend"]
    API["MCPQueryAPI"]
    Services["Services"]
    Adapters["Adapters"]
    Cost["CostTracker"]
  end

  subgraph Infra["Инфраструктура"]
    PG[("PostgreSQL")]
    Redis[("Redis")]
    Qdrant[("Qdrant")]
  end

  subgraph External["Внешние сервисы"]
    OpenAI[("OpenAI API")]
    ZO[("Zakononline API")]
  end

  MCPClient --> STDIO --> API
  WebApp --> HTTP --> API
  RemoteClient --> SSE --> API

  API --> Services
  API --> Cost
  Services --> Adapters
  Services --> Infra
  Cost --> PG

  Adapters --> ZO
  Services --> OpenAI
  Services --> Qdrant
  Services --> Redis
  Services --> PG
```

## Структура (ключевое)

```text
mcp_backend/
├── src/
│   ├── adapters/         # интеграции с внешними источниками
│   ├── api/              # MCP API (tool definitions + router)
│   ├── database/         # подключение к БД
│   ├── middleware/       # auth, JWT, dual auth
│   ├── services/         # бизнес-логика (embeddings, patterns, validation, etc.)
│   ├── utils/            # логирование и утилиты
│   ├── index.ts          # MCP stdio entrypoint
│   ├── http-server.ts    # HTTP server entrypoint
│   └── sse-server.ts     # MCP over SSE entrypoint
├── docs/
├── scripts/
└── migrations/
```

## Команды

```bash
cd mcp_backend
npm run build
npm run dev
npm run dev:http
npm run dev:sse
npm run migrate
npm test
npm run lint
```

## Docker

В `mcp_backend/` есть `Dockerfile` и `docker-compose` сценарии.

```bash
cd mcp_backend
docker-compose up -d
```

## Документация

- [mcp_backend/README.md](mcp_backend/README.md)
- [mcp_backend/docs/CLIENT_INTEGRATION.md](mcp_backend/docs/CLIENT_INTEGRATION.md)
- [mcp_backend/docs/SSE_STREAMING.md](mcp_backend/docs/SSE_STREAMING.md)
- [mcp_backend/docs/DATABASE_SETUP.md](mcp_backend/docs/DATABASE_SETUP.md)
- [docs/COST_TRANSPARENCY.md](docs/COST_TRANSPARENCY.md)

## Лицензия

MIT
