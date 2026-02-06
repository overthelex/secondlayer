# 🔐 OAuth 2.0 для ChatGPT - Полная реализация

## ✅ Что сделано

Создана **полная реализация OAuth 2.0 Authorization Server** для интеграции SecondLayer MCP с ChatGPT Web согласно [официальной документации OpenAI](https://platform.openai.com/docs/mcp).

---

## 📦 Компоненты

### Backend Code (TypeScript)
- ✅ **oauth-service.ts** - OAuth 2.0 сервис (350 строк)
- ✅ **oauth-routes.ts** - OAuth endpoints (450 строк)
- ✅ **oauth-auth.ts** - Middleware для аутентификации (120 строк)
- ✅ **014_add_oauth_tables.sql** - Database migration (3 таблицы)
- ✅ **http-server.ts** - Обновлен с поддержкой OAuth

### Utility Scripts
- ✅ **register-oauth-client.ts** - Регистрация ChatGPT клиента
- ✅ **set-user-password.ts** - Установка пароля пользователю

### Deployment Scripts
- ✅ **deploy-oauth-stage.sh** - Автоматический деплой OAuth на Stage
- ✅ **set-password-stage.sh** - Установка пароля на Stage сервере

### Documentation
- ✅ **OAUTH_INTEGRATION_GUIDE.md** - Полная документация (16 страниц)
- ✅ **OAUTH_QUICK_START.md** - Быстрый старт (6 шагов)
- ✅ **OAUTH_SUMMARY.md** - Техническая сводка
- ✅ **OAUTH_README.md** - Этот файл

---

## 🚀 Автоматический деплой

### Вариант 1: Одной командой (рекомендуется)

```bash
cd /home/vovkes/SecondLayer/deployment
./deploy-oauth-stage.sh
```

Этот скрипт автоматически:
1. ✅ Проверит SSH подключение
2. ✅ Скопирует миграцию на сервер
3. ✅ Применит миграцию к базе данных
4. ✅ Обновит код (git pull)
5. ✅ Пересоберет backend
6. ✅ Перезапустит контейнер
7. ✅ Зарегистрирует OAuth клиента
8. ✅ Сохранит credentials в файл

**Результат:**
- OAuth endpoints доступны на `https://stage.legal.org.ua/oauth/*`
- Client credentials сохранены в `oauth-credentials-stage.txt`

### Вариант 2: Пошагово (для отладки)

См. [OAUTH_QUICK_START.md](./OAUTH_QUICK_START.md)

---

## 🔑 После деплоя

### Установить пароль пользователю

```bash
cd /home/vovkes/SecondLayer/deployment
./set-password-stage.sh igor@legal.org.ua REDACTED_USER_PASSWORD
```

### Проверить работу OAuth

```bash
# 1. Test authorization endpoint
curl -I "https://stage.legal.org.ua/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=https://chatgpt.com/aip/callback"

# Expected: HTTP 200 OK

# 2. Test OAuth login page (открыть в браузере)
open "https://stage.legal.org.ua/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=https://chatgpt.com/aip/callback&scope=mcp"
```

---

## 📝 Конфигурация ChatGPT

После деплоя, настройте ChatGPT Web:

### Settings → Apps → New App (BETA)

```yaml
Name: SecondLayer Legal AI

Description: |
  Ukrainian legal AI with 43 MCP tools: court cases search,
  legislation lookup, Parliament data, State Register queries.
  Semantic search and AI-powered legal analysis.

MCP Server URL: https://stage.legal.org.ua/sse

Authentication: OAuth
```

### OAuth Settings:

```yaml
Client ID: [из deploy-oauth-stage.sh output или oauth-credentials-stage.txt]

Client Secret: [из deploy-oauth-stage.sh output или oauth-credentials-stage.txt]

Authorization URL: https://stage.legal.org.ua/oauth/authorize

Token URL: https://stage.legal.org.ua/oauth/token

Scopes: mcp
```

### User Login:

```yaml
Email: igor@legal.org.ua
Password: REDACTED_USER_PASSWORD  # Из set-password-stage.sh
```

---

## 🧪 Тестирование

### 1. Test Authorization Page

Откройте в браузере (замените YOUR_CLIENT_ID):
```
https://stage.legal.org.ua/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=https://chatgpt.com/aip/callback&scope=mcp&state=test123
```

Вы должны увидеть красивую страницу логина с фиолетовым градиентом.

### 2. Test Full OAuth Flow (manual)

```bash
# Step 1: Get authorization code (через браузер выше)
# User logs in → redirects to ChatGPT with ?code=...

# Step 2: Exchange code for token
curl -X POST "https://stage.legal.org.ua/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "CODE_FROM_STEP_1",
    "redirect_uri": "https://chatgpt.com/aip/callback",
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET"
  }'

# Expected Response:
# {
#   "access_token": "mcp_token_...",
#   "token_type": "Bearer",
#   "expires_in": 2592000
# }
```

### 3. Test SSE with OAuth Token

```bash
curl -N "https://stage.legal.org.ua/sse" \
  -H "Authorization: Bearer mcp_token_YOUR_ACCESS_TOKEN" \
  -H "Accept: text/event-stream"

# Expected: SSE stream starts
```

### 4. Test API Call with OAuth Token

```bash
curl -X POST "https://stage.legal.org.ua/api/tools/search_court_cases" \
  -H "Authorization: Bearer mcp_token_YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "позовна заява"}'

# Expected: JSON with court cases
```

---

## 📁 Структура файлов

```
SecondLayer/
├── mcp_backend/
│   ├── src/
│   │   ├── services/
│   │   │   └── oauth-service.ts              ✨ NEW
│   │   ├── routes/
│   │   │   └── oauth-routes.ts               ✨ NEW
│   │   ├── middleware/
│   │   │   └── oauth-auth.ts                 ✨ NEW
│   │   ├── migrations/
│   │   │   └── 014_add_oauth_tables.sql      ✨ NEW
│   │   ├── scripts/
│   │   │   ├── register-oauth-client.ts      ✨ NEW
│   │   │   └── set-user-password.ts          ✨ NEW
│   │   └── http-server.ts                    ✨ UPDATED
│   │
│   └── http-server-oauth.patch              📝 Patch file
│
└── deployment/
    ├── deploy-oauth-stage.sh                 ✨ NEW
    ├── set-password-stage.sh                 ✨ NEW
    ├── oauth-credentials-stage.txt           📝 Generated
    ├── OAUTH_INTEGRATION_GUIDE.md            📚 Full guide
    ├── OAUTH_QUICK_START.md                  📚 Quick start
    ├── OAUTH_SUMMARY.md                      📚 Summary
    └── OAUTH_README.md                       📚 This file
```

---

## 🔄 OAuth 2.0 Flow Diagram

```
┌──────────┐                                        ┌──────────────┐
│ ChatGPT  │                                        │ MCP Backend  │
│  Client  │                                        │ (Stage)      │
└────┬─────┘                                        └──────┬───────┘
     │                                                      │
     │  1. User clicks "Connect MCP" in ChatGPT            │
     │  ──────────────────────────────────────────────>    │
     │                                                      │
     │  2. Redirect to Authorization URL                   │
     │     GET /oauth/authorize?                           │
     │         response_type=code&                         │
     │         client_id=...&                              │
     │         redirect_uri=...                            │
     │  ──────────────────────────────────────────────>    │
     │                                                      │
     │  3. Show login form (HTML page)                     │
     │     - Email input                                   │
     │     - Password input                                │
     │  <──────────────────────────────────────────────    │
     │                                                      │
     │  4. User enters credentials and submits             │
     │     POST /oauth/authorize                           │
     │  ──────────────────────────────────────────────>    │
     │                                                      │
     │  5. Validate credentials & generate code            │
     │     Redirect to:                                    │
     │     https://chatgpt.com/aip/callback?code=XXX       │
     │  <──────────────────────────────────────────────    │
     │                                                      │
     │  6. Exchange code for access token                  │
     │     POST /oauth/token                               │
     │     {                                               │
     │       "grant_type": "authorization_code",           │
     │       "code": "XXX",                                │
     │       "client_id": "...",                           │
     │       "client_secret": "..."                        │
     │     }                                               │
     │  ──────────────────────────────────────────────>    │
     │                                                      │
     │  7. Return access token                             │
     │     {                                               │
     │       "access_token": "mcp_token_XXX",              │
     │       "token_type": "Bearer",                       │
     │       "expires_in": 2592000                         │
     │     }                                               │
     │  <──────────────────────────────────────────────    │
     │                                                      │
     │  8. Access MCP Server with token                    │
     │     POST /sse                                       │
     │     Authorization: Bearer mcp_token_XXX             │
     │  ──────────────────────────────────────────────>    │
     │                                                      │
     │  9. SSE stream with MCP tools                       │
     │  <══════════════════════════════════════════════    │
     │                                                      │
```

---

## 🔐 Безопасность

### Встроенные механизмы защиты:

- ✅ **Authorization Code Flow** - Безопасный OAuth 2.0 flow
- ✅ **Short-lived codes** - Authorization codes живут 10 минут
- ✅ **One-time codes** - Каждый code можно использовать только раз
- ✅ **Long-lived tokens** - Access tokens живут 30 дней
- ✅ **Token revocation** - Токены можно отозвать в любой момент
- ✅ **Password hashing** - bcrypt с 10 rounds
- ✅ **HTTPS only** - OAuth работает только по HTTPS
- ✅ **Client authentication** - Client secret проверяется при token exchange
- ✅ **Redirect URI validation** - Только зарегистрированные redirect URIs
- ✅ **Auto cleanup** - Expired codes/tokens удаляются автоматически

### Рекомендации:

1. **Храните Client Secret в безопасности** - никогда не коммитьте в Git
2. **Используйте сильные пароли** - минимум 12 символов
3. **Регулярно обновляйте пароли** - раз в 3-6 месяцев
4. **Мониторьте логи** - проверяйте подозрительную активность
5. **Периодическая очистка** - запускайте `cleanup_expired_oauth_data()` ежедневно

---

## 🐛 Troubleshooting

### "Migration already applied"
```
⚠️  Это нормально! Миграция идемпотентна.
```

### "Cannot connect to SSH"
```bash
# Проверьте SSH ключи
ssh root@mail.lexapp.co.ua

# Если не работает, добавьте ключ
ssh-copy-id root@mail.lexapp.co.ua
```

### "OAuth client registration failed"
```bash
# Проверьте, что миграция применена
ssh root@mail.lexapp.co.ua
docker exec -i secondlayer-postgres-stage psql \
  -U secondlayer -d secondlayer_stage \
  -c "SELECT * FROM oauth_clients;"
```

### "Invalid redirect_uri"
```bash
# Проверьте зарегистрированные URIs
docker exec -i secondlayer-postgres-stage psql \
  -U secondlayer -d secondlayer_stage \
  -c "SELECT client_id, redirect_uris FROM oauth_clients;"

# Должно быть: ["https://chatgpt.com/aip/callback", ...]
```

### "Password authentication not enabled"
```bash
# Установите пароль
cd /home/vovkes/SecondLayer/deployment
./set-password-stage.sh igor@legal.org.ua YourPassword
```

---

## 📞 Support

При возникновении проблем:

1. **Проверьте логи:**
   ```bash
   ssh root@mail.lexapp.co.ua
   docker logs secondlayer-app-stage --tail 100
   ```

2. **Проверьте базу данных:**
   ```bash
   docker exec -i secondlayer-postgres-stage psql \
     -U secondlayer -d secondlayer_stage \
     -c "SELECT * FROM oauth_clients;"
   ```

3. **Проверьте endpoints:**
   ```bash
   curl -I https://stage.legal.org.ua/oauth/authorize
   curl -I https://stage.legal.org.ua/oauth/token
   ```

4. **Прочитайте документацию:**
   - `OAUTH_INTEGRATION_GUIDE.md` - Подробный гайд
   - `OAUTH_QUICK_START.md` - Быстрый старт
   - `OAUTH_SUMMARY.md` - Техническая документация

---

## 🎯 Следующие шаги

1. ✅ **Deploy OAuth** - Запустите `./deploy-oauth-stage.sh`
2. ✅ **Set Password** - Запустите `./set-password-stage.sh igor@legal.org.ua Password123`
3. ✅ **Test OAuth** - Откройте authorization URL в браузере
4. ✅ **Configure ChatGPT** - Добавьте credentials в ChatGPT Settings
5. ✅ **Test Integration** - Попробуйте использовать MCP tools в ChatGPT
6. ✅ **Monitor Logs** - Следите за логами на предмет ошибок
7. ✅ **Setup Cleanup** - Настройте cron job для cleanup expired data

---

## 🎉 Готово!

OAuth 2.0 интеграция полностью готова к использованию. ChatGPT теперь может безопасно подключаться к вашему MCP серверу через OAuth 2.0 Authorization Code Flow.

**Все необходимые файлы созданы и готовы к deployment!**

Запустите: `./deploy-oauth-stage.sh` 🚀
