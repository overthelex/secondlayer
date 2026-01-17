# Начните здесь - SecondLayer

## Структура проекта

```
SecondLayer/
├── mcp_backend/    # MCP сервер (из Docker контейнера)
├── frontend/       # Админ-панель (React + Refine)
├── .env            # Конфигурация
└── README.md       # Документация
```

## Быстрый старт

### 1. Backend MCP сервер

```bash
cd mcp_backend
npm install
npm run dev:http
```

Сервер запустится на http://localhost:3000

### 2. Frontend админка

В новом терминале:

```bash
cd frontend
npm run dev
```

Откройте http://localhost:5173

### 3. Проверка

- Backend health: http://localhost:3000/health
- Frontend: http://localhost:5173
- API ключ уже настроен в `frontend/.env`

## Ключи авторизации

```
VITE_SECONDARY_LAYER_KEY=test-key-123
```

Ключ уже настроен в `frontend/.env` и работает с backend.

## Документация

- **README.md** - общее описание проекта
- **mcp_backend/README.md** - документация MCP сервера
- **frontend/README.md** - документация админки
- **MIGRATION_SUMMARY.md** - детали миграции
- **KEYS.md** - информация о ключах

## Что изменилось

✅ MCP сервер перенесен в `mcp_backend/`  
✅ Удалены временные и дублирующиеся файлы  
✅ Создана чистая структура проекта  
✅ Настроена авторизация между frontend и backend  

## Docker контейнер

Актуальный код из контейнера `56522ea5ede8` скопирован в `mcp_backend/`.

Контейнер продолжает работать. Для пересборки:

```bash
cd mcp_backend
docker-compose up -d --build
```

## Нужна помощь?

1. Backend не запускается? Проверьте .env в `mcp_backend/`
2. Frontend показывает 401? Проверьте что backend запущен
3. Нет подключения к БД? Запустите `docker-compose up -d` в mcp_backend

---

**Готово! Можете начинать работу.**
