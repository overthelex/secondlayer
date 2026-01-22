# Руководство по выбору моделей в SecondLayer

**Дата:** 2026-01-18
**Статус:** Документация системы выбора моделей

---

## 📋 Оглавление

1. [Как работает выбор модели](#как-работает-выбор-модели)
2. [Два режима конфигурации](#два-режима-конфигурации)
3. [Где используются модели](#где-используются-модели)
4. [Настройка через переменные окружения](#настройка-через-переменные-окружения)
5. [Примеры конфигураций](#примеры-конфигураций)
6. [Рекомендации](#рекомендации)

---

## 🎯 Как работает выбор модели

### Система имеет 3 уровня "бюджета рассуждений":

| Бюджет | Когда используется | Задачи | Рекомендуемая модель |
|--------|-------------------|---------|---------------------|
| **quick** | Короткие запросы (< 20 символов) | Классификация ключевых слов, простые запросы | gpt-4o-mini или claude-haiku-4.5 |
| **standard** | Средние запросы (20-200 символов) | Анализ запроса, классификация намерений | gpt-4o-mini или claude-sonnet-4.5 |
| **deep** | Длинные запросы (> 200 символов), большой контекст | Глубокий анализ, извлечение секций документов | gpt-4o или claude-opus-4.5 |

### Автоматическое определение бюджета:

**Файл:** `mcp_backend/src/utils/model-selector.ts:103-131`

```typescript
static recommendBudget(params: {
  queryLength: number;
  requiresStructuredOutput?: boolean;
  contextSize?: number;
  userSpecified?: 'quick' | 'standard' | 'deep';
}): 'quick' | 'standard' | 'deep' {
  // Пользователь может переопределить
  if (params.userSpecified) {
    return params.userSpecified;
  }

  // Очень короткие запросы
  if (params.queryLength < 20) {
    return 'quick';
  }

  // Длинные запросы или большой контекст
  if (params.queryLength > 200 || (params.contextSize && params.contextSize > 5000)) {
    return 'deep';
  }

  // По умолчанию - standard
  return 'standard';
}
```

---

## ⚙️ Два режима конфигурации

### Режим 1: SINGLE MODEL (Одна модель для всех задач)

**Когда используется:** Установлена переменная `OPENAI_MODEL`

**Как работает:**
```typescript
// model-selector.ts строка 29-32
if (this.SINGLE_MODEL) {
  logger.debug('Using single model for all budgets', { model: this.SINGLE_MODEL, budget });
  return this.SINGLE_MODEL;
}
```

**Пример .env:**
```bash
OPENAI_MODEL=gpt-4o  # ← Одна модель для всех задач
```

**Результат:**
- quick → gpt-4o
- standard → gpt-4o
- deep → gpt-4o

✅ **Плюсы:**
- Простая конфигурация
- Предсказуемое поведение
- Легко дебажить

❌ **Минусы:**
- Неоптимальная стоимость (используется дорогая модель даже для простых задач)
- Нет гибкости

---

### Режим 2: DYNAMIC MODEL SELECTION (Разные модели для разных задач)

**Когда используется:** НЕ установлена `OPENAI_MODEL`, но установлены специфичные переменные

**Как работает:**
```typescript
// model-selector.ts строка 36-45
const models = {
  quick: this.QUICK_MODEL,      // из OPENAI_MODEL_QUICK
  standard: this.STANDARD_MODEL, // из OPENAI_MODEL_STANDARD
  deep: this.DEEP_MODEL,         // из OPENAI_MODEL_DEEP
};

const selectedModel = models[budget];
logger.debug('Selected chat model', { budget, model: selectedModel });

return selectedModel;
```

**Пример .env:**
```bash
# НЕ устанавливайте OPENAI_MODEL
OPENAI_MODEL_QUICK=gpt-4o-mini       # Дешевая модель для простых задач
OPENAI_MODEL_STANDARD=gpt-4o-mini    # Средняя модель
OPENAI_MODEL_DEEP=gpt-4o             # Мощная модель для сложных задач
```

**Результат:**
- quick → gpt-4o-mini ($0.15 input / $0.60 output)
- standard → gpt-4o-mini ($0.15 input / $0.60 output)
- deep → gpt-4o ($2.50 input / $10.00 output)

✅ **Плюсы:**
- Оптимизация стоимости (дешевые модели для простых задач)
- Гибкость конфигурации
- Можно использовать модели разных провайдеров (OpenAI + Claude)

❌ **Минусы:**
- Более сложная конфигурация
- Нужно следить за несколькими переменными

---

## 📍 Где используются модели

### 1. Query Planner (Классификация намерений)

**Файл:** `mcp_backend/src/services/query-planner.ts:20-31`

```typescript
async classifyIntent(query: string, budget: 'quick' | 'standard' | 'deep' = 'standard'): Promise<QueryIntent> {
  // Для quick бюджета - простой keyword matching (БЕЗ модели)
  if (budget === 'quick') {
    return this.quickIntentClassification(query);
  }

  // Для standard/deep - используется LLM
  const model = ModelSelector.getChatModel(budget);  // ← ВЫБОР МОДЕЛИ

  const response = await this.openaiManager.executeWithRetry(async (client) => {
    return await client.chat.completions.create({
      model: model,  // ← ИСПОЛЬЗУЕТСЯ ВЫБРАННАЯ МОДЕЛЬ
      messages: [...],
      temperature: 0.3,
      max_tokens: 500,
    });
  });
}
```

**Примеры использования:**
- `budget='quick'` → regex keyword matching (БЕЗ API вызова)
- `budget='standard'` → gpt-4o-mini (дешево)
- `budget='deep'` → gpt-4o (дорого, но точнее)

---

### 2. Embedding Service (Векторизация текста)

**Файл:** `mcp_backend/src/services/embedding-service.ts:52-60`

```typescript
async generateEmbedding(text: string): Promise<number[]> {
  const model = ModelSelector.getEmbeddingModel();  // ← ВСЕГДА ОДНА МОДЕЛЬ!

  const response = await this.openaiManager.executeWithRetry(async (client) => {
    return await client.embeddings.create({
      model,  // ← text-embedding-ada-002 или другая embedding модель
      input: text,
    });
  });

  return response.data[0].embedding;
}
```

**Важно:** Embedding модель НЕ меняется, потому что:
- Векторы разных моделей несовместимы
- Нельзя искать в Qdrant, если векторы созданы разными моделями
- Размерность должна быть одинаковой (ada-002 = 1536, text-embedding-3-large = 3072)

**Настройка:**
```bash
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002  # Не меняйте после создания векторов!
```

**Альтернативы:**
- `text-embedding-ada-002`: $0.10/MTok (1536 dim) - ТЕКУЩАЯ
- `text-embedding-3-small`: $0.02/MTok (1536 dim) - **5x ДЕШЕВЛЕ!**
- `text-embedding-3-large`: $0.13/MTok (3072 dim) - самая точная

---

### 3. Semantic Sectionizer (Извлечение секций документов)

**Файл:** `mcp_backend/src/services/semantic-sectionizer.ts:212-232`

```typescript
private async llmAssistedExtraction(text: string): Promise<DocumentSection[]> {
  const response = await this.openaiManager.executeWithRetry(async (client) => {
    // ВСЕГДА использует deep модель для точности
    const model = ModelSelector.getChatModel('deep');  // ← ЖЕСТКО ЗАКОДИРОВАНО 'deep'

    return await client.chat.completions.create({
      model,  // ← gpt-4o или claude-opus-4.5
      messages: [
        {
          role: 'system',
          content: `Ти експерт з аналізу юридичних документів. Розбий текст на семантичні секції...`,
        },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
      max_tokens: 2000,
    });
  });
}
```

**Почему 'deep'?**
- Юридические документы сложные
- Нужна высокая точность извлечения секций
- Ошибки дорого обходятся (неправильная секция = неправильный анализ)

---

### 4. HTML Parser (Извлечение ключевых слов из HTML)

**Файл:** `mcp_backend/src/utils/html-parser.ts`

Использует `ModelSelector.getChatModel('quick')` для быстрого извлечения ключевых слов из HTML.

---

## 🔧 Настройка через переменные окружения

### Текущая конфигурация (.env):

```bash
# ❌ ТЕКУЩАЯ КОНФИГУРАЦИЯ - SINGLE MODEL
OPENAI_MODEL=gpt-4o

# ✅ РЕКОМЕНДУЕМАЯ КОНФИГУРАЦИЯ - DYNAMIC SELECTION
# Закомментируйте или удалите OPENAI_MODEL и используйте:
OPENAI_MODEL_QUICK=gpt-4o-mini       # $0.15/$0.60
OPENAI_MODEL_STANDARD=gpt-4o-mini    # $0.15/$0.60
OPENAI_MODEL_DEEP=gpt-4o             # $2.50/$10.00

# Embedding модель (НЕ МЕНЯЙТЕ после создания векторов!)
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002  # $0.10/MTok
```

### Docker Compose конфигурация:

**Файл:** `mcp_backend/docker-compose.yml:67-76`

```yaml
environment:
  # OpenAI Configuration
  OPENAI_API_KEY: ${OPENAI_API_KEY}
  OPENAI_API_KEY2: ${OPENAI_API_KEY2:-}
  OPENAI_EMBEDDING_MODEL: ${OPENAI_EMBEDDING_MODEL:-text-embedding-ada-002}

  # Dynamic model selection (recommended) ✅
  OPENAI_MODEL_QUICK: ${OPENAI_MODEL_QUICK:-gpt-4o-mini}
  OPENAI_MODEL_STANDARD: ${OPENAI_MODEL_STANDARD:-gpt-4o-mini}
  OPENAI_MODEL_DEEP: ${OPENAI_MODEL_DEEP:-gpt-4o}

  # OR single model for all tasks ❌
  # OPENAI_MODEL: ${OPENAI_MODEL:-gpt-4o-mini}
```

**Значения по умолчанию (если не установлены в .env):**
- `OPENAI_MODEL_QUICK`: gpt-4o-mini
- `OPENAI_MODEL_STANDARD`: gpt-4o-mini
- `OPENAI_MODEL_DEEP`: gpt-4o
- `OPENAI_EMBEDDING_MODEL`: text-embedding-ada-002

---

## 💡 Примеры конфигураций

### Конфигурация 1: Максимальная экономия 💰

```bash
# .env
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small  # 5x дешевле!
```

**Стоимость:**
- Chat: $0.15 input / $0.60 output
- Embeddings: $0.02 / MTok

**Когда использовать:**
- Прототипирование
- Разработка
- Небольшая нагрузка
- Некритичная точность

---

### Конфигурация 2: Баланс цена/качество ✅ (РЕКОМЕНДУЕТСЯ)

```bash
# .env
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002
```

**Стоимость:**
- Quick/Standard: $0.15 / $0.60 (дешево)
- Deep: $2.50 / $10.00 (точно)
- Embeddings: $0.10 / MTok

**Когда использовать:**
- Production окружение
- Средняя и высокая нагрузка
- Нужен баланс стоимости и качества

---

### Конфигурация 3: Максимальное качество 🎯

```bash
# .env
OPENAI_MODEL_QUICK=gpt-4o
OPENAI_MODEL_STANDARD=gpt-4o
OPENAI_MODEL_DEEP=gpt-4o
OPENAI_EMBEDDING_MODEL=text-embedding-3-large
```

**Стоимость:**
- Chat: $2.50 input / $10.00 output
- Embeddings: $0.13 / MTok

**Когда использовать:**
- Критичные юридические анализы
- Максимальная точность важнее стоимости
- Малый объем запросов

---

### Конфигурация 4: Гибридная (OpenAI + Claude) 🔀

```bash
# .env - можно использовать РАЗНЫЕ провайдеры
OPENAI_MODEL_QUICK=gpt-4o-mini           # OpenAI для быстрых задач
OPENAI_MODEL_STANDARD=claude-haiku-4.5   # Claude для средних задач
OPENAI_MODEL_DEEP=claude-opus-4.5        # Claude для сложных задач
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002
```

**⚠️ ВАЖНО:** Для использования Claude нужно интегрировать Anthropic SDK!

**Стоимость:**
- Quick: $0.15 / $0.60 (OpenAI)
- Standard: $1.00 / $5.00 (Claude Haiku)
- Deep: $5.00 / $25.00 (Claude Opus)

---

## 🎯 Рекомендации

### 1. Для разработки:

```bash
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o-mini
```

**Экономия:** ~90% на всех запросах

---

### 2. Для production (рекомендуется):

```bash
# Удалите или закомментируйте OPENAI_MODEL
# OPENAI_MODEL=gpt-4o  ← УДАЛИТЬ!

# Используйте dynamic selection
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o
```

**Экономия:** ~70% на большинстве запросов

---

### 3. Миграция на более дешевые embeddings:

**⚠️ ВНИМАНИЕ:** Можно делать ТОЛЬКО если в Qdrant нет векторов или вы готовы переиндексировать ВСЁ!

```bash
# Шаг 1: Очистите Qdrant (если есть данные)
docker exec secondlayer-qdrant curl -X DELETE http://localhost:6333/collections/legal_sections

# Шаг 2: Измените модель
OPENAI_EMBEDDING_MODEL=text-embedding-3-small  # 5x дешевле!

# Шаг 3: Переиндексируйте все документы
npm run reindex-all
```

**Экономия:** $0.10 → $0.02 (80% экономии на embeddings)

---

### 4. Мониторинг и оптимизация:

Используйте SQL для анализа реального использования:

```sql
SELECT
  call->>'model' AS model,
  call->>'task' AS task,
  COUNT(*) AS calls,
  SUM((call->>'cost_usd')::numeric) AS total_cost
FROM cost_tracking,
     jsonb_array_elements(openai_calls) AS call
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY model, task
ORDER BY total_cost DESC;
```

**Результат:**
```
model          | task                   | calls | total_cost
---------------|------------------------|-------|------------
gpt-4o         | deep_analysis          | 145   | $2.45
gpt-4o-mini    | intent_classification  | 432   | $0.10
gpt-4o         | section_extraction     | 89    | $0.78
```

**Действие:** Если `deep_analysis` слишком дорого → переключите на `gpt-4o-mini` для тестирования.

---

## 📊 Сравнительная таблица стоимости

| Конфигурация | 1000 quick запросов | 1000 standard запросов | 100 deep запросов | ИТОГО |
|--------------|---------------------|------------------------|-------------------|-------|
| **All gpt-4o** | ~$6.00 | ~$6.00 | ~$6.00 | **~$18.00** |
| **Dynamic (рекомендуется)** | ~$0.18 | ~$0.18 | ~$6.00 | **~$6.36** |
| **All gpt-4o-mini** | ~$0.18 | ~$0.18 | ~$0.18 | **~$0.54** |

**Экономия с dynamic конфигурацией:** 65% vs all gpt-4o

---

## 🔍 Проверка текущей конфигурации

### Узнать какая модель используется:

```bash
# В контейнере
docker exec secondlayer-app env | grep OPENAI_MODEL

# Результат если SINGLE MODEL:
OPENAI_MODEL=gpt-4o

# Результат если DYNAMIC SELECTION:
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o
```

### Проверить логи использования:

```bash
docker logs secondlayer-app | grep "Selected chat model"
```

**Пример вывода:**
```
Selected chat model { budget: 'quick', model: 'gpt-4o-mini' }
Selected chat model { budget: 'standard', model: 'gpt-4o-mini' }
Selected chat model { budget: 'deep', model: 'gpt-4o' }
```

---

## 📝 Резюме

### ✅ Текущее состояние:

1. **Система выбора моделей работает правильно**
2. **Поддерживает 2 режима:** Single Model и Dynamic Selection
3. **Отслеживает использование каждой модели** в базе данных
4. **Считает точную стоимость** для каждой модели

### ⚙️ Текущая конфигурация (.env):

```bash
OPENAI_MODEL=gpt-4o  # ← SINGLE MODEL режим
```

**Это означает:** ВСЕ задачи используют gpt-4o ($2.50/$10.00)

### 💡 Рекомендация:

**Переключитесь на Dynamic Selection для экономии:**

```bash
# Удалите эту строку из .env:
# OPENAI_MODEL=gpt-4o

# Добавьте эти строки:
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o
```

**Экономия:** ~65% на большинстве запросов

---

**Последнее обновление:** 2026-01-18
**Автор:** SecondLayer Team
