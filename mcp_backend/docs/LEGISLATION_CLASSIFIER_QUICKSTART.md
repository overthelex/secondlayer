# Quick Start: AI Legislation Classifier

## Что это?

AI-классификатор автоматически определяет кодекс и номер статьи из сложных запросов, где regexp не справляется.

## Примеры

### ✅ Работало раньше (regexp)
```
"ст. 354 ЦПК"
"стаття 625 ЦК"
```

### ✅ Теперь тоже работает (AI)
```
"стаття 44 податкового кодексу"
"124 стаття про строки в цивільному процесі"
"частина 3 статті 44 ПКУ"
```

## Как использовать

### 1. В MCP Tool

```json
{
  "query": "стаття 44 податкового кодексу"
}
```

### 2. Через HTTP API

```bash
curl -X POST http://localhost:3000/api/tools/get_legislation_section \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "стаття 44 податкового кодексу"}'
```

### 3. В коде

```typescript
const result = await legislationService.parseArticleReferenceWithAI(
  "стаття 44 податкового кодексу"
);

// Результат:
// {
//   radaId: "2755-17",
//   articleNumber: "44",
//   source: "ai",
//   confidence: 0.95
// }
```

## Настройка

### Обязательно

```bash
OPENAI_API_KEY=sk-...
```

### Опционально (для кэширования)

```bash
REDIS_URL=redis://localhost:6379
```

## Проверка

```bash
# 1. Запустить сервер
npm run dev:http

# 2. Протестировать
curl -X POST http://localhost:3000/api/tools/get_legislation_section \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key" \
  -d '{"query": "стаття 44 податкового кодексу"}'

# Ожидаемый ответ:
# {
#   "rada_id": "2755-17",
#   "article_number": "44",
#   "title": "Загальні засади податкового консультування",
#   "resolved_from": {
#     "method": "ai",
#     "confidence": 0.95
#   }
# }
```

## Стоимость

- **С кэшем (Redis)**: ~$0.00003 за запрос
- **Без кэша**: ~$0.00015 за запрос

**Рекомендация**: используйте Redis для экономии 80% стоимости.

## Troubleshooting

### Ошибка: "OpenAI API key not configured"

```bash
export OPENAI_API_KEY=sk-...
```

### Низкая уверенность (confidence < 0.7)

Запрос слишком неоднозначный. Примеры:
- ❌ "стаття про строки" (какой кодекс?)
- ✅ "стаття 124 про строки в цивільному процесі" (понятно, что ЦПК)

### Redis не подключается

Система продолжит работать без кэша. Проверьте:
```bash
redis-cli ping
```

## Документация

Полная документация: [AI_LEGISLATION_CLASSIFICATION.md](./AI_LEGISLATION_CLASSIFICATION.md)
