# 🚀 Quick Start Guide - MCP API Documentation

## Відкрити документацію

### Метод 1: Через npm (рекомендовано)

```bash
cd mcp_backend

# Відкрити головну сторінку документації
npm run docs

# Відкрити API Explorer безпосередньо
npm run docs:api
```

### Метод 2: Напряму з браузера

Просто відкрийте в браузері один з файлів:

- **Documentation Hub**: `file:///path/to/SecondLayer/mcp_backend/docs/index.html`
- **API Explorer**: `file:///path/to/SecondLayer/mcp_backend/docs/api-explorer.html`

## 📚 Що доступно

### 🔧 API Explorer (Swagger-style)
- Інтерактивний перегляд всіх 41 MCP інструментів
- Пошук та фільтрація по категоріях
- Copy-paste готові curl приклади
- Інформація про вартість кожного інструмента
- Детальний опис параметрів

### 📖 Інші документи
- Client Integration Guide
- SSE Streaming Protocol
- Database Setup
- ChatGPT Integration
- Deployment Guide
- PostgreSQL Optimization

## 🎯 Приклади використання

### 1. Пошук прецедентів

```bash
curl -X POST http://localhost:3000/api/tools/search_legal_precedents \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "поновлення пропущеного строку апеляції",
    "domain": "court",
    "limit": 10
  }'
```

### 2. Отримання статті закону

```bash
curl -X POST http://localhost:3000/api/tools/get_legislation_article \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "rada_id": "1618-15",
    "article_number": "354"
  }'
```

### 3. Комплексний юридичний аналіз ⭐

```bash
curl -X POST http://localhost:3000/api/tools/get_legal_advice \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Чи можна поновити строк апеляції якщо повний текст рішення отримано через 40 днів?",
    "reasoning_budget": "standard"
  }'
```

## 🔐 Authentication

Всі запити потребують API ключ:

```bash
Authorization: Bearer YOUR_API_KEY
```

Налаштування через environment variable:
```bash
SECONDARY_LAYER_KEYS=test-key-123,prod-key-456
```

## 🌐 Endpoints

```
Local:  http://localhost:3000
Dev:    https://dev.legal.org.ua
Stage:  https://stage.legal.org.ua
Prod:   https://legal.org.ua
```

## 💰 Pricing Categories

- 🟢 **Free**: 12 інструментів (legislation, base queries)
- 🟡 **Basic ($0.01-$0.05)**: 15 інструментів
- 🟠 **Medium ($0.05-$0.10)**: 10 інструментів
- 🔴 **Premium ($0.10-$0.30)**: 4 інструменти (включаючи get_legal_advice)

## 📊 Категорії інструментів

1. **Query Pipeline** (4) - Класифікація, RAG, валідація
2. **Legal Search** (6) - Прецеденти, практика ВС, схожі справи
3. **Document Analysis** (3) - Витяг секцій, судові рішення
4. **Party & Citation** (2) - Підрахунок справ, граф цитувань
5. **Legislation** (7) - Робота з законодавством
6. **Document Processing** (4) - Парсинг, резюме, порівняння
7. **Document Vault** (4) - Зберігання та пошук
8. **Due Diligence** (3) - Batch review, risk scoring
9. **Procedural** (4) - Строки, чеклисти, розрахунки
10. **Bulk Operations** (2) - Масове завантаження
11. **Advanced** (2) - format_answer_pack, get_legal_advice

## 🚀 Запуск сервера

```bash
# Development (HTTP mode)
npm run dev:http

# Production
npm run build
npm run start:http

# MCP stdio (for Claude Desktop)
npm run dev
```

## 📞 Підтримка

- Документація: `mcp_backend/docs/`
- GitHub Issues
- CLAUDE.md - повний project overview

## 🔗 Корисні посилання

- [API Explorer](./api-explorer.html) - Інтерактивна документація
- [Documentation Hub](./index.html) - Навігація по всіх документах
- [Client Integration](./CLIENT_INTEGRATION.md) - Гід з інтеграції
- [Database Setup](./DATABASE_SETUP.md) - Налаштування БД

---

**Версія**: 2.0.0
**Останнє оновлення**: 2024-01-27
