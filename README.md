# SecondLayer - Legal Documents Analysis Platform

Платформа для работы с юридическими документами из Zakononline с использованием MCP (Model Context Protocol) и веб-админкой.

## Структура проекта

```
SecondLayer/
├── mcp_backend/        # MCP сервер для работы с документами
├── frontend/           # Веб-админка (React + Refine + Ant Design)
├── .env                # Конфигурация (не в git)
└── package.json        # Root package.json
```

## Компоненты

### 1. MCP Backend (`mcp_backend/`)

Model Context Protocol сервер предоставляющий инструменты для:
- Поиска судебных решений
- Семантического анализа
- Работы с юридическими паттернами
- Валидации цитат

**Запуск:**
```bash
cd mcp_backend
npm install
npm run dev:http    # HTTP режим на порту 3000
```

Подробнее: [mcp_backend/README.md](mcp_backend/README.md)

### 2. Frontend Admin Panel (`frontend/`)

Современная админ-панель для управления документами.

**Технологии:**
- React 18
- Refine - фреймворк для админок
- Ant Design - UI компоненты
- Lucide React - иконки
- Vite - сборка

**Запуск:**
```bash
cd frontend
npm install
npm run dev         # Запуск на порту 5173
```

Подробнее: [frontend/README.md](frontend/README.md)

## Быстрый старт

### 1. Установка зависимостей

```bash
# MCP Backend
cd mcp_backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Конфигурация

Создайте `.env` файл в корне и в `mcp_backend/`:

```bash
# Root .env
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456

# mcp_backend/.env
DATABASE_URL=postgresql://user:password@localhost:5432/secondlayer
REDIS_HOST=localhost
QDRANT_URL=http://localhost:6333
OPENAI_API_KEY=your-key
ZAKONONLINE_API_TOKEN=your-token
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456
```

Frontend (уже настроен в `frontend/.env`):
```bash
VITE_API_URL=http://localhost:3000/api
VITE_SECONDARY_LAYER_KEY=test-key-123
```

### 3. Запуск

**Терминал 1 - Backend:**
```bash
cd mcp_backend
npm run dev:http
```

**Терминал 2 - Frontend:**
```bash
cd frontend  
npm run dev
```

Откройте http://localhost:5173

## Docker

Запуск через docker-compose:

```bash
cd mcp_backend
docker-compose up -d
```

## API

### MCP Mode
Используйте MCP SDK для подключения к серверу.

### HTTP Mode
- `GET /health` - Health check
- `POST /api/search` - Поиск документов
- `POST /api/analyze` - Анализ документа
- Авторизация: `Authorization: Bearer <SECONDARY_LAYER_KEY>`

## Разработка

### Структура

```
mcp_backend/
├── src/
│   ├── adapters/       # API адаптеры
│   ├── api/            # MCP endpoints
│   ├── database/       # БД
│   ├── services/       # Бизнес-логика
│   ├── index.ts        # MCP entry point
│   └── http-server.ts  # HTTP entry point

frontend/
├── src/
│   ├── pages/          # Страницы админки
│   ├── providers/      # Data providers
│   ├── styles/         # Темы и стили
│   └── App.tsx
```

### Технологии

**Backend:**
- TypeScript
- Model Context Protocol SDK
- PostgreSQL + Redis + Qdrant
- OpenAI API
- Express (HTTP mode)

**Frontend:**
- React + TypeScript
- Refine framework
- Ant Design 5
- Lucide icons
- Vite

## Документация

- [MCP Backend README](mcp_backend/README.md)
- [Frontend README](frontend/README.md)
- [Frontend Setup Guide](frontend/SETUP.md)
- [API Keys](KEYS.md)
- [Quick Start](START.md)

## Лицензия

MIT

## Авторы

SecondLayer Team
