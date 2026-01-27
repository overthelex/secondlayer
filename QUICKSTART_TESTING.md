# 🚀 Швидкий старт: Тестування MCP інструментів

## 1️⃣ Запустити локальні сервіси

```bash
cd deployment
./manage-gateway.sh start local
```

Перевірте що сервіси запущені:
```bash
curl http://localhost:3000/health  # SecondLayer backend
curl http://localhost:3001/health  # RADA MCP
```

## 2️⃣ Запустити всі тести

```bash
cd ..  # повернутися в корінь проекту
./run-all-tests.sh
```

## 3️⃣ Або тестувати окремі сервіси

### SecondLayer Backend (34 інструменти)

```bash
cd mcp_backend
npm test -- src/api/__tests__/all-tools-integration.test.ts
```

### RADA MCP (4 інструменти)

```bash
cd mcp_rada
npm test -- src/api/__tests__/all-rada-tools-integration.test.ts
```

## 4️⃣ Тестувати конкретний інструмент

```bash
cd mcp_backend
npm test -- src/api/__tests__/all-tools-integration.test.ts -t "search_legal_precedents"
```

## 📊 Що тестується?

### SecondLayer Backend (34 інструменти)
- ✅ Пошук прецедентів та судової практики
- ✅ Робота з документами (отримання, парсинг, аналіз)
- ✅ Аналітика (підрахунок справ, графи цитувань)
- ✅ Законодавство (інтеграція з RADA)
- ✅ Процесуальні інструменти (строки, чеклісти, розрахунки)
- ✅ Обробка документів (PDF/DOCX/HTML)
- ✅ AI аналіз (get_legal_advice)

### RADA MCP (4 інструменти)
- ✅ Пошук законопроєктів
- ✅ Інформація про депутатів
- ✅ Пошук у законодавстві
- ✅ Аналіз голосувань

## ⚙️ Налаштування (опціонально)

Створіть файл `.env.test`:

```bash
TEST_BASE_URL=http://localhost:3000
TEST_API_KEY=test-key-123
RADA_TEST_BASE_URL=http://localhost:3001
RADA_TEST_API_KEY=test-key-123
```

## 🐛 Що робити якщо тести не проходять?

1. **Перевірте логи:**
```bash
docker logs secondlayer-app-local -f
docker logs rada-mcp-app-local -f
```

2. **Перезапустіть сервіси:**
```bash
cd deployment
./manage-gateway.sh restart local
```

3. **Перевірте .env.local:**
```bash
cat deployment/.env.local
```

4. **Перевірте що API ключі налаштовані:**
- OPENAI_API_KEY
- ZAKONONLINE_API_TOKEN

## 📝 Детальна документація

Дивіться [TESTING.md](./TESTING.md) для повної документації.

## 🎯 Швидкий тест одного інструменту

Через curl:

```bash
# SecondLayer - classify_intent
curl -X POST http://localhost:3000/api/tools/classify_intent \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"query": "Хочу оскаржити рішення суду"}'

# RADA - get_deputy_info
curl -X POST http://localhost:3001/api/tools/get_deputy_info \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"name": "Федоров"}'
```

## 📈 Очікувані результати

- **SecondLayer:** ~39 тестів, ~2-5 хвилин виконання
- **RADA MCP:** ~33 тести, ~1-3 хвилини виконання

**Всього:** 72 інтеграційних тести для 38 MCP інструментів

## ✅ Успішне виконання

```
═══════════════════════════════════════════════════════
           Test Summary
═══════════════════════════════════════════════════════

Total Test Suites: 2
Passed: 2
Failed: 0

🎉 All tests passed!
```
