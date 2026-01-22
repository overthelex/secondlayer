# SecondLayer MCP - Швидкий старт

Підключіть AI-асистента до бази судових рішень України за 5 хвилин.

---

## 🚀 Передумови

```bash
cd /Users/vovkes/ZOMCP/SecondLayer/mcp_backend

# 1. Встановити залежності
npm install

# 2. Зібрати проект
npm run build

# 3. Запустити інфраструктуру
docker-compose up -d postgres qdrant redis
```

---

## 🖥️ Cursor IDE

**Файл:** `.cursor/mcp.json` (в корені проекту)

```json
{
  "mcpServers": {
    "secondlayer": {
      "command": "node",
      "args": ["/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/dist/index.js"],
      "env": {
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5432",
        "POSTGRES_USER": "secondlayer",
        "POSTGRES_PASSWORD": "ваш-пароль",
        "POSTGRES_DB": "secondlayer_db",
        "QDRANT_URL": "http://localhost:6333",
        "REDIS_URL": "redis://localhost:6379",
        "OPENAI_API_KEY": "sk-...",
        "ZAKONONLINE_API_TOKEN": "ваш-токен",
        "OPENAI_MODEL_QUICK": "gpt-4o-mini",
        "OPENAI_MODEL_DEEP": "gpt-4o"
      }
    }
  }
}
```

**Використання:** Увімкніть **Agent Mode** в Cursor та пишіть запити:

```
Знайди судові рішення про незаконну мобілізацію за 2023 рік
```

**Джерела:**
- [Cursor MCP Docs](https://cursor.com/docs/context/mcp)
- [Natoma Setup Guide](https://natoma.ai/blog/how-to-enabling-mcp-in-cursor)

---

## 🤖 Claude Desktop

**Файл (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Файл (Linux):** `~/.config/Claude/claude_desktop_config.json`
**Файл (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "secondlayer": {
      "command": "node",
      "args": ["/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/dist/index.js"],
      "env": {
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5432",
        "POSTGRES_USER": "secondlayer",
        "POSTGRES_PASSWORD": "ваш-пароль",
        "POSTGRES_DB": "secondlayer_db",
        "QDRANT_URL": "http://localhost:6333",
        "REDIS_URL": "redis://localhost:6379",
        "OPENAI_API_KEY": "sk-proj-...",
        "ZAKONONLINE_API_TOKEN": "токен",
        "OPENAI_MODEL_QUICK": "gpt-4o-mini",
        "OPENAI_MODEL_STANDARD": "gpt-4o-mini",
        "OPENAI_MODEL_DEEP": "gpt-4o",
        "OPENAI_EMBEDDING_MODEL": "text-embedding-ada-002",
        "NODE_ENV": "production",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

**Швидка установка (macOS):**

```bash
cp mcp_backend/config-examples/claude-desktop-config.json \
   ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Перезапустити Claude Desktop** (Cmd+Q → відкрити знову)

**Перевірити:** Шукайте іконку 🔌 або пишіть "Покажи доступні MCP інструменти"

---

## 💻 VSCode / Continue

### Варіант 1: VSCode (вбудована підтримка)

**Файл:** `.vscode/mcp.json`

```json
{
  "mcpServers": {
    "secondlayer": {
      "command": "node",
      "args": ["/шлях/до/mcp_backend/dist/index.js"],
      "env": {
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5432",
        "POSTGRES_USER": "secondlayer",
        "POSTGRES_PASSWORD": "пароль",
        "POSTGRES_DB": "secondlayer_db",
        "QDRANT_URL": "http://localhost:6333",
        "REDIS_URL": "redis://localhost:6379",
        "OPENAI_API_KEY": "sk-...",
        "ZAKONONLINE_API_TOKEN": "токен"
      }
    }
  }
}
```

Увімкніть автоматичне виявлення:
```json
"chat.mcp.discovery.enabled": true
```

### Варіант 2: Continue Extension

**Файл:** `.continue/mcpServers/secondlayer.yaml`

```yaml
name: secondlayer
command: node
args:
  - /шлях/до/mcp_backend/dist/index.js
env:
  POSTGRES_HOST: localhost
  POSTGRES_PORT: "5432"
  POSTGRES_USER: secondlayer
  POSTGRES_PASSWORD: пароль
  POSTGRES_DB: secondlayer_db
  QDRANT_URL: http://localhost:6333
  REDIS_URL: redis://localhost:6379
  OPENAI_API_KEY: sk-...
  ZAKONONLINE_API_TOKEN: токен
```

**Джерела:**
- [VSCode MCP Docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers)
- [Continue.dev MCP Guide](https://docs.continue.dev/customize/deep-dives/mcp)

---

## 🔧 Claude Code (CLI)

Claude Code використовує **ту ж саму конфігурацію**, що й Claude Desktop.

```bash
# Встановити
npm install -g @anthropic-ai/claude-code

# Запустити
claude-code
```

MCP інструменти автоматично доступні після налаштування конфігу Claude Desktop.

---

## 🌐 Web API / HTTP

### Запуск сервера

```bash
cd mcp_backend

# Development
npm run dev:http

# Production
npm run build
npm run start:http
```

Сервер на: `http://localhost:3000`

### Налаштування API ключів

У `.env`:
```bash
SECONDARY_LAYER_KEYS=test-key-123,prod-key-456
```

### Endpoints

| Метод | Endpoint | Опис | Auth |
|-------|----------|------|------|
| GET | `/health` | Health check | ❌ |
| GET | `/api/tools` | Список інструментів | ✅ |
| POST | `/api/tools/:toolName` | Виконати інструмент | ✅ |
| POST | `/api/tools/:toolName/stream` | SSE streaming | ✅ |

### Приклад використання (JavaScript)

```javascript
// Простий запит
const response = await fetch('http://localhost:3000/api/tools/search_legal_precedents', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer test-key-123',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    query: 'мобілізація 2023',
    limit: 10
  })
});

const data = await response.json();
```

### SSE Streaming

```javascript
const params = new URLSearchParams({
  authorization: 'Bearer test-key-123',
  query: 'мобілізація',
  limit: '5'
});

const eventSource = new EventSource(
  `http://localhost:3000/api/tools/search_legal_precedents/stream?${params}`
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data);

  if (data.type === 'complete') {
    eventSource.close();
  }
};
```

---

## 💬 ChatGPT / Custom GPT

ChatGPT не підтримує MCP напряму. Використовуйте **Web API** з Custom GPT Actions.

### Швидкий спосіб (ngrok для тестування)

```bash
# Запустити API
npm run dev:http

# В іншому терміналі - публічний тунель
ngrok http 3000
```

### Custom GPT Setup

1. Перейти на [ChatGPT GPTs Editor](https://chat.openai.com/gpts/editor)
2. Створити новий GPT
3. У розділі **Actions** додати OpenAPI schema (приклад у повній документації)
4. Authentication: **Bearer Token** з вашим `SECONDARY_LAYER_KEYS`

---

## 📚 Доступні MCP Інструменти

| Інструмент | Опис |
|------------|------|
| `search_legal_precedents` | Семантичний пошук судових рішень |
| `analyze_case_pattern` | Аналіз паттернів у судовій практиці |
| `get_similar_reasoning` | Пошук схожих обґрунтувань |
| `extract_document_sections` | Витягування структурованих секцій |
| `find_relevant_law_articles` | Релевантні статті законів |
| `check_precedent_status` | Статус прецеденту |
| `get_citation_graph` | Граф цитувань |
| `get_legal_advice` | Комплексна юридична консультація |

**Повна документація API:**
```bash
curl -H "Authorization: Bearer test-key-123" http://localhost:3000/api/tools | jq .
```

---

## 🐛 Troubleshooting

### Desktop (Claude/Cursor/VSCode)

**Проблема:** Server not found

```bash
# Перевірити чи файл існує
ls -la /Users/vovkes/ZOMCP/SecondLayer/mcp_backend/dist/index.js

# Зібрати якщо потрібно
npm run build
```

**Проблема:** Connection timeout

```bash
# Перевірити сервіси
docker-compose ps

# Запустити якщо потрібно
docker-compose up -d
```

**Логи (macOS):**
```bash
# Claude Desktop
tail -f ~/Library/Logs/Claude/mcp*.log

# MCP Server
tail -f /Users/vovkes/ZOMCP/SecondLayer/mcp_backend/logs/combined.log
```

### Web API

**Проблема:** Connection refused

```bash
# Запустити HTTP сервер
npm run dev:http
```

**Проблема:** 401 Unauthorized

```bash
# Перевірити API ключ
grep SECONDARY_LAYER_KEYS .env

# Використовувати правильний ключ
curl -H "Authorization: Bearer test-key-123" http://localhost:3000/api/tools
```

---

## 📖 Повна документація

- [HTML Integration Guide](./INTEGRATION_GUIDE_WEB.html) - Інтерактивний гайд з прикладами
- [Client Integration Guide](../mcp_backend/docs/CLIENT_INTEGRATION.md) - Детальна документація
- [SSE Streaming](../mcp_backend/docs/SSE_STREAMING.md) - Server-Sent Events
- [Config Examples](../mcp_backend/config-examples/) - Готові конфігурації

---

## 🆘 Підтримка

Якщо виникли проблеми:

1. Перевірити логи (див. вище)
2. Перевірити що всі сервіси запущені: `docker-compose ps`
3. Перевірити що проект зібрано: `ls dist/index.js`
4. Відкрити issue на GitHub

---

**SecondLayer MCP** - AI-powered аналіз українських судових рішень

[legal.org.ua](https://legal.org.ua) | Powered by OpenAI, Qdrant, PostgreSQL
