# OAuth 2.0 Quick Start для ChatGPT

Быстрый гайд по настройке OAuth 2.0 для интеграции с ChatGPT Web.

## 📦 Что нужно сделать

### 1. Применить миграцию (создать таблицы OAuth)

**На Stage сервере:**
```bash
ssh root@mail.lexapp.co.ua

# Скопировать миграцию
cd /root/SecondLayer
git pull origin main

# Применить миграцию
docker exec -i secondlayer-postgres-stage psql \
  -U secondlayer \
  -d secondlayer_stage \
  -f /app/mcp_backend/src/migrations/014_add_oauth_tables.sql
```

**Или с локальной машины:**
```bash
cd /home/vovkes/SecondLayer

# Скопировать миграцию на сервер
scp mcp_backend/src/migrations/014_add_oauth_tables.sql \
  root@mail.lexapp.co.ua:/tmp/

# Выполнить на сервере
ssh root@mail.lexapp.co.ua \
  "docker exec -i secondlayer-postgres-stage psql \
   -U secondlayer -d secondlayer_stage -f /tmp/014_add_oauth_tables.sql"
```

### 2. Зарегистрировать OAuth клиента

**На локальной машине (для тестирования):**
```bash
cd /home/vovkes/SecondLayer/mcp_backend
npm run build
npx tsx src/scripts/register-oauth-client.ts
```

**Сохраните вывод!** Вам нужны:
- `client_id`
- `client_secret`

### 3. Установить пароль пользователю igor@legal.org.ua

```bash
cd /home/vovkes/SecondLayer/mcp_backend
npx tsx src/scripts/set-user-password.ts igor@legal.org.ua REDACTED_USER_PASSWORD
```

**Запишите пароль!** Вам понадобится для входа через OAuth форму.

### 4. Обновить код http-server.ts

**Добавьте импорты (после строки 48):**
```typescript
import { createOAuthRouter } from './routes/oauth-routes.js';
import { createHybridAuthMiddleware } from './middleware/oauth-auth.js';
```

**Добавьте OAuth роуты в `setupRoutes()` (после строки 663):**
```typescript
// OAuth 2.0 endpoints for ChatGPT integration (public)
this.app.use('/oauth', createOAuthRouter(this.db));
logger.info('OAuth 2.0 routes registered at /oauth');
```

**Обновите SSE endpoint (строка 241):**

**Было:**
```typescript
this.app.post('/sse', (async (req: DualAuthRequest, res: Response) => {
  // ... authentication code ...
```

**Стало:**
```typescript
this.app.post('/sse', createHybridAuthMiddleware(this.db), (async (req: any, res: Response) => {
  const userId = req.userId; // From OAuth or undefined
  // ... rest of SSE code ...
```

### 5. Deploy на Stage

```bash
cd /home/vovkes/SecondLayer

# Закоммитить изменения
git add .
git commit -m "Add OAuth 2.0 support for ChatGPT integration"
git push origin main

# Deploy на stage
ssh root@mail.lexapp.co.ua
cd /root/SecondLayer
git pull origin main
cd deployment
./update-stage-backend-on-mail.sh

# Restart app
docker restart secondlayer-app-stage
```

### 6. Проверить работу

```bash
# Test authorization endpoint
curl -I "https://stage.legal.org.ua/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=https://chatgpt.com/aip/callback"

# Expected: HTTP 200
```

---

## 🎯 Конфигурация ChatGPT

Откройте ChatGPT → Settings → Apps → New App:

### Базовая информация:
```
Name: SecondLayer Legal AI

MCP Server URL: https://stage.legal.org.ua/sse

Authentication: OAuth
```

### OAuth настройки:
```
Client ID: [из шага 2]

Client Secret: [из шага 2]

Authorization URL: https://stage.legal.org.ua/oauth/authorize

Token URL: https://stage.legal.org.ua/oauth/token

Scopes: mcp
```

### Логин:
```
Email: igor@legal.org.ua
Password: REDACTED_USER_PASSWORD [из шага 3]
```

---

## 🧪 Быстрый тест

### 1. Проверка Authorization URL

Откройте в браузере:
```
https://stage.legal.org.ua/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=https://chatgpt.com/aip/callback&scope=mcp
```

Вы должны увидеть красивую форму логина.

### 2. Test full OAuth flow

```bash
# Это сделает ChatGPT автоматически, но можно протестировать вручную:

# Step 1: Get authorization code (через браузер)
# Step 2: Exchange for token
curl -X POST "https://stage.legal.org.ua/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "CODE_FROM_STEP_1",
    "redirect_uri": "https://chatgpt.com/aip/callback",
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET"
  }'

# Expected: {"access_token": "mcp_token_...", "token_type": "Bearer", "expires_in": 2592000}
```

---

## 📋 Чеклист

- [ ] **Миграция применена** - OAuth таблицы созданы
- [ ] **OAuth клиент зарегистрирован** - client_id/secret сохранены
- [ ] **Пароль установлен** - igor@legal.org.ua имеет пароль
- [ ] **Код обновлён** - OAuth роуты и hybrid middleware добавлены
- [ ] **Backend задеплоен** - Stage сервер перезапущен
- [ ] **Тест пройден** - Authorization URL работает
- [ ] **ChatGPT настроен** - OAuth credentials добавлены

---

## 📁 Файлы для копирования на Stage

Если Stage сервер не имеет доступа к Git, скопируйте эти файлы вручную:

```bash
# 1. OAuth service
scp mcp_backend/src/services/oauth-service.ts \
  root@mail.lexapp.co.ua:/root/SecondLayer/mcp_backend/src/services/

# 2. OAuth routes
scp mcp_backend/src/routes/oauth-routes.ts \
  root@mail.lexapp.co.ua:/root/SecondLayer/mcp_backend/src/routes/

# 3. OAuth middleware
scp mcp_backend/src/middleware/oauth-auth.ts \
  root@mail.lexapp.co.ua:/root/SecondLayer/mcp_backend/src/middleware/

# 4. Migration
scp mcp_backend/src/migrations/014_add_oauth_tables.sql \
  root@mail.lexapp.co.ua:/root/SecondLayer/mcp_backend/src/migrations/

# 5. Scripts
scp mcp_backend/src/scripts/register-oauth-client.ts \
  root@mail.lexapp.co.ua:/root/SecondLayer/mcp_backend/src/scripts/

scp mcp_backend/src/scripts/set-user-password.ts \
  root@mail.lexapp.co.ua:/root/SecondLayer/mcp_backend/src/scripts/
```

---

## 🐛 Troubleshooting

### "Migration file not found"
```bash
# Проверьте, что файл существует
ssh root@mail.lexapp.co.ua "ls -la /root/SecondLayer/mcp_backend/src/migrations/014_add_oauth_tables.sql"

# Если нет - скопируйте вручную
scp mcp_backend/src/migrations/014_add_oauth_tables.sql \
  root@mail.lexapp.co.ua:/root/SecondLayer/mcp_backend/src/migrations/
```

### "Cannot find module oauth-routes"
```bash
# Rebuild backend
ssh root@mail.lexapp.co.ua "cd /root/SecondLayer/deployment && ./update-stage-backend-on-mail.sh"
```

### "Invalid client_id"
```bash
# Проверьте, что клиент зарегистрирован
docker exec -i secondlayer-postgres-stage psql \
  -U secondlayer -d secondlayer_stage \
  -c "SELECT client_id, name FROM oauth_clients;"
```

---

**После всех шагов - готово к использованию в ChatGPT!** 🎉
