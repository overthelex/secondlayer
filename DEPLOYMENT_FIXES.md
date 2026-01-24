# Виправлення помилок деплою MCP Backend (Local Environment)

## Дата: 2026-01-24

## Проблеми та рішення

### 1. ❌ Помилка UTF-8 кодування
**Проблема:**
```
error: Unterminated string in JSON at position 137
SyntaxError: Unterminated string in JSON at position 137
```

**Причина:** Express body-parser обрізав UTF-8 символи при парсингу JSON з українським текстом.

**Рішення:**
```typescript
// mcp_backend/src/http-server.ts
this.app.use(express.json({ 
  limit: '10mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
```

**Статус:** ✅ Виправлено

---

### 2. ❌ Невалідний ID моделі OpenAI
**Проблема:**
```
error: OpenAI operation failed after 6 attempts: 400 invalid model ID
```

**Причина:** Використовувалися скорочені назви моделей (`gpt-4o`, `gpt-4o-mini`) замість повних версій.

**Рішення:**
Оновлено `.tmp/secondlayer-local.env`:
```bash
OPENAI_MODEL_QUICK=gpt-4o-mini-2024-07-18
OPENAI_MODEL_STANDARD=gpt-4o-mini-2024-07-18
OPENAI_MODEL_DEEP=gpt-4o-2024-08-06
```

**Статус:** ✅ Виправлено

---

### 3. ❌ Помилка автентифікації API ключів
**Проблема:**
```
warn: Authentication failed {"error":"Invalid API key"}
```

**Причина:** `SECONDARY_LAYER_KEYS` читалися при ініціалізації модуля, а не динамічно з environment variables.

**Рішення:**
```typescript
// mcp_backend/src/middleware/dual-auth.ts
function getSecondaryLayerKeys(): string[] {
  const keys = process.env.SECONDARY_LAYER_KEYS?.split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0) || [];
  return keys;
}

function authenticateWithAPIKey(req: AuthenticatedRequest, apiKey: string): void {
  const validKeys = getSecondaryLayerKeys(); // Динамічне читання
  if (!validKeys.includes(apiKey)) {
    throw new Error('Invalid API key');
  }
  // ...
}
```

**Статус:** ✅ Виправлено

---

### 4. ❌ Помилки підключення до PostgreSQL
**Проблема:**
```
error: Database connection failed: Connection terminated due to connection timeout
error: password authentication failed for user "secondlayer"
```

**Причина:** Неправильні credentials та ім'я хосту контейнера.

**Рішення:**
```bash
POSTGRES_HOST=secondlayer-postgres-local  # Не postgres-local
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=local_dev_password      # Не secondlayer_password
POSTGRES_DB=secondlayer_local
```

**Статус:** ✅ Виправлено

---

## Створені файли

### 1. Скрипт деплою
**Файл:** `/home/vovkes/SecondLayer-1/deploy-mcp-local.sh`

**Використання:**
```bash
./deploy-mcp-local.sh
```

**Функції:**
- Збірка TypeScript коду
- Створення Docker image
- Зупинка старого контейнера
- Налаштування мережі
- Запуск нового контейнера з правильними змінними оточення
- Перевірка статусу

---

## Конфігурація environment

### Обов'язкові змінні в `.tmp/secondlayer-local.env`:

```bash
***REMOVED***
OPENAI_API_KEY=sk-proj-...
OPENAI_API_KEY2=sk-proj-...

# OpenAI Models (повні версії!)
OPENAI_MODEL_QUICK=gpt-4o-mini-2024-07-18
OPENAI_MODEL_STANDARD=gpt-4o-mini-2024-07-18
OPENAI_MODEL_DEEP=gpt-4o-2024-08-06

# Zakononline API
ZAKONONLINE_API_TOKEN=...
ZAKONONLINE_API_TOKEN2=...

# Authentication
SECONDARY_LAYER_KEYS=REDACTED_SL_KEY_LOCAL,test-key-123

# Database (автоматично додаються в deploy скрипті)
POSTGRES_HOST=secondlayer-postgres-local
POSTGRES_PORT=5432
POSTGRES_DB=secondlayer_local
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=local_dev_password

# Qdrant
QDRANT_URL=http://secondlayer-qdrant-local:6333
```

---

## Тестування

### 1. Перевірка здоров'я сервера
```bash
curl http://localhost:3000/health
```

**Очікуваний результат:**
```json
{
  "status": "ok",
  "service": "secondlayer-mcp-http",
  "version": "1.0.0"
}
```

### 2. Тест UTF-8 кодування
```bash
curl -X POST http://localhost:3000/api/tools/get_legal_advice \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Authorization: Bearer REDACTED_SL_KEY_LOCAL" \
  -d '{
    "query": "Яка позиція Верховного Суду щодо поновлення строку на апеляційне оскарження?",
    "reasoning_budget": "quick"
  }'
```

**Очікуваний результат:** HTTP 200, без помилок "Unterminated string"

---

## Команди управління

```bash
# Деплой/Редеплой
./deploy-mcp-local.sh

# Перегляд логів
docker logs -f secondlayer-app-local

# Перезапуск
docker restart secondlayer-app-local

# Зупинка
docker stop secondlayer-app-local

# Видалення
docker rm -f secondlayer-app-local
```

---

## Статус виправлень

| Проблема | Статус | Файл |
|----------|--------|------|
| UTF-8 кодування | ✅ Виправлено | `mcp_backend/src/http-server.ts` |
| OpenAI model ID | ✅ Виправлено | `.tmp/secondlayer-local.env` |
| API ключі | ✅ Виправлено | `mcp_backend/src/middleware/dual-auth.ts` |
| PostgreSQL підключення | ✅ Виправлено | `deploy-mcp-local.sh` |
| Deployment script | ✅ Створено | `deploy-mcp-local.sh` |

---

## Перевірено

- ✅ Збірка без помилок
- ✅ Деплой без помилок
- ✅ UTF-8 текст обробляється правильно
- ✅ Автентифікація працює
- ✅ Підключення до БД успішне
- ✅ OpenAI API працює з правильними моделями

---

## Примітки

1. **Redis:** Контейнер не підключений, але сервер працює без кешу (це нормально для dev)
2. **Google OAuth2:** Не налаштовано, але це опціонально для API endpoints
3. **Qdrant:** Може бути unhealthy, але це не критично для базової роботи

---

**Всі критичні помилки виправлені. Система готова до використання в local environment.**
