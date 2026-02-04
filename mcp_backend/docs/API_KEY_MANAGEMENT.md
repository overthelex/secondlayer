# API Key Management System

Система управления API ключами для массового использования SecondLayer MCP сервиса.

## 🎯 Обзор

SecondLayer поддерживает **два типа аутентификации**:

### 1. Simple API Keys (SECONDARY_LAYER_KEYS)
- **Использование**: Быстрая настройка для dev/stage/prod
- **Хранение**: Environment variable
- **Ограничения**: Нет rate limiting, tracking, expiration
- **Подходит для**: Тестирования, малого числа клиентов

### 2. Database API Keys (таблица api_keys) ⭐
- **Использование**: Масштабируемая система для сотен пользователей
- **Хранение**: PostgreSQL
- **Возможности**:
  - ✅ Rate limiting (per minute/day)
  - ✅ Usage tracking
  - ✅ Expiration dates
  - ✅ User binding
  - ✅ Credit system integration
  - ✅ Per-key analytics

## 🔑 Формат API ключей

Генерируемые ключи имеют формат:
```
sl_<random32>_<checksum8>

Пример: sl_k2Lx5QAOIJwXxvF4q2azudZaiF1tocDR_9caebd71
```

- **Префикс `sl_`**: Идентифицирует SecondLayer keys
- **32 символа**: Случайная строка (base64 без специальных символов)
- **8 символов checksum**: MD5 хеш для валидации

## 🛠️ Методы создания API ключей

### Метод 1: CLI Tool (рекомендуется для массовой генерации)

#### Установка

```bash
cd mcp_backend
npm install
```

#### Примеры использования

**1. Создать ключ для одного пользователя:**
```bash
npm run create-api-keys -- --email user@example.com --name "Production Key"
```

**2. Создать несколько ключей для одного пользователя:**
```bash
npm run create-api-keys -- --email user@example.com --count 5 --name-prefix "Service"
# Создаст: Service #1, Service #2, Service #3, Service #4, Service #5
```

**3. Массовая генерация из CSV:**
```bash
npm run create-api-keys -- --batch users.csv
```

CSV формат:
```csv
email,name,description,expires_at
john@company.com,Production Key,Main API access,2025-12-31
jane@company.com,Test Key,Testing purposes,
admin@company.com,Admin Key,Full access,2026-06-30
```

**4. Список всех ключей:**
```bash
npm run create-api-keys -- --list
```

**5. Создать ключ с дополнительными параметрами:**
```bash
npm run create-api-keys -- \
  --email user@example.com \
  --name "Production Key" \
  --description "Main API access for production services" \
  --expires "2025-12-31"
```

### Метод 2: HTTP API (для веб-приложений)

#### Создать API ключ

```bash
POST /api/keys
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json

{
  "name": "My API Key",
  "description": "Description (optional)",
  "expiresAt": "2025-12-31T00:00:00Z" // optional
}
```

Ответ:
```json
{
  "success": true,
  "key": {
    "id": "uuid",
    "userId": "uuid",
    "key": "sl_k2Lx5QAOIJwXxvF4q2azudZaiF1tocDR_9caebd71",
    "name": "My API Key",
    "isActive": true,
    "createdAt": "2026-02-02T10:00:00Z"
  },
  "message": "API key created successfully. Save this key - it will not be shown again!"
}
```

⚠️ **ВАЖНО**: Ключ показывается только один раз при создании!

#### Список ключей пользователя

```bash
GET /api/keys
Authorization: Bearer <JWT_TOKEN>
```

Ответ (ключи замаскированы):
```json
{
  "success": true,
  "keys": [
    {
      "id": "uuid",
      "name": "Production Key",
      "key": "sl_k2Lx5QAO...d71",
      "isActive": true,
      "usageCount": 1523,
      "lastUsedAt": "2026-02-02T09:45:00Z",
      "createdAt": "2026-01-15T08:00:00Z"
    }
  ],
  "count": 1
}
```

#### Отозвать (деактивировать) ключ

```bash
DELETE /api/keys/:keyId
Authorization: Bearer <JWT_TOKEN>
```

### Метод 3: Direct SQL (для admin operations)

```sql
-- Создать ключ для пользователя
INSERT INTO api_keys (
  user_id,
  key,
  name,
  description,
  rate_limit_per_minute,
  rate_limit_per_day,
  expires_at
) VALUES (
  (SELECT id FROM users WHERE email = 'user@example.com'),
  generate_api_key(),
  'Production API Key',
  'Main access key for production services',
  120,  -- 120 requests per minute
  50000, -- 50000 requests per day
  '2025-12-31'::DATE
) RETURNING id, key;

-- Список всех ключей
SELECT
  u.email,
  ak.name,
  ak.is_active,
  ak.usage_count,
  ak.last_used_at,
  ak.created_at,
  substring(ak.key, 1, 12) || '...' as masked_key
FROM api_keys ak
JOIN users u ON u.id = ak.user_id
ORDER BY ak.created_at DESC;

-- Деактивировать ключ
UPDATE api_keys SET is_active = false WHERE id = '<key-id>';

-- Обновить лимиты
UPDATE api_keys
SET rate_limit_per_minute = 200,
    rate_limit_per_day = 100000
WHERE id = '<key-id>';
```

## 📊 Rate Limiting

### Настройка лимитов

Лимиты устанавливаются при создании ключа или могут быть изменены позже:

```sql
-- Default limits (при создании через CLI/API)
rate_limit_per_minute: 60    -- 60 запросов в минуту
rate_limit_per_day: 10000     -- 10,000 запросов в день
```

### Проверка лимитов

Система автоматически проверяет лимиты при каждом запросе:

```typescript
// В коде приложения
const rateLimitCheck = await apiKeyService.checkRateLimit(apiKey);

if (!rateLimitCheck.allowed) {
  return res.status(429).json({
    error: 'Rate limit exceeded',
    reason: rateLimitCheck.reason,
    limit: rateLimitCheck.rateLimitPerDay,
    current: rateLimitCheck.requestsToday
  });
}
```

### Мониторинг использования

```sql
-- Top users by API usage today
SELECT
  u.email,
  ak.name,
  ak.requests_today,
  ak.rate_limit_per_day,
  ROUND(ak.requests_today::DECIMAL / ak.rate_limit_per_day * 100, 2) as usage_percent
FROM api_keys ak
JOIN users u ON u.id = ak.user_id
WHERE ak.is_active = true
ORDER BY ak.requests_today DESC
LIMIT 10;

-- Keys approaching daily limit
SELECT
  u.email,
  ak.name,
  ak.requests_today,
  ak.rate_limit_per_day
FROM api_keys ak
JOIN users u ON u.id = ak.user_id
WHERE ak.is_active = true
  AND ak.requests_today > ak.rate_limit_per_day * 0.8
ORDER BY ak.requests_today DESC;
```

## 🔒 Использование API ключей

### В HTTP запросах

```bash
curl -H "Authorization: Bearer sl_k2Lx5QAOIJwXxvF4q2azudZaiF1tocDR_9caebd71" \
     https://stage.legal.org.ua/api/tools
```

### В Claude Desktop config

```json
{
  "mcpServers": {
    "secondlayer-stage": {
      "url": "https://stage.mcp.legal.org.ua/sse",
      "transport": {
        "type": "sse"
      },
      "headers": {
        "Authorization": "Bearer sl_k2Lx5QAOIJwXxvF4q2azudZaiF1tocDR_9caebd71"
      }
    }
  }
}
```

### В коде приложения

```typescript
import { MCP } from '@modelcontextprotocol/sdk';

const client = new MCP.Client({
  url: 'https://stage.legal.org.ua/sse',
  headers: {
    'Authorization': 'Bearer sl_k2Lx5QAOIJwXxvF4q2azudZaiF1tocDR_9caebd71'
  }
});
```

## 📈 Аналитика и мониторинг

### Статистика по ключам

```sql
-- Usage statistics per key
SELECT
  u.email,
  ak.name,
  ak.usage_count as total_requests,
  ak.last_used_at,
  DATE_PART('day', NOW() - ak.created_at) as days_active,
  ROUND(ak.usage_count / GREATEST(DATE_PART('day', NOW() - ak.created_at), 1)) as avg_requests_per_day
FROM api_keys ak
JOIN users u ON u.id = ak.user_id
WHERE ak.is_active = true
ORDER BY ak.usage_count DESC;
```

### Cost tracking (интеграция с billing)

```sql
-- API costs per user (last 30 days)
SELECT
  u.email,
  COUNT(ct.id) as request_count,
  SUM(ct.total_cost_usd) as total_cost_usd,
  AVG(ct.total_cost_usd) as avg_cost_per_request
FROM cost_tracking ct
JOIN users u ON u.id = ct.user_id
WHERE ct.created_at >= NOW() - INTERVAL '30 days'
  AND ct.status = 'completed'
GROUP BY u.email
ORDER BY total_cost_usd DESC;
```

## 🚀 Масштабирование для сотен пользователей

### Пример: Создать 100 ключей

**1. Подготовить CSV файл:**
```bash
# Генерация CSV для 100 пользователей
echo "email,name,description" > users-batch.csv
for i in {1..100}; do
  echo "user${i}@company.com,API Key ${i},Production access" >> users-batch.csv
done
```

**2. Массовое создание:**
```bash
npm run create-api-keys -- --batch users-batch.csv
```

**3. Результат сохраняется в JSON:**
```json
{
  "success": [
    {
      "id": "uuid",
      "userId": "uuid",
      "key": "sl_...",
      "name": "API Key 1",
      "userEmail": "user1@company.com",
      "createdAt": "2026-02-02T10:00:00Z"
    },
    // ... 99 more keys
  ],
  "failed": []
}
```

### Performance considerations

- ✅ Функция `generate_api_key()` оптимизирована для bulk operations
- ✅ Индексы на `api_keys.key` и `api_keys.user_id`
- ✅ Rate limit check использует PostgreSQL function (быстро)
- ✅ Daily counters автоматически сбрасываются

## 🔧 Настройка Stage окружения

### 1. Убедитесь, что миграция выполнена

```bash
ssh mail "docker exec secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage -c '\\df generate_api_key'"
```

Должна вернуть функцию `generate_api_key`.

### 2. Создайте тестового пользователя (если нужно)

```bash
ssh mail "docker exec -i secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage" <<EOF
INSERT INTO users (email, name, password_hash, email_verified)
VALUES (
  'test@example.com',
  'Test User',
  'not-used-for-api-keys',
  true
)
ON CONFLICT (email) DO NOTHING
RETURNING id, email;
EOF
```

### 3. Создайте API ключ

```bash
# Локально (подключается к stage БД через SSH tunnel)
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5434  # stage port
export POSTGRES_DB=secondlayer_stage
export POSTGRES_USER=secondlayer
export POSTGRES_PASSWORD=<stage-password>

npm run create-api-keys -- --email test@example.com --name "Test Key"
```

## 📝 Best Practices

### Безопасность

1. **Никогда не коммитьте API ключи в git**
   - Добавьте `*.keys.json` в `.gitignore`
   - Используйте environment variables или secure vaults

2. **Ротация ключей**
   - Установите expiration date для production ключей
   - Регулярно ротируйте ключи (раз в 3-6 месяцев)

3. **Rate limiting**
   - Настройте адекватные лимиты для каждого use case
   - Мониторьте usage для выявления аномалий

### Мониторинг

1. **Отслеживайте неактивные ключи**
```sql
SELECT email, name, last_used_at
FROM api_keys ak
JOIN users u ON u.id = ak.user_id
WHERE is_active = true
  AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '30 days');
```

2. **Alert на достижение лимитов**
   - Настройте уведомления когда `requests_today > rate_limit_per_day * 0.9`

3. **Cost monitoring**
   - Отслеживайте расходы per user через `cost_tracking` таблицу

## 🆘 Troubleshooting

### Ключ не работает (401 Unauthorized)

1. Проверьте формат: `Authorization: Bearer sl_...`
2. Убедитесь, что ключ активен:
```sql
SELECT is_active, expires_at FROM api_keys WHERE key = 'sl_...';
```
3. Проверьте rate limits:
```sql
SELECT * FROM check_api_key_rate_limit('sl_...');
```

### Функция generate_api_key не существует

```bash
# Установите pgcrypto extension
ssh mail "docker exec secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'"

# Создайте функцию
cat /home/vovkes/SecondLayer/mcp_backend/src/migrations/015_add_api_keys.sql | \
ssh mail "docker exec -i secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage"
```

### CLI tool не работает

```bash
# Проверьте NODE_ENV и database connection
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5434
export POSTGRES_DB=secondlayer_stage
export POSTGRES_PASSWORD=<password>

# Используйте SSH tunnel если нужен удаленный доступ
ssh -L 5434:localhost:5434 mail
```

## 📚 Дополнительные ресурсы

- [Dual Auth Middleware](/src/middleware/dual-auth.ts) - Логика аутентификации
- [ApiKeyService](/src/services/api-key-service.ts) - CRUD операции
- [API Key Routes](/src/routes/api-key-routes.ts) - HTTP endpoints
- [Migration 015](/src/migrations/015_add_api_keys.sql) - Database schema
