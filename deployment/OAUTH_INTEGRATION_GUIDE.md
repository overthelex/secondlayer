# OAuth 2.0 Integration Guide для ChatGPT MCP

Этот гайд описывает, как добавить OAuth 2.0 сервер в SecondLayer MCP backend для интеграции с ChatGPT Web.

## 📋 Что было создано

Я подготовил полную реализацию OAuth 2.0 Authorization Code Flow:

### 1. **OAuth Service** (`src/services/oauth-service.ts`)
- Управление OAuth клиентами
- Генерация authorization codes
- Обмен codes на access tokens
- Валидация access tokens

### 2. **OAuth Routes** (`src/routes/oauth-routes.ts`)
- `GET /oauth/authorize` - Authorization endpoint (страница логина)
- `POST /oauth/authorize` - Обработка формы авторизации
- `POST /oauth/token` - Token endpoint (обмен code на token)
- `POST /oauth/revoke` - Отзыв токенов

### 3. **OAuth Middleware** (`src/middleware/oauth-auth.ts`)
- `createOAuthMiddleware()` - Валидация OAuth токенов
- `createHybridAuthMiddleware()` - Поддержка OAuth + API keys

### 4. **Database Migration** (`src/migrations/014_add_oauth_tables.sql`)
- Таблица `oauth_clients` - Зарегистрированные OAuth клиенты
- Таблица `oauth_authorization_codes` - Временные authorization codes
- Таблица `oauth_access_tokens` - Access tokens для API
- Добавление `password_hash` в таблицу `users`

### 5. **Utility Scripts**
- `src/scripts/register-oauth-client.ts` - Регистрация OAuth клиента
- `src/scripts/set-user-password.ts` - Установка пароля пользователю

---

## 🚀 Установка

### Шаг 1: Запустить миграцию

```bash
cd /home/vovkes/SecondLayer/mcp_backend

# Применить миграцию на локальной БД
npm run migrate

# Или вручную через psql
psql -h localhost -p 5432 -U secondlayer -d secondlayer \
  -f src/migrations/014_add_oauth_tables.sql
```

**Для Stage окружения:**
```bash
# На сервере mail.lexapp.co.ua
docker exec -i secondlayer-postgres-stage psql \
  -U secondlayer -d secondlayer_stage \
  -f /app/src/migrations/014_add_oauth_tables.sql

# Или с локальной машины
ssh root@mail.lexapp.co.ua "docker exec -i secondlayer-postgres-stage psql \
  -U secondlayer -d secondlayer_stage" < mcp_backend/src/migrations/014_add_oauth_tables.sql
```

### Шаг 2: Зарегистрировать OAuth клиента

```bash
cd /home/vovkes/SecondLayer/mcp_backend

# Локально
npm run build
npx tsx src/scripts/register-oauth-client.ts

# На Stage сервере
ssh root@mail.lexapp.co.ua
cd /path/to/SecondLayer/mcp_backend
docker exec -it secondlayer-app-stage node dist/scripts/register-oauth-client.js
```

**Сохраните вывод!** Вам понадобятся `client_id` и `client_secret`.

### Шаг 3: Установить пароль пользователю

```bash
# Установить пароль для igor@legal.org.ua
npx tsx src/scripts/set-user-password.ts igor@legal.org.ua MySecurePassword123

# На Stage сервере
docker exec -it secondlayer-app-stage node dist/scripts/set-user-password.js \
  igor@legal.org.ua MySecurePassword123
```

### Шаг 4: Обновить `http-server.ts`

Добавьте следующий код в `src/http-server.ts`:

#### 4.1. Импорты (после строки 48)

```typescript
import { createOAuthRouter } from './routes/oauth-routes.js';
import { OAuthService } from './services/oauth-service.js';
import { createHybridAuthMiddleware } from './middleware/oauth-auth.js';
```

#### 4.2. В `setupRoutes()` метод (после строки 663)

```typescript
// OAuth 2.0 endpoints for ChatGPT integration (public)
this.app.use('/oauth', createOAuthRouter(this.db));
logger.info('OAuth 2.0 routes registered at /oauth');
```

#### 4.3. Обновить SSE endpoint (строка 241)

Заменить текущую аутентификацию на гибридную (OAuth + API keys).

**Найдите:**
```typescript
this.app.post('/sse', (async (req: DualAuthRequest, res: Response) => {
  // ... existing authentication code ...
```

**Замените на:**
```typescript
this.app.post('/sse', createHybridAuthMiddleware(this.db), (async (req: any, res: Response) => {
  // userId будет доступен в req.userId (если OAuth) или undefined (если API key)
  const userId = req.userId;
  const clientKey = req.clientId;

  // ... rest of SSE endpoint code ...
```

### Шаг 5: Rebuild и перезапуск

```bash
# Локально
cd /home/vovkes/SecondLayer/mcp_backend
npm run build
npm run dev:http

# На Stage сервере
ssh root@mail.lexapp.co.ua
cd /path/to/SecondLayer/deployment
./update-stage-backend-on-mail.sh
docker restart secondlayer-app-stage
```

---

## 🔧 Конфигурация ChatGPT

После установки OAuth сервера, настройте ChatGPT Web:

### В ChatGPT Settings → Apps → New App:

```
Name: SecondLayer Legal AI (Stage)

Description:
Ukrainian legal AI with 43 MCP tools for court cases, legislation,
Parliament data, and State Register queries.

MCP Server URL:
https://stage.legal.org.ua/sse

Authentication: OAuth
```

### OAuth Configuration:

```
Client ID: <client_id из register-oauth-client.ts>

Client Secret: <client_secret из register-oauth-client.ts>

Authorization URL:
https://stage.legal.org.ua/oauth/authorize

Token URL:
https://stage.legal.org.ua/oauth/token

Scopes: mcp
```

---

## 🧪 Тестирование OAuth Flow

### 1. Тест Authorization Endpoint

Откройте в браузере:
```
https://stage.legal.org.ua/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=https://chatgpt.com/aip/callback&scope=mcp&state=test123
```

Вы должны увидеть красивую страницу логина.

### 2. Тест Token Exchange

```bash
# Сначала получите authorization code через браузер (шаг 1)
# Затем обменяйте его на token:

curl -X POST "https://stage.legal.org.ua/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "YOUR_AUTH_CODE",
    "redirect_uri": "https://chatgpt.com/aip/callback",
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET"
  }'
```

**Ожидаемый ответ:**
```json
{
  "access_token": "mcp_token_...",
  "token_type": "Bearer",
  "expires_in": 2592000
}
```

### 3. Тест SSE с OAuth Token

```bash
curl -N -X GET "https://stage.legal.org.ua/sse" \
  -H "Authorization: Bearer mcp_token_..." \
  -H "Accept: text/event-stream"
```

### 4. Тест валидации токена

```bash
# Должен работать с OAuth токеном
curl -X POST "https://stage.legal.org.ua/api/tools/search_court_cases" \
  -H "Authorization: Bearer mcp_token_..." \
  -H "Content-Type: application/json" \
  -d '{"query": "позов"}'

# Должен работать с обычным API key
curl -X POST "https://stage.legal.org.ua/api/tools/search_court_cases" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD" \
  -H "Content-Type: application/json" \
  -d '{"query": "позов"}'
```

---

## 📊 Архитектура OAuth Flow

```
┌─────────────┐                 ┌──────────────────┐                 ┌─────────────┐
│  ChatGPT    │                 │  SecondLayer MCP │                 │   Database  │
│   Client    │                 │     Backend      │                 │ (Postgres)  │
└──────┬──────┘                 └────────┬─────────┘                 └──────┬──────┘
       │                                 │                                   │
       │  1. GET /oauth/authorize        │                                   │
       │  ────────────────────────────>  │                                   │
       │                                 │                                   │
       │  2. Show login form             │                                   │
       │  <────────────────────────────  │                                   │
       │                                 │                                   │
       │  3. POST /oauth/authorize       │                                   │
       │     (email + password)          │  4. Validate user                 │
       │  ────────────────────────────>  │  ───────────────────────────────>│
       │                                 │                                   │
       │                                 │  5. Generate auth code             │
       │                                 │  <───────────────────────────────│
       │                                 │                                   │
       │  6. Redirect with code          │                                   │
       │  <────────────────────────────  │                                   │
       │                                 │                                   │
       │  7. POST /oauth/token           │                                   │
       │     (code + client credentials) │  8. Validate code                 │
       │  ────────────────────────────>  │  ───────────────────────────────>│
       │                                 │                                   │
       │                                 │  9. Generate access token          │
       │                                 │  <───────────────────────────────│
       │                                 │                                   │
       │  10. Return access_token        │                                   │
       │  <────────────────────────────  │                                   │
       │                                 │                                   │
       │  11. POST /sse                  │                                   │
       │      (Bearer mcp_token_...)     │  12. Validate token               │
       │  ────────────────────────────>  │  ───────────────────────────────>│
       │                                 │                                   │
       │  13. SSE stream (MCP tools)     │                                   │
       │  <────────────────────────────  │                                   │
       │                                 │                                   │
```

---

## 🔐 Безопасность

### Важные моменты:

1. **Client Secret** - хранится только в БД и в конфигурации ChatGPT
2. **Authorization Code** - срок жизни 10 минут, одноразовый
3. **Access Token** - срок жизни 30 дней, можно отозвать
4. **Password Hash** - bcrypt с 10 rounds
5. **HTTPS Required** - OAuth работает только по HTTPS (stage/prod)

### Периодическая очистка:

Создайте cron job для очистки expired токенов:

```bash
# Каждый день в 3:00 AM
0 3 * * * psql -U secondlayer -d secondlayer_stage -c "SELECT cleanup_expired_oauth_data();"
```

Или добавьте в приложение:

```typescript
// В http-server.ts constructor
setInterval(() => {
  const oauthService = new OAuthService(this.db);
  oauthService.cleanupExpired().catch((err) =>
    logger.error('Failed to cleanup expired OAuth data:', err)
  );
}, 24 * 60 * 60 * 1000); // Once per day
```

---

## 📚 Ссылки

- **OpenAI MCP Docs**: https://platform.openai.com/docs/mcp
- **OAuth 2.0 RFC**: https://datatracker.ietf.org/doc/html/rfc6749
- **Authorization Code Flow**: https://oauth.net/2/grant-types/authorization-code/

---

## 🐛 Troubleshooting

### Проблема: "Invalid redirect_uri"
**Решение**: Проверьте, что redirect_uri в ChatGPT точно совпадает с зарегистрированным:
```sql
SELECT redirect_uris FROM oauth_clients WHERE client_id = 'YOUR_CLIENT_ID';
```

### Проблема: "Invalid authorization code"
**Решение**: Code истёк (10 минут) или уже использован. Получите новый code.

### Проблема: "Password authentication not enabled"
**Решение**: Установите пароль:
```bash
npx tsx src/scripts/set-user-password.ts igor@legal.org.ua MyPassword123
```

### Проблема: SSE не принимает OAuth токен
**Решение**: Убедитесь, что применили hybrid middleware в SSE endpoint:
```typescript
this.app.post('/sse', createHybridAuthMiddleware(this.db), ...);
```

---

## ✅ Чеклист готовности

- [ ] Миграция 014 применена
- [ ] OAuth клиент зарегистрирован
- [ ] Пароль установлен для пользователя
- [ ] OAuth роуты добавлены в http-server.ts
- [ ] SSE endpoint обновлён с hybrid auth
- [ ] Backend пересобран и перезапущен
- [ ] Authorization endpoint тестирован
- [ ] Token exchange работает
- [ ] SSE принимает OAuth токены
- [ ] ChatGPT настроен с правильными credentials

---

**Готово к интеграции с ChatGPT!** 🚀
