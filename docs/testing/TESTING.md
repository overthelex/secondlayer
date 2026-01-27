# SecondLayer MCP Integration Tests

Комплексні інтеграційні тести для всіх MCP інструментів SecondLayer та RADA MCP.

## 📋 Огляд

### SecondLayer Backend (34 інструменти)

Тест файл: `mcp_backend/src/api/__tests__/all-tools-integration.test.ts`

**Категорії інструментів:**

1. **Pipeline Core** (4 інструменти)
   - classify_intent
   - retrieve_legal_sources
   - analyze_legal_patterns
   - validate_response

2. **Search & Precedents** (6 інструментів)
   - search_legal_precedents
   - analyze_case_pattern
   - get_similar_reasoning
   - search_supreme_court_practice
   - compare_practice_pro_contra
   - find_similar_fact_pattern_cases

3. **Document Management** (4 інструменти)
   - get_court_decision
   - get_case_text
   - extract_document_sections
   - load_full_texts

4. **Analytics** (3 інструменти)
   - count_cases_by_party
   - get_citation_graph
   - check_precedent_status

5. **Legislation** (7 інструментів)
   - get_legislation_article
   - get_legislation_section
   - get_legislation_articles
   - search_legislation
   - get_legislation_structure
   - find_relevant_law_articles
   - search_procedural_norms

6. **Procedural** (3 інструменти)
   - calculate_procedural_deadlines
   - build_procedural_checklist
   - calculate_monetary_claims

7. **Document Processing** (4 інструменти)
   - parse_document
   - extract_key_clauses
   - summarize_document
   - compare_documents

8. **Advanced** (3 інструменти)
   - get_legal_advice
   - format_answer_pack
   - bulk_ingest_court_decisions

### RADA MCP (4 інструменти)

Тест файл: `mcp_rada/src/api/__tests__/all-rada-tools-integration.test.ts`

**Парламентські інструменти:**

1. **search_parliament_bills** - Пошук законопроєктів
   - За запитом
   - За статусом (registered, adopted, etc.)
   - За ініціатором
   - За комітетом
   - За датами

2. **get_deputy_info** - Інформація про депутатів
   - За іменем
   - За RADA ID
   - З історією голосувань
   - З помічниками

3. **search_legislation_text** - Пошук у законодавстві
   - За псевдонімами (constitution, цивільний кодекс)
   - За номером закону
   - За статтею
   - З судовими цитатами

4. **analyze_voting_record** - Аналіз голосувань
   - За депутатом
   - За періодом
   - За законопроєктом
   - З AI-аналізом паттернів

## 🚀 Запуск тестів

### Підготовка

1. **Запустити локальне середовище:**

```bash
cd deployment
./manage-gateway.sh start local
```

2. **Перевірити статус сервісів:**

```bash
# SecondLayer backend
curl http://localhost:3000/health

# RADA MCP
curl http://localhost:3001/health
```

3. **Налаштувати змінні оточення** (опціонально):

```bash
export TEST_BASE_URL="http://localhost:3000"
export TEST_API_KEY="test-key-123"
export RADA_TEST_BASE_URL="http://localhost:3001"
export RADA_TEST_API_KEY="test-key-123"
```

### Запуск всіх тестів

```bash
# Зробити скрипт виконуваним
chmod +x run-all-tests.sh

# Запустити всі тести
./run-all-tests.sh
```

### Запуск окремих тестів

**SecondLayer Backend:**

```bash
cd mcp_backend
npm test -- src/api/__tests__/all-tools-integration.test.ts
```

**RADA MCP:**

```bash
cd mcp_rada
npm test -- src/api/__tests__/all-rada-tools-integration.test.ts
```

**Конкретний тест:**

```bash
cd mcp_backend
npm test -- src/api/__tests__/all-tools-integration.test.ts -t "search_legal_precedents"
```

### Запуск з детальним логуванням

```bash
cd mcp_backend
npm test -- src/api/__tests__/all-tools-integration.test.ts --verbose
```

## 📊 Очікувані результати

### SecondLayer Backend

- ✅ Health Check (2 тести)
- ✅ Pipeline Core Tools (4 тести)
- ✅ Search and Precedent Tools (6 тестів)
- ✅ Document Management Tools (4 тести)
- ✅ Analytics Tools (3 тести)
- ✅ Legislation Tools (7 тестів)
- ✅ Procedural Tools (3 тести)
- ✅ Document Processing Tools (4 тести)
- ✅ Advanced Tools (3 тести)
- ✅ Error Handling (3 тести)

**Всього:** ~39 тестів

### RADA MCP

- ✅ Health Check (2 тести)
- ✅ search_parliament_bills (6 тестів)
- ✅ get_deputy_info (6 тестів)
- ✅ search_legislation_text (7 тестів)
- ✅ analyze_voting_record (5 тестів)
- ✅ Error Handling (4 тести)
- ✅ Performance Tests (2 тести)
- ✅ Caching Tests (1 тест)

**Всього:** ~33 тести

## 🔍 Структура тестів

### Шаблон тесту

```typescript
test('should perform specific action', async () => {
  const result = await callTool('tool_name', {
    parameter1: 'value1',
    parameter2: 'value2',
  });

  expect(result).toBeDefined();
  expect(result.expected_field).toBeDefined();
  // Additional assertions
}, timeout);
```

### Timeout значення

- Прості запити: 10-20 секунд
- Складні пошуки: 30 секунд
- AI аналіз: 60 секунд
- Bulk операції: 120 секунд

## ⚠️ Важливі зауваження

### Залежності від зовнішніх API

Деякі тести залежать від зовнішніх API:

1. **ZakonOnline API** - для пошуку судових рішень
2. **RADA Open Data API** - для парламентських даних
3. **OpenAI API** - для AI аналізу (опціонально)

Якщо API недоступні, тести можуть провалитися або бути пропущені.

### Вартість виконання

Деякі тести використовують платні API:

- **get_legal_advice**: $0.10-$0.30 за виклик
- **analyze_voting_record** (з AI): $0.02-$0.10
- **bulk_ingest_court_decisions**: залежить від кількості

**Рекомендація:** Використовуйте обмежені набори даних для тестів.

### Продуктивність

- Кеш Redis прискорює повторні запити
- Перший запит завжди повільніший за наступні
- Concurrent запити можуть бути обмежені rate limiting

## 🐛 Налагодження

### Перевірка з'єднання

```bash
# Backend health
curl -H "Authorization: Bearer test-key-123" \
  http://localhost:3000/health

# List tools
curl -H "Authorization: Bearer test-key-123" \
  http://localhost:3000/api/tools | jq '.'

# Test specific tool
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"query": "test"}' \
  http://localhost:3000/api/tools/classify_intent
```

### Перегляд логів

```bash
# Backend logs
docker logs secondlayer-app-local -f

# RADA logs
docker logs rada-mcp-app-local -f
```

### Перезапуск сервісів

```bash
cd deployment
./manage-gateway.sh restart local
```

## 📝 Додавання нових тестів

### Додати тест для нового інструменту

1. Відкрити відповідний файл тестів
2. Додати новий describe блок або test:

```typescript
describe('new_tool_name', () => {
  test('should perform expected action', async () => {
    const result = await callTool('new_tool_name', {
      param1: 'value1',
    });

    expect(result).toBeDefined();
    expect(result.expected_output).toBeDefined();
  });
});
```

3. Запустити тест:

```bash
npm test -- path/to/test.test.ts -t "new_tool_name"
```

## 📈 CI/CD Інтеграція

### GitHub Actions

Приклад workflow:

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

## 📚 Додаткові ресурси

- [MCP Protocol Documentation](https://modelcontextprotocol.io/)
- [Jest Testing Framework](https://jestjs.io/)
- [Axios HTTP Client](https://axios-http.com/)
- [SecondLayer API Documentation](./CLAUDE.md)

## 🤝 Внесок

При додаванні нових інструментів, обов'язково додайте тести:

1. Базовий тест функціональності
2. Тест з різними параметрами
3. Тест обробки помилок
4. Тест продуктивності (якщо критично)

## 📞 Підтримка

Якщо тести не проходять:

1. Перевірте статус сервісів (health endpoints)
2. Перевірте логи контейнерів
3. Перевірте API ключі в `.env.local`
4. Перезапустіть локальне середовище
5. Створіть issue в GitHub з логами помилок
