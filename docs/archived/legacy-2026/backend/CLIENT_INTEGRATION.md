# Client Integration Guide

Це керівництво описує як підключити SecondLayer MCP до різних типів клієнтів.

## Огляд

SecondLayer MCP підтримує два типи підключень:

| Тип клієнта | Протокол | Застосування |
|-------------|----------|--------------|
| **Desktop** | stdio (stdin/stdout) | Claude Desktop, VSCode, Cline, Continue |
| **Web** | HTTP/REST + SSE | Браузерні застосунки, веб-інтерфейси |

---

## 🖥️ Desktop Client Integration

### Підтримувані клієнти
- Claude Desktop
- VSCode з розширеннями MCP
- Cline
- Continue
- Інші MCP-сумісні IDE

### Передумови

1. **Збудувати проект:**
```bash
cd /Users/vovkes/ZOMCP/SecondLayer/mcp_backend
npm run build
```

2. **Запустити інфраструктуру:**
```bash
# PostgreSQL, Qdrant, Redis
docker-compose up -d postgres qdrant redis
```

3. **Перевірити що dist/index.js існує:**
```bash
ls -la dist/index.js
```

### Конфігурація для Claude Desktop

**Локація конфігураційного файлу:**

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

**Приклад конфігурації:**

```json
{
  "mcpServers": {
    "secondlayer": {
      "command": "node",
      "args": [
        "/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/dist/index.js"
      ],
      "env": {
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5432",
        "POSTGRES_USER": "secondlayer",
        "POSTGRES_PASSWORD": "your-password",
        "POSTGRES_DB": "secondlayer_db",
        "QDRANT_URL": "http://localhost:6333",
        "REDIS_URL": "redis://localhost:6379",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_API_KEY2": "sk-...",
        "ZAKONONLINE_API_TOKEN": "your-token",
        "ZAKONONLINE_API_TOKEN2": "your-token-2",
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

> **Готовий шаблон:** `mcp_backend/config-examples/claude-desktop-config.json`

### Як підключити:

1. **Скопіювати шаблон:**
```bash
cp config-examples/claude-desktop-config.json ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

2. **Відредагувати шляхи та паролі** у скопійованому файлі

3. **Перезапустити Claude Desktop**

4. **Перевірити підключення:**
   - Відкрити Claude Desktop
   - У чаті з'явиться іконка 🔌 (MCP tools)
   - Спробувати: "List available MCP tools"

### Налагодження (Desktop)

**Логи Claude Desktop:**
```bash
# macOS
tail -f ~/Library/Logs/Claude/mcp*.log

# Linux
tail -f ~/.config/Claude/logs/mcp*.log
```

**Логи MCP сервера:**
```bash
# Якщо використовується LOG_LEVEL=debug
tail -f /Users/vovkes/ZOMCP/SecondLayer/mcp_backend/logs/error.log
tail -f /Users/vovkes/ZOMCP/SecondLayer/mcp_backend/logs/combined.log
```

**Типові проблеми:**

| Проблема | Рішення |
|----------|---------|
| "MCP server not found" | Перевірити шлях до dist/index.js |
| "Connection failed" | Перевірити чи запущені PostgreSQL/Qdrant/Redis |
| "Authentication error" | Перевірити OPENAI_API_KEY в конфігурації |
| Сервер мовчить | Встановити LOG_LEVEL=debug та перевірити логи |

---

## 🌐 Web Client Integration

### Підтримувані клієнти
- Браузерні Single Page Applications (SPA)
- React/Vue/Angular застосунки
- Мобільні застосунки (через HTTP API)
- Сторонні інтеграції

### Передумови

1. **Збудувати проект** (якщо ще не зроблено)
2. **Запустити HTTP сервер:**

```bash
# Development mode (з hot reload)
npm run dev:http

# Production mode
npm run build
npm run start:http
```

Сервер стартує на `http://localhost:3000`

### API Endpoints

**Базова URL:** `http://localhost:3000`

| Метод | Endpoint | Опис | Потребує Auth |
|-------|----------|------|---------------|
| GET | `/health` | Health check | ❌ |
| GET | `/api/tools` | Список доступних інструментів | ✅ |
| POST | `/api/tools/:toolName` | Виконати інструмент (JSON відповідь) | ✅ |
| POST | `/api/tools/:toolName/stream` | Виконати інструмент (SSE streaming) | ✅ |
| POST | `/api/tools/batch` | Batch виконання декількох інструментів | ✅ |

### Аутентифікація

Всі endpoints (крім `/health`) потребують API ключ:

```http
Authorization: Bearer test-key-123
```

**Налаштування ключів:**

У `.env` файлі:
```bash
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456,prod-key-789
```

Можна вказати декілька ключів через кому.

### Приклади використання

#### 1. JavaScript/Fetch (Простий запит)

```javascript
async function searchPrecedents(query) {
  const response = await fetch('http://localhost:3000/api/tools/search_legal_precedents', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer test-key-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: query,
      limit: 5
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.json();
}

// Використання
const results = await searchPrecedents("справи про ухилення від мобілізації");
console.log(results);
```

#### 2. SSE Streaming (Real-time прогрес)

```javascript
function searchPrecedentsStream(query, onEvent) {
  const params = new URLSearchParams({
    authorization: 'Bearer test-key-123',
    query: query,
    limit: '5'
  });

  const eventSource = new EventSource(
    `http://localhost:3000/api/tools/search_legal_precedents/stream?${params}`
  );

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    onEvent(data);

    if (data.type === 'complete' || data.type === 'error') {
      eventSource.close();
    }
  };

  eventSource.onerror = (error) => {
    console.error('SSE Error:', error);
    eventSource.close();
  };

  return eventSource; // Для можливості закрити з зовні
}

// Використання
searchPrecedentsStream("ухилення від мобілізації", (data) => {
  console.log(`Event: ${data.type}`, data);

  switch(data.type) {
    case 'progress':
      console.log('Progress:', data.message);
      break;
    case 'result':
      console.log('Got result:', data.data);
      break;
    case 'complete':
      console.log('Search complete!');
      break;
  }
});
```

#### 3. React Hook приклад

```javascript
import { useState, useCallback } from 'react';

function useSecondLayerMCP() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const callTool = useCallback(async (toolName, params) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`http://localhost:3000/api/tools/${toolName}`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-key-123',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(params)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { callTool, loading, error };
}

// Використання в компоненті
function SearchComponent() {
  const { callTool, loading } = useSecondLayerMCP();
  const [results, setResults] = useState([]);

  const handleSearch = async () => {
    const data = await callTool('search_legal_precedents', {
      query: 'ухилення від мобілізації',
      limit: 10
    });
    setResults(data.cases || []);
  };

  return (
    <div>
      <button onClick={handleSearch} disabled={loading}>
        {loading ? 'Searching...' : 'Search'}
      </button>
      {/* Display results */}
    </div>
  );
}
```

### Демо Web Client

Готовий HTML демо клієнт для тестування:

**Локація:** `mcp_backend/config-examples/web-client-demo.html`

**Як використати:**

1. **Запустити HTTP сервер:**
```bash
npm run dev:http
```

2. **Відкрити демо в браузері:**
```bash
open config-examples/web-client-demo.html
```

3. **Функції демо:**
   - Список всіх MCP інструментів
   - Тестовий пошук (JSON відповідь)
   - Тестовий пошук (SSE streaming)
   - Виконання власних запитів

### CORS налаштування

Якщо веб-клієнт працює на іншому домені:

**У `src/http-server.ts` вже налаштовано:**
```typescript
app.use(cors({
  origin: '*', // Для dev. У prod вказати конкретні домени
  credentials: true
}));
```

**Для production змінити на:**
```typescript
app.use(cors({
  origin: ['https://yourdomain.com', 'https://app.yourdomain.com'],
  credentials: true
}));
```

### Налагодження (Web)

**Перевірити чи працює сервер:**
```bash
curl http://localhost:3000/health
```

**Перевірити аутентифікацію:**
```bash
curl -H "Authorization: Bearer test-key-123" http://localhost:3000/api/tools
```

**Тестовий запит:**
```bash
curl -X POST http://localhost:3000/api/tools/search_legal_precedents \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"query": "тест", "limit": 1}'
```

**Логи сервера:**
```bash
# Realtime logs
tail -f logs/combined.log

# Лише помилки
tail -f logs/error.log
```

---

## 🔧 Доступні MCP Tools

Всі інструменти доступні через обидва типи клієнтів:

| Tool Name | Опис | Параметри |
|-----------|------|-----------|
| `search_legal_precedents` | Семантичний пошук судових рішень | `query`, `limit`, `filters` |
| `analyze_case_pattern` | Аналіз паттернів у судовій практиці | `topic`, `filters` |
| `get_similar_reasoning` | Знайти схожі судові обґрунтування | `reasoning_text`, `limit` |
| `extract_document_sections` | Витягти структуровані секції з документа | `doc_id` або `text` |
| `find_relevant_law_articles` | Знайти релевантні статті закону | `topic` |
| `check_precedent_status` | Перевірити статус прецеденту | `case_number` |
| `get_citation_graph` | Побудувати граф цитувань | `case_number`, `depth` |
| `get_legal_advice` | Комплексний юридичний аналіз | `question`, `context` |

**Повна документація інструментів:**
```bash
# Отримати JSON Schema всіх інструментів
curl http://localhost:3000/api/tools | jq .
```

---

## 📊 Порівняння Desktop vs Web

| Характеристика | Desktop (stdio) | Web (HTTP/SSE) |
|----------------|-----------------|----------------|
| **Протокол** | stdin/stdout | HTTP REST |
| **Streaming** | ❌ (не потрібен) | ✅ SSE |
| **Аутентифікація** | Не потрібна (локальний процес) | API ключі |
| **Безпека** | Висока (локальне виконання) | Потребує HTTPS в prod |
| **Масштабованість** | 1:1 (один процес на клієнт) | Багато клієнтів → 1 сервер |
| **Використання** | IDE інтеграції | Веб-застосунки, API |
| **Складність** | Простіше | Потребує HTTP сервер |

---

## 🚀 Production Deployment

### Desktop клієнти
- Збудувати з `npm run build`
- Розповсюдити `dist/` папку
- Клієнти налаштовують локальні MCP конфігурації

### Web клієнти
- Розгорнути HTTP сервер на VPS/cloud
- Налаштувати HTTPS (Let's Encrypt)
- Використати nginx/Apache як reverse proxy
- Налаштувати CORS для production доменів

**Приклад docker-compose для prod:**
```bash
docker-compose -f docker-compose.prod.yml up -d
```

---

## 🆘 Troubleshooting

### Desktop клієнти

**Помилка:** "Cannot find module 'dist/index.js'"
```bash
# Перебудувати проект
npm run build
# Перевірити шлях в claude_desktop_config.json
```

**Помилка:** "Connection timeout"
```bash
# Перевірити чи запущені сервіси
docker-compose ps
# Перевірити з'єднання з БД
psql -h localhost -U secondlayer -d secondlayer_db
```

### Web клієнти

**Помилка:** 401 Unauthorized
```bash
# Перевірити API ключ в .env
grep SECONDARY_LAYER_KEYS .env
# Перевірити заголовок Authorization
```

**Помилка:** CORS blocked
```bash
# Додати ваш домен у src/http-server.ts
# Перезапустити сервер
```

**Помилка:** SSE не працює
```bash
# Перевірити чи endpoint закінчується на /stream
# Переконатись що використовується EventSource API
```

---

## 📚 Додаткові ресурси

- [SSE Streaming Documentation](./SSE_STREAMING.md)
- [Database Setup Guide](./DATABASE_SETUP.md)
- [API Reference](../README.md)
- [MCP Protocol Spec](https://spec.modelcontextprotocol.io/)

