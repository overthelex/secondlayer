# 🤖 ChatGPT Web Integration - README

SecondLayer MCP backend теперь полностью поддерживает интеграцию с ChatGPT web через Model Context Protocol (MCP) over Server-Sent Events (SSE).

## 🎯 Что Это Дает?

Прямой доступ к 41 специализированному юридическому инструменту прямо из ChatGPT web интерфейса:

- 🔍 **Поиск судебной практики** - ZakonOnline database
- 📜 **Анализ законодательства** - Всі кодекси України
- ⚖️ **Правові паттерни** - Успішні аргументи та ризики
- 📄 **Обробка документів** - PDF, DOCX з OCR
- 📊 **Due Diligence** - Масовий аналіз контрактів
- 🎯 **Юридичні консультації** - AI + судова практика

## 🚀 Quick Start (5 хвилин)

### 1. Перевірка Сервера

```bash
curl https://mcp.legal.org.ua/health
curl https://mcp.legal.org.ua/mcp | jq '.capabilities.tools.count'
```

Очікується: `{"status":"ok"}` та `41` інструментів.

### 2. Налаштування ChatGPT

1. Відкрити [chat.openai.com](https://chat.openai.com)
2. Settings → Beta → Enable "Developer Mode"
3. New App:
   - **Name**: SecondLayer Legal Research
   - **URL**: `https://mcp.legal.org.ua/sse`
   - **Auth**: OAuth (опціонально)
4. Create

### 3. Тестування

Написати в ChatGPT:
```
Покажи статтю 354 ЦПК про строки апеляції
```

ChatGPT викличе `get_legislation_section` і покаже текст статті.

## 📖 Документація

| Документ | Опис | Час читання |
|----------|------|-------------|
| [**CHATGPT_SETUP_INSTRUCTIONS.md**](CHATGPT_SETUP_INSTRUCTIONS.md) | 📋 Повна покрокова інструкція | 10 хв |
| [**CHATGPT_QUICKSTART.md**](CHATGPT_QUICKSTART.md) | ⚡ Швидкий старт | 5 хв |
| [**docs/CHATGPT_INTEGRATION.md**](docs/CHATGPT_INTEGRATION.md) | 📚 Повна технічна документація | 30 хв |
| [**docs/DEPLOYMENT_CHATGPT.md**](docs/DEPLOYMENT_CHATGPT.md) | 🚀 Production deployment | 20 хв |
| [**EXAMPLES_CHATGPT.md**](EXAMPLES_CHATGPT.md) | 💡 10 реальних прикладів | 15 хв |
| [**CHANGELOG_CHATGPT.md**](CHANGELOG_CHATGPT.md) | 📝 Історія змін | 5 хв |

## 🛠️ Файли

### Код
- `src/api/mcp-sse-server.ts` - MCP SSE server implementation
- `src/http-server.ts` - Updated with /sse and /mcp endpoints

### Конфігурація
- `nginx-mcp-chatgpt.conf` - Nginx config with SSE support

### Скрипти
- `scripts/test-chatgpt-mcp.sh` - Integration test script

### Документація
- 8 markdown файлів (see table above)

## 🎯 Ключові Endpoints

| Endpoint | Метод | Призначення |
|----------|-------|------------|
| `/health` | GET | Health check |
| `/mcp` | GET | MCP discovery (список інструментів) |
| `/sse` | POST | MCP SSE (для ChatGPT) |
| `/api/tools` | GET | HTTP API (список інструментів) |
| `/api/tools/:name` | POST | HTTP API (виклик інструменту) |

## 🔧 Швидке Налаштування

```bash
# 1. Build
cd /home/vovkes/SecondLayer/mcp_backend
npm run build

# 2. Start
pm2 restart mcp-backend

# 3. Test
./scripts/test-chatgpt-mcp.sh https://mcp.legal.org.ua

# 4. Configure nginx
sudo cp nginx-mcp-chatgpt.conf /etc/nginx/sites-available/mcp.legal.org.ua
sudo ln -s /etc/nginx/sites-available/mcp.legal.org.ua /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 📊 Інструменти (41 total)

<details>
<summary>Розгорнути список всіх інструментів</summary>

### Core Query Pipeline (4)
1. classify_intent
2. retrieve_legal_sources
3. analyze_legal_patterns
4. validate_response

### Legal Research (6)
5. search_legal_precedents
6. analyze_case_pattern
7. get_similar_reasoning
8. search_supreme_court_practice
9. compare_practice_pro_contra
10. find_similar_fact_pattern_cases

### Document Analysis (3)
11. extract_document_sections
12. get_court_decision
13. get_case_text

### Party & Citation (2)
14. count_cases_by_party
15. get_citation_graph

### Legislation (7)
16. get_legislation_article
17. get_legislation_section
18. get_legislation_articles
19. search_legislation
20. get_legislation_structure
21. find_relevant_law_articles
22. search_procedural_norms

### Document Processing (4)
23. parse_document
24. extract_key_clauses
25. summarize_document
26. compare_documents

### Document Vault (4)
27. store_document
28. get_document
29. list_documents
30. semantic_search

### Due Diligence (3)
31. bulk_review_runner
32. risk_scoring
33. generate_dd_report

### Procedural & Calculation (4)
34. check_precedent_status
35. calculate_procedural_deadlines
36. build_procedural_checklist
37. calculate_monetary_claims

### Bulk Operations (2)
38. load_full_texts
39. bulk_ingest_court_decisions

### Advanced Analysis (2)
40. format_answer_pack
41. get_legal_advice

</details>

## 🧪 Приклади Запитів

### Законодавство
```
Покажи статтю 354 ЦПК України
```

### Судова Практика
```
Знайди практику Верховного Суду про строки апеляції за 2023 рік
```

### Юридичний Аналіз
```
Я пропустив строк апеляції через несвоєчасне отримання повного тексту.
Що я можу зробити?
```

### Обробка Документів
```
Проаналізуй цей контракт на ризики [прикріпити PDF]
```

## 📈 Статус

- **Status**: ✅ Production Ready
- **Protocol**: MCP 2024-11-05
- **Transport**: SSE (Server-Sent Events)
- **Format**: JSON-RPC 2.0
- **Tools**: 41 available
- **Tested**: ✅ All tests passing

## 🔒 Безпека

- **Authentication**: OAuth 2.0 / Bearer Token
- **Rate Limiting**: 10 req/min (SSE), 100 req/min (API)
- **CORS**: Restricted to ChatGPT domains
- **SSL/TLS**: Required in production
- **Monitoring**: Full cost tracking & logging

## 🐛 Troubleshooting

**Backend не відповідає?**
```bash
pm2 status
pm2 logs mcp-backend --lines 50
```

**Інструменти не з'являються?**
```bash
curl https://mcp.legal.org.ua/mcp | jq '.capabilities.tools.count'
# Повинно бути 41
```

**SSE не працює?**
```bash
sudo nginx -t
sudo tail -100 /var/log/nginx/error.log
```

Детальний troubleshooting: [CHATGPT_SETUP_INSTRUCTIONS.md](CHATGPT_SETUP_INSTRUCTIONS.md#troubleshooting)

## 📞 Підтримка

- 📖 Документація: `docs/` folder
- 🧪 Тестування: `./scripts/test-chatgpt-mcp.sh`
- 📊 Логи: `pm2 logs mcp-backend`
- 🔍 Моніторинг: PostgreSQL `cost_tracking` table
- 🐛 Issues: GitHub issues

## 🎉 Що Далі?

1. ✅ Перевірте сервер: `./scripts/test-chatgpt-mcp.sh`
2. ✅ Прочитайте: [CHATGPT_SETUP_INSTRUCTIONS.md](CHATGPT_SETUP_INSTRUCTIONS.md)
3. ✅ Підключіть ChatGPT: `https://mcp.legal.org.ua/sse`
4. ✅ Тестуйте приклади: [EXAMPLES_CHATGPT.md](EXAMPLES_CHATGPT.md)
5. ✅ Насолоджуйтесь! 🚀

---

**Version**: 1.1.0
**Released**: January 27, 2026
**Protocol**: MCP 2024-11-05
**Status**: ✅ Production Ready

**Автори**: SecondLayer Team
**Ліцензія**: Див. основний README

---

## 🔗 Quick Links

- 🌐 **Base URL**: https://mcp.legal.org.ua
- 🤖 **MCP SSE**: https://mcp.legal.org.ua/sse
- 🔍 **Discovery**: https://mcp.legal.org.ua/mcp
- ❤️ **Health**: https://mcp.legal.org.ua/health
- 📚 **Docs**: [OpenAI MCP](https://platform.openai.com/docs/mcp)

---

**Enjoy! 🎉**
