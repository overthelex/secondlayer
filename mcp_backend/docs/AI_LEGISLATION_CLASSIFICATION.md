# AI-Powered Legislation Classification

## Обзор

Новая функциональность AI-классификации законодательства использует OpenAI для определения кодекса и номера статьи в случаях, когда regexp не может точно распознать запрос.

## Проблема

Ранее система использовала только regexp для определения ссылок на законодательство типа:
- ✅ "ст. 354 ЦПК" - работало
- ✅ "стаття 625 ЦК" - работало
- ❌ "стаття 44 податкового кодексу" - **НЕ** работало
- ❌ "124 стаття про строки в цивільному процесі" - **НЕ** работало
- ❌ "частина 3 статті 44 ПКУ" - частично работало

## Решение

Система теперь использует двухэтапный подход:

1. **Первый этап (regexp)** - быстрая проверка через регулярные выражения
2. **Второй этап (AI fallback)** - если regexp не сработал, используется OpenAI для классификации

## Архитектура

### Компоненты

```
┌─────────────────────────────┐
│   LegislationTools          │
│   (API Layer)               │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│   LegislationService        │
│   (Business Logic)          │
└──────────┬──────────────────┘
           │
           ├─────────────────────────────┐
           ▼                             ▼
┌──────────────────────┐    ┌───────────────────────┐
│ parseLegislation     │    │ LegislationClassifier │
│ Reference (regexp)   │    │ (AI Classification)   │
└──────────────────────┘    └───────┬───────────────┘
                                    │
                                    ▼
                            ┌───────────────┐
                            │ Redis Cache   │
                            │ (Optional)    │
                            └───────────────┘
```

### Файлы

- **`services/legislation-classifier.ts`** - AI-классификатор
- **`services/legislation-service.ts`** - обновлен для поддержки AI
- **`api/legislation-tools.ts`** - обновлен для использования AI
- **`utils/redis-client.ts`** - утилита для Redis

## Использование

### 1. В коде (TypeScript)

```typescript
import { LegislationService } from './services/legislation-service';
import { getRedisClient } from './utils/redis-client';

// Инициализация
const db = new Pool(/* config */);
const embeddingService = new EmbeddingService();
const redis = await getRedisClient();

const legislationService = new LegislationService(
  db,
  embeddingService,
  redis // опционально
);

// Использование с AI fallback
const result = await legislationService.parseArticleReferenceWithAI(
  "стаття 44 податкового кодексу"
);

if (result) {
  console.log(`Код: ${result.radaId}`);
  console.log(`Стаття: ${result.articleNumber}`);
  console.log(`Метод: ${result.source}`); // 'regexp' или 'ai'
  console.log(`Впевненість: ${result.confidence}`); // тільки для 'ai'
}
```

### 2. Через MCP Tool: `get_legislation_section`

```json
{
  "query": "стаття 44 податкового кодексу про оподаткування"
}
```

Відповідь:
```json
{
  "rada_id": "2755-17",
  "article_number": "44",
  "title": "Загальні засади податкового консультування",
  "full_text": "...",
  "url": "https://zakon.rada.gov.ua/laws/show/2755-17#n44",
  "resolved_from": {
    "query": "стаття 44 податкового кодексу про оподаткування",
    "method": "ai",
    "confidence": 0.95
  }
}
```

### 3. Через HTTP API

```bash
curl -X POST https://mcp.legal.org.ua/api/tools/get_legislation_section \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "частина 3 статті 124 цивільного процесуального кодексу"
  }'
```

## Поддерживаемые кодексы

| Код   | Rada ID   | Полное название |
|-------|-----------|-----------------|
| ЦПК   | 1618-15   | Цивільний процесуальний кодекс України |
| ГПК   | 1798-12   | Господарський процесуальний кодекс України |
| КАС   | 2747-15   | Кодекс адміністративного судочинства України |
| КПК   | 4651-17   | Кримінальний процесуальний кодекс України |
| ЦК    | 435-15    | Цивільний кодекс України |
| ГК    | 436-15    | Господарський кодекс України |
| ПКУ   | 2755-17   | Податковий кодекс України |
| КЗпП  | 322-08    | Кодекс законів про працю України |
| СК    | 2947-14   | Сімейний кодекс України |
| ЗК    | 2768-14   | Земельний кодекс України |
| КК    | 2341-14   | Кримінальний кодекс України |

## Примеры запросов

### Простые запросы (работает через regexp)

- "ст. 354 ЦПК"
- "стаття 625 ЦК"
- "ЦПК ст. 124"
- "1618-15 ст. 354"

### Сложные запросы (работает через AI)

- "стаття 44 податкового кодексу"
- "124 стаття про строки в цивільному процесі"
- "частина 3 статті 44 ПКУ про консультування"
- "процесуальні строки стаття 124"
- "стаття про апеляцію номер 354"

## Кэширование

Результаты AI-классификации кэшируются в Redis на 7 дней для:
- Экономии вызовов OpenAI API
- Ускорения повторных запросов
- Снижения стоимости

### Настройка кэша

```typescript
// В LegislationClassifier
private cacheTTL = 7 * 24 * 60 * 60; // 7 дней
private cachePrefix = 'leg_classify:';
```

### Очистка кэша

```bash
# Очистить весь кэш классификации
redis-cli --scan --pattern "leg_classify:*" | xargs redis-cli del

# Или через код
import { getRedisClient } from './utils/redis-client';
const redis = await getRedisClient();
if (redis) {
  const keys = await redis.keys('leg_classify:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
```

## Конфигурация

### Переменные окружения

```bash
# OpenAI (обязательно)
OPENAI_API_KEY=sk-...
OPENAI_MODEL_QUICK=gpt-4o-mini  # Модель для быстрой классификации

# Redis (опционально, для кэширования)
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379
```

### Порог уверенности

По умолчанию результаты AI с уверенностью < 0.7 отклоняются:

```typescript
const result = await legislationService.parseArticleReferenceWithAI(
  query,
  0.7  // confidence threshold (0.0 - 1.0)
);
```

## Стоимость

### Модель: gpt-4o-mini

- **Input**: $0.15 / 1M tokens
- **Output**: $0.60 / 1M tokens

### Средний запрос

- Промпт: ~800 tokens
- Ответ: ~50 tokens
- **Стоимость**: ~$0.00015 за запрос

### С кэшированием

При Redis кэше повторные запросы **бесплатны**.

Ожидаемое соотношение cache hit/miss: 80/20
- **Эффективная стоимость**: ~$0.00003 за запрос

## Отладка

### Логирование

```typescript
logger.info('[LegislationClassifier] Classifying query via OpenAI', {
  query: query.substring(0, 100),
  budget: 'quick'
});

logger.info('[LegislationClassifier] Classification result', {
  query: query.substring(0, 50),
  rada_id: classification.rada_id,
  article: classification.article_number,
  confidence: classification.confidence,
  code: classification.code_name
});
```

### Проверка работы

```bash
# Проверить Redis подключение
redis-cli ping

# Посмотреть кэш классификации
redis-cli --scan --pattern "leg_classify:*" | head -10

# Проверить содержимое кэша
redis-cli get "leg_classify:стаття 44 податкового кодексу"
```

## Тестирование

### Unit тесты

```typescript
import { LegislationClassifier } from './services/legislation-classifier';

describe('LegislationClassifier', () => {
  it('should classify complex query', async () => {
    const classifier = new LegislationClassifier();
    const result = await classifier.classify(
      'стаття 44 податкового кодексу'
    );

    expect(result.rada_id).toBe('2755-17');
    expect(result.article_number).toBe('44');
    expect(result.confidence).toBeGreaterThan(0.7);
  });
});
```

### Integration тесты

```bash
# Через curl
curl -X POST http://localhost:3000/api/tools/get_legislation_section \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key" \
  -d '{"query": "стаття 44 податкового кодексу"}'
```

## Мониторинг

### Метрики

- **Regexp success rate**: % запросов, обработанных через regexp
- **AI fallback rate**: % запросов, переданных в AI
- **Cache hit rate**: % запросов из кэша
- **Average confidence**: средняя уверенность AI-классификации
- **Cost per request**: стоимость обработки запроса

### Alerts

- AI confidence < 0.5 (более 10% запросов)
- Redis недоступен
- OpenAI API errors

## Миграция

Изменения обратно совместимы:

1. **Без изменений**: старый код продолжит работать
2. **Новый метод**: используйте `parseArticleReferenceWithAI()` для AI-классификации
3. **Redis опционален**: работает без кэша (но медленнее и дороже)

## Ограничения

1. **Язык**: поддерживается только украинский язык
2. **Кодексы**: только 11 основных кодексов (можно расширить)
3. **AI модель**: требует OpenAI API key
4. **Стоимость**: ~$0.00003 за запрос с кэшем

## Roadmap

- [ ] Поддержка других законов (не только кодексов)
- [ ] Извлечение частей/пунктов статьи
- [ ] Batch classification для множественных запросов
- [ ] Fallback на локальную модель (без OpenAI)
- [ ] Metrics dashboard для мониторинга
