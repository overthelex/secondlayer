# SecondLayer MCP Backend Documentation

Повна документація MCP (Model Context Protocol) серверів для юридичного аналізу в Україні.

## 🚀 Quick Start

**Для швидкого старту відкрийте [index.html](./index.html) в браузері** - це documentation hub з навігацією по всіх документах.

## 📚 Документація

### 🔧 API Documentation

- **[API Explorer](./api-explorer.html)** ⭐ **NEW!**
  - Інтерактивна документація всіх 41 MCP інструментів
  - Swagger-подібний інтерфейс з пошуком та фільтрацією
  - Приклади curl запитів з можливістю копіювання
  - Інформація про вартість кожного інструмента
  - Детальний опис параметрів та відповідей

### 🔌 Integration Guides

- **[CLIENT_INTEGRATION.md](./CLIENT_INTEGRATION.md)**
  - HTTP REST API
  - MCP stdio mode для Claude Desktop
  - SSE streaming для довгих операцій
  - Приклади на TypeScript, Python, curl

- **[SSE_STREAMING.md](./SSE_STREAMING.md)**
  - Server-Sent Events протокол
  - Real-time streaming прогресу
  - Remote MCP over HTTPS
  - Event types та формати

### 🗄️ Infrastructure

- **[DATABASE_SETUP.md](./DATABASE_SETUP.md)**
  - PostgreSQL 15 setup
  - Redis 7 configuration
  - Qdrant vector database
  - Міграції та схема БД

- **[postgres-optimization.md](./postgres-optimization.md)**
  - Оптимізація індексів
  - Query performance tuning
  - Partitioning для великих таблиць
  - VACUUM та ANALYZE стратегії

### 🤖 AI Integration

- **[CHATGPT_INTEGRATION.md](./CHATGPT_INTEGRATION.md)**
  - Інтеграція з ChatGPT Actions
  - OAuth 2.0 authentication
  - Custom domain deployment
  - Troubleshooting

### 🚀 Deployment

- **[DEPLOYMENT_CHATGPT.md](./DEPLOYMENT_CHATGPT.md)**
  - Multi-environment setup (dev/stage/prod)
  - Docker Compose configuration
  - Nginx gateway routing
  - SSL certificates (Let's Encrypt)
  - Health checks та monitoring

## 📖 Root Documentation

- **[../CLAUDE.md](../CLAUDE.md)** - Project overview для Claude Code
- **[../../START_HERE.md](../../START_HERE.md)** - Monorepo quick start guide

## 🎯 Структура API

### Core Query Pipeline (4 інструменти)
1. `classify_intent` - Класифікація запиту
2. `retrieve_legal_sources` - RAG retrieval джерел
3. `analyze_legal_patterns` - Аналіз юридичних паттернів
4. `validate_response` - Trust layer валідація

### Legal Research (6 інструментів)
5. `search_legal_precedents` - Пошук прецедентів
6. `analyze_case_pattern` - Аналіз паттернів справ
7. `get_similar_reasoning` - Схоже обґрунтування
8. `search_supreme_court_practice` - Практика ВС
9. `compare_practice_pro_contra` - Практика за/проти
10. `find_similar_fact_pattern_cases` - Схожі фактичні обставини

### Document Analysis (3 інструменти)
11. `extract_document_sections` - Витяг секцій
12. `get_court_decision` - Судове рішення
13. `get_case_text` - Текст справи (alias)

### Party & Citation (2 інструменти)
14. `count_cases_by_party` - Підрахунок справ
15. `get_citation_graph` - Граф цитувань

### Legislation (7 інструментів)
16-22. Робота з законодавством (ЦПК, ГПК, КАС, КПК, ЦК, ГК)

### Document Processing (4 інструменти)
23-26. Парсинг, витяг ключових положень, резюме, порівняння

### Document Vault (4 інструменти)
27-30. Зберігання, отримання, пошук документів

### Due Diligence (3 інструменти)
31-33. Batch review, risk scoring, звіти

### Procedural & Calculation (4 інструменти)
34-37. Статус прецедентів, розрахунок строків та вимог

### Bulk Operations (2 інструменти)
38-39. Завантаження та індексація масивів документів

### Advanced Analysis (2 інструменти)
40. `format_answer_pack` - Структурування відповіді
41. `get_legal_advice` ⭐ - Комплексний юридичний аналіз ($0.10-$0.30)

## 💰 Pricing

- **Безкоштовні**: 12 інструментів (legislation tools, base queries)
- **Базові ($0.01-$0.05)**: 15 інструментів (simple search, retrieval)
- **Середні ($0.05-$0.10)**: 10 інструментів (analysis, comparison)
- **Преміум ($0.10-$0.30)**: 4 інструменти (get_legal_advice, deep analysis)

## 🔐 Authentication

Всі HTTP endpoints вимагають authentication:

```bash
Authorization: Bearer YOUR_API_KEY
```

API ключі налаштовуються через environment variable `SECONDARY_LAYER_KEYS`.

## 📡 Base URL

```
Local: http://localhost:3000
Dev:   https://dev.legal.org.ua
Stage: https://stage.legal.org.ua
Prod:  https://legal.org.ua
```

## 🛠️ Development

```bash
# Start HTTP server
npm run dev:http

# Start MCP stdio
npm run dev

# Run tests
npm test

# Database migrations
npm run migrate
```

## 📊 Monitoring

- Cost tracking: `cost_tracking` table
- Monthly usage: `monthly_api_usage` view
- Metrics endpoint: `GET /api/metrics`
- Health check: `GET /health`

## 🔗 External APIs

- **ZakonOnline**: Court decisions database
- **Verkhovna Rada**: Legislation texts
- **OpenAI**: GPT-4o, embeddings
- **Qdrant**: Vector similarity search

## 📞 Support

Для питань та issues використовуйте:
- GitHub Issues: [SecondLayer repository]
- Documentation bugs: Create PR з виправленнями

---

**Last Updated**: 2024-01-27
**Version**: 2.0.0
