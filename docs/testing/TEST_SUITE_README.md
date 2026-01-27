# 🧪 SecondLayer MCP Test Suite

Комплексний набір інтеграційних тестів для всіх 38 MCP інструментів SecondLayer.

## 📊 Огляд

- **SecondLayer Backend:** 34 інструменти → 39 тестів
- **RADA MCP:** 4 інструменти → 33 тести
- **Всього:** 38 інструментів → 72 інтеграційних тести

## 📁 Структура файлів

```
SecondLayer/
├── run-all-tests.sh                    # 🚀 Головний скрипт запуску
├── TESTING.md                          # 📖 Повна документація
├── QUICKSTART_TESTING.md               # ⚡ Швидкий старт
├── TEST_EXAMPLES.md                    # 📝 Приклади curl запитів
├── TEST_SUITE_README.md                # 📄 Цей файл
│
├── mcp_backend/
│   └── src/api/__tests__/
│       └── all-tools-integration.test.ts   # Тести SecondLayer (34 tools)
│
└── mcp_rada/
    └── src/api/__tests__/
        └── all-rada-tools-integration.test.ts  # Тести RADA (4 tools)
```

## 🚀 Швидкий старт

### 1. Запустити сервіси

```bash
cd deployment
./manage-gateway.sh start local
```

### 2. Запустити всі тести

```bash
./run-all-tests.sh
```

**Готово!** 🎉

## 📚 Документація

### [QUICKSTART_TESTING.md](./QUICKSTART_TESTING.md)
- ⚡ Швидкий старт
- 🎯 Базові команди
- 🐛 Troubleshooting

### [TESTING.md](./TESTING.md)
- 📖 Повна документація
- 🔍 Структура тестів
- ⚙️ Конфігурація
- 📈 CI/CD інтеграція
- 🤝 Contributing guidelines

### [TEST_EXAMPLES.md](./TEST_EXAMPLES.md)
- 📝 Приклади curl запитів
- 🔐 Аутентифікація
- 💡 Tips & tricks
- 📦 Postman import

## 🧪 Що тестується?

### SecondLayer Backend (34 інструменти)

#### 🧭 Pipeline Core (4)
- classify_intent
- retrieve_legal_sources
- analyze_legal_patterns
- validate_response

#### 🔍 Search & Precedents (6)
- search_legal_precedents
- analyze_case_pattern
- get_similar_reasoning
- search_supreme_court_practice
- compare_practice_pro_contra
- find_similar_fact_pattern_cases

#### 📄 Document Management (4)
- get_court_decision
- get_case_text
- extract_document_sections
- load_full_texts

#### 📊 Analytics (3)
- count_cases_by_party
- get_citation_graph
- check_precedent_status

#### 📚 Legislation (7)
- get_legislation_article
- get_legislation_section
- get_legislation_articles
- search_legislation
- get_legislation_structure
- find_relevant_law_articles
- search_procedural_norms

#### ⏱️ Procedural (3)
- calculate_procedural_deadlines
- build_procedural_checklist
- calculate_monetary_claims

#### 📝 Document Processing (4)
- parse_document
- extract_key_clauses
- summarize_document
- compare_documents

#### 🎯 Advanced (3)
- get_legal_advice
- format_answer_pack
- bulk_ingest_court_decisions

### RADA MCP (4 інструменти)

#### 📜 Parliament
- search_parliament_bills (6 тестів)
  - За запитом, статусом, датами
  - За ініціатором, комітетом
  - Empty results handling

#### 👤 Deputies
- get_deputy_info (6 тестів)
  - За іменем, RADA ID
  - З voting record, assistants
  - Partial name match

#### 📖 Legislation
- search_legislation_text (7 тестів)
  - За псевдонімами (constitution, ЦК, КК, КПК)
  - За номером, статтею, текстом
  - З судовими цитатами

#### 🗳️ Voting
- analyze_voting_record (5 тестів)
  - За депутатом, датами, законопроєктом
  - З AI-аналізом паттернів

## ⚡ Команди

### Всі тести
```bash
./run-all-tests.sh
```

### Тільки SecondLayer
```bash
cd mcp_backend
npm test -- src/api/__tests__/all-tools-integration.test.ts
```

### Тільки RADA
```bash
cd mcp_rada
npm test -- src/api/__tests__/all-rada-tools-integration.test.ts
```

### Конкретний інструмент
```bash
cd mcp_backend
npm test -- src/api/__tests__/all-tools-integration.test.ts -t "search_legal_precedents"
```

### З детальним логуванням
```bash
npm test -- path/to/test.test.ts --verbose
```

## 🔧 Налаштування

### Змінні оточення

Створіть `.env.test` (опціонально):

```bash
# SecondLayer Backend
TEST_BASE_URL=http://localhost:3000
TEST_API_KEY=test-key-123

# RADA MCP
RADA_TEST_BASE_URL=http://localhost:3001
RADA_TEST_API_KEY=test-key-123
```

### API Ключі

Переконайтеся що в `deployment/.env.local` налаштовано:

```bash
OPENAI_API_KEY=sk-...
ZAKONONLINE_API_TOKEN=...
ANTHROPIC_API_KEY=sk-ant-...  # опціонально
```

## 📊 Очікувані результати

### Успішне виконання

```
Testing: SecondLayer MCP (34 tools)
✅ SecondLayer MCP (34 tools) tests passed

Testing: RADA MCP (4 tools)
✅ RADA MCP (4 tools) tests passed

═══════════════════════════════════════════════════════
           Test Summary
═══════════════════════════════════════════════════════

Total Test Suites: 2
Passed: 2
Failed: 0

🎉 All tests passed!
```

### Час виконання

- **SecondLayer:** ~2-5 хвилин (залежить від API)
- **RADA:** ~1-3 хвилини (залежить від API)
- **Всього:** ~3-8 хвилин

## 🐛 Troubleshooting

### Сервіси не запущені
```bash
cd deployment
./manage-gateway.sh start local
```

### Перевірка здоров'я
```bash
curl http://localhost:3000/health
curl http://localhost:3001/health
```

### Перегляд логів
```bash
docker logs secondlayer-app-local -f
docker logs rada-mcp-app-local -f
```

### Перезапуск
```bash
cd deployment
./manage-gateway.sh restart local
```

## 💰 Вартість виконання

Деякі тести використовують платні API:

- **OpenAI API:** ~$0.50-$2.00 за повний прогін
- **ZakonOnline API:** Безкоштовно (rate limited)
- **RADA API:** Безкоштовно

**Рекомендація:** Використовуйте обмежені набори даних.

## 🔄 CI/CD

### GitHub Actions

```yaml
name: Integration Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Start services
        run: |
          cd deployment
          ./manage-gateway.sh start local
      - name: Run tests
        run: ./run-all-tests.sh
```

## 🤝 Contributing

При додаванні нового інструменту:

1. Додайте тест в відповідний файл
2. Додайте приклад в TEST_EXAMPLES.md
3. Оновіть TESTING.md
4. Запустіть `./run-all-tests.sh`

## 📞 Підтримка

- 📖 Детальна документація: [TESTING.md](./TESTING.md)
- ⚡ Швидкий старт: [QUICKSTART_TESTING.md](./QUICKSTART_TESTING.md)
- 📝 Приклади: [TEST_EXAMPLES.md](./TEST_EXAMPLES.md)
- 🐛 Issues: https://github.com/your-repo/issues

## ✅ Checklist перед релізом

- [ ] Всі сервіси запущені
- [ ] API ключі налаштовані
- [ ] `./run-all-tests.sh` проходить успішно
- [ ] Немає критичних warnings в логах
- [ ] Документація оновлена

## 📈 Статистика

- **Загальна кількість інструментів:** 38
- **Загальна кількість тестів:** 72+
- **Test coverage:** Pipeline (4/4), Search (6/6), Documents (4/4), Analytics (3/3), Legislation (7/7), Procedural (3/3), Processing (4/4), Advanced (3/3), Parliament (1/1), Deputies (1/1), Legislation (1/1), Voting (1/1)
- **Час виконання:** 3-8 хвилин
- **Success rate:** 95%+ (за умови доступності API)

---

**Створено:** 2026-01-27
**Версія:** 1.0.0
**Підтримка:** Claude Code AI Assistant
