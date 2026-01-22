# SecondLayer MCP - Deployment Summary

## ✅ Що зроблено:

### 1. Створено конфігурації для віддаленого MCP підключення

**Файли:**
- `config-examples/remote-claude-desktop-config.json`
- `config-examples/remote-cursor-config.json`
- `config-examples/remote-vscode-config.json`

### 2. Написано повну документацію

- `config-examples/REMOTE_MCP_SETUP.md` - повний гайд
- `config-examples/GENERATE_TOKEN.md` - генерація JWT токенів
- `docs/MCP_TOOLS_SUMMARY.md` - список всіх 10 MCP інструментів

### 3. Розгорнуто SSE сервер на gate.lexapp.co.ua (доступний через mcp.legal.org.ua)

**Стан:**
✅ Docker контейнер secondlayer-app-prod запущено
✅ Працює на localhost:3001
✅ Health check відповідає: `{"status":"ok","service":"secondlayer-mcp-sse","version":"1.0.0","transport":"sse","tools":10}`
✅ Всі сервіси підключені: PostgreSQL, Redis, Qdrant

**Docker контейнери:**
```
secondlayer-app-prod      - Running (port 3001)
secondlayer-postgres-prod - Running (healthy)
secondlayer-redis-prod    - Running (healthy)
secondlayer-qdrant-prod   - Running
```

**Публічний endpoint:** https://mcp.legal.org.ua/mcp/sse

---

## 🔧 Що залишилося зробити:

### Останній крок: Налаштувати nginx

**Потрібно додати до nginx конфігурації mcp.legal.org.ua:**

Файл конфігурації вже підготовлено на сервері: `/tmp/mcp-nginx-legal.conf`

#### Варіант 1: Автоматично (якщо є доступ)

```bash
# На сервері gate.lexapp.co.ua:
sudo nano /etc/nginx/sites-available/mcp.legal.org.ua.conf

# Додати всередину server { ... } блоку вміст з /tmp/mcp-nginx-legal.conf
# Потім:
sudo nginx -t
sudo systemctl reload nginx
```

#### Варіант 2: Ручне додавання

Додайте ці location блоки до вашого nginx конфігу для `mcp.legal.org.ua`:

```nginx
# Health check endpoint
location /health {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# MCP SSE endpoint (primary)
location /mcp/sse {
    proxy_pass http://localhost:3001/v1/sse;
    proxy_http_version 1.1;

    # Critical for SSE!
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding off;

    # Headers
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Timeouts for long-lived connections
    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
    proxy_connect_timeout 60s;
}

# Optional: Alternative endpoint (v1/sse)
location /v1/sse {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;

    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding off;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
}
```

---

## 🧪 Тестування після налаштування nginx

### 1. Health check (публічний доступ):

```bash
curl https://mcp.legal.org.ua/health
```

**Очікувана відповідь:**
```json
{
  "status": "ok",
  "service": "secondlayer-mcp-sse",
  "version": "1.0.0",
  "transport": "sse",
  "tools": 10
}
```

### 2. Тест з JWT токеном:

Спочатку згенеруйте токен:

```bash
cd ~/secondlayer
npx tsx scripts/generate-jwt-token.ts test-client 90d
```

Потім протестуйте:

```bash
curl -X POST https://mcp.legal.org.ua/mcp/sse \
  -H "Authorization: Bearer YOUR-JWT-TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## 📋 Клієнтська конфігурація

Після налаштування nginx користувачі зможуть підключатися так:

### Claude Desktop

**Файл:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "secondlayer-remote": {
      "url": "https://mcp.legal.org.ua/mcp/sse",
      "headers": {
        "Authorization": "Bearer <JWT-TOKEN>"
      }
    }
  }
}
```

### Cursor IDE

**Файл:** `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "secondlayer-remote": {
      "url": "https://mcp.legal.org.ua/mcp/sse",
      "headers": {
        "Authorization": "Bearer <JWT-TOKEN>"
      }
    }
  }
}
```

### VSCode

**Файл:** `.vscode/mcp.json`

```json
{
  "mcpServers": {
    "secondlayer-remote": {
      "url": "https://mcp.legal.org.ua/mcp/sse",
      "headers": {
        "Authorization": "Bearer <JWT-TOKEN>"
      }
    }
  }
}
```

---

## 🔐 Генерація JWT токенів для клієнтів

```bash
# На сервері gate.lexapp.co.ua:
cd ~/secondlayer

# Згенерувати токен для клієнта
npx tsx scripts/generate-jwt-token.ts <client-name> <expires-in>

# Приклади:
npx tsx scripts/generate-jwt-token.ts user-john 90d
npx tsx scripts/generate-jwt-token.ts production-app 365d
npx tsx scripts/generate-jwt-token.ts dev-testing 30d
```

Скрипт виведе готову конфігурацію для клієнта з токеном.

---

## 📊 Моніторинг

### Перевірити статус сервера:

```bash
ssh gate.lexapp.co.ua "pm2 status"
```

### Дивитися логи:

```bash
ssh gate.lexapp.co.ua "pm2 logs secondlayer-mcp-sse --lines 50"
```

### Перезапустити сервер (якщо потрібно):

```bash
ssh gate.lexapp.co.ua "pm2 restart secondlayer-mcp-sse"
```

---

## 📚 Додаткова документація

На сайті https://legal.org.ua можна розмістити:

1. `docs/INTEGRATION_GUIDE_WEB.html` - інтерактивний гайд
2. Посилання на документацію:
   - Віддалене підключення: config-examples/REMOTE_MCP_SETUP.md
   - Генерація токенів: config-examples/GENERATE_TOKEN.md
   - Список інструментів: docs/MCP_TOOLS_SUMMARY.md

---

## ✅ Чек-лист deployment:

- [x] Проект зібрано локально
- [x] Файли завантажені на сервер
- [x] .env налаштовано (JWT_SECRET є)
- [x] npm dependencies встановлені
- [x] Docker image побудовано з SSE сервером
- [x] Docker контейнер запущено на порту 3001
- [x] Health check працює локально (localhost:3001)
- [x] Всі сервіси підключені (PostgreSQL, Redis, Qdrant)
- [ ] **nginx налаштовано** ← ПОТРІБНО ЗРОБИТИ
- [ ] **nginx перезавантажено** ← ПОТРІБНО ЗРОБИТИ
- [ ] **Health check працює публічно** ← ТЕСТУВАТИ ПІСЛЯ NGINX

---

## 🎯 Наступні кроки:

1. **Налаштувати nginx** (додати конфігурацію з /tmp/mcp-nginx-legal.conf до mcp.legal.org.ua)
2. **Перезавантажити nginx** (`sudo systemctl reload nginx`)
3. **Протестувати публічний доступ** (`curl https://mcp.legal.org.ua/health`)
4. **Згенерувати токени** для тестових клієнтів
5. **Протестувати підключення** з Claude Desktop або Cursor (`https://mcp.legal.org.ua/mcp/sse`)
6. **Додати документацію на сайт** legal.org.ua

---

**Deployment майже готовий! Залишився тільки nginx.** 🚀
