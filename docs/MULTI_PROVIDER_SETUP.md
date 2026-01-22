# Multi-Provider LLM Setup

**Дата создания:** 2026-01-18
**Статус:** ✅ Готово к использованию

## 📊 Резюме

SecondLayer теперь поддерживает **несколько LLM провайдеров** с автоматической ротацией и fallback:
- **OpenAI** (GPT-4o, GPT-4o-mini)
- **Anthropic** (Claude Opus 4.5, Sonnet 4.5, Haiku 4.5)

Система автоматически переключается между провайдерами при:
- Rate limits (429 errors)
- Authentication errors (401/403)
- API failures

---

## 🎯 Зачем это нужно?

### 1. **Повышенная надёжность**
- Если OpenAI недоступен → автоматически используется Anthropic
- Если закончились rate limits на одном ключе → переключение на следующий
- **Минимум downtime для пользователей**

### 2. **Гибкость в выборе моделей**
- Разные модели для разных задач
- Возможность выбрать самую дешёвую или самую мощную модель
- A/B тестирование разных провайдеров

### 3. **Оптимизация стоимости**
- Используйте дешёвые модели для простых задач
- Переключайтесь на мощные модели только когда нужно
- Автоматический выбор самой выгодной опции

---

## 🏗️ Архитектура

```
┌──────────────────────────────────────────────────────────┐
│                    LLMClientManager                       │
│              (Унифицированный интерфейс)                  │
└──────────────┬────────────────────────┬──────────────────┘
               │                        │
               ▼                        ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│  OpenAIClientManager     │  │ AnthropicClientManager   │
│                          │  │                          │
│  - API key rotation      │  │  - API key rotation      │
│  - Retry logic           │  │  - Retry logic           │
│  - Cost tracking         │  │  - Cost tracking         │
└──────────┬───────────────┘  └──────────┬───────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│    OpenAI SDK            │  │   Anthropic SDK          │
│  (gpt-4o, gpt-4o-mini)   │  │ (claude-opus, sonnet)    │
└──────────────────────────┘  └──────────────────────────┘
```

---

## ⚙️ Конфигурация

### Шаг 1: Получите API ключи

**OpenAI:**
1. Перейдите на https://platform.openai.com/api-keys
2. Создайте новый ключ (или используйте существующий)
3. Скопируйте ключ (начинается с `sk-proj-...`)

**Anthropic:**
1. Перейдите на https://console.anthropic.com/settings/keys
2. Создайте новый ключ
3. Скопируйте ключ (начинается с `sk-ant-...`)

### Шаг 2: Обновите `.env` файл

```bash
# mcp_backend/.env

# ============================================
# LLM PROVIDERS - API KEYS
# ============================================

# OpenAI (Primary Provider)
OPENAI_API_KEY=sk-proj-your-key-1
OPENAI_API_KEY2=sk-proj-your-key-2  # Optional: for rotation

# Anthropic (Secondary Provider / Fallback)
ANTHROPIC_API_KEY=sk-ant-your-key-1
ANTHROPIC_API_KEY2=sk-ant-your-key-2  # Optional: for rotation

# ============================================
# MODEL SELECTION
# ============================================

# OpenAI Models (Default Provider)
OPENAI_MODEL_QUICK=gpt-4o-mini        # $0.15/$0.60 per 1M tokens
OPENAI_MODEL_STANDARD=gpt-4o-mini     # $0.15/$0.60 per 1M tokens
OPENAI_MODEL_DEEP=gpt-4o              # $2.50/$10.00 per 1M tokens

# Anthropic Models (Alternative Provider)
ANTHROPIC_MODEL_QUICK=claude-haiku-4.5     # $1.00/$5.00 per 1M tokens
ANTHROPIC_MODEL_STANDARD=claude-sonnet-4.5  # $3.00/$15.00 per 1M tokens
ANTHROPIC_MODEL_DEEP=claude-opus-4.5        # $5.00/$25.00 per 1M tokens

# Embedding Model (MUST stay consistent!)
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002

# ============================================
# PROVIDER SELECTION STRATEGY
# ============================================
# Options:
#   - "openai-first"    (default) - Always try OpenAI first, fallback to Anthropic
#   - "anthropic-first" - Always try Anthropic first, fallback to OpenAI
#   - "round-robin"     - Alternate between providers
#   - "cheapest"        - Use cheapest option for each budget level

LLM_PROVIDER_STRATEGY=openai-first
```

### Шаг 3: Перезапустите сервисы

**Локально:**
```bash
cd mcp_backend
npm run dev:http
```

**Docker:**
```bash
cd mcp_backend
docker-compose down
docker-compose up -d --build
```

---

## 📋 Стратегии выбора провайдера

### 1. `openai-first` (По умолчанию)

**Описание:** Всегда пытается использовать OpenAI. Если OpenAI недоступен, переключается на Anthropic.

**Когда использовать:**
- У вас уже настроен OpenAI и он работает хорошо
- Вы хотите использовать Anthropic только как backup
- Ваш код оптимизирован под OpenAI API

**Пример поведения:**
```
Запрос → OpenAI (gpt-4o-mini)
  ├─ Успешно ✅ → Возвращаем результат
  └─ Ошибка ❌ → Fallback на Anthropic (claude-haiku-4.5) ✅
```

### 2. `anthropic-first`

**Описание:** Всегда пытается использовать Anthropic. Если Anthropic недоступен, переключается на OpenAI.

**Когда использовать:**
- Вы предпочитаете модели Claude
- У вас больше rate limits на Anthropic
- Вы тестируете качество Claude моделей

**Пример поведения:**
```
Запрос → Anthropic (claude-sonnet-4.5)
  ├─ Успешно ✅ → Возвращаем результат
  └─ Ошибка ❌ → Fallback на OpenAI (gpt-4o-mini) ✅
```

### 3. `round-robin` (TODO: реализовать)

**Описание:** Чередует провайдеров для равномерного распределения нагрузки.

**Пример поведения:**
```
Запрос 1 → OpenAI
Запрос 2 → Anthropic
Запрос 3 → OpenAI
Запрос 4 → Anthropic
...
```

### 4. `cheapest` (TODO: реализовать)

**Описание:** Автоматически выбирает самый дешёвый вариант для каждого budget level.

**Пример:**
| Budget | Самый дешёвый | Стоимость |
|--------|--------------|-----------|
| quick | gpt-4o-mini | $0.15/$0.60 |
| standard | gpt-4o-mini | $0.15/$0.60 |
| deep | gpt-4o | $2.50/$10.00 |

---

## 💰 Сравнение стоимости моделей

### Quick Budget (простые задачи)

| Модель | Input/1M | Output/1M | Примерная стоимость за запрос |
|--------|----------|-----------|-------------------------------|
| **gpt-4o-mini** (OpenAI) | $0.15 | $0.60 | **$0.0002** ⭐ ДЕШЕВЛЕ |
| claude-haiku-4.5 (Anthropic) | $1.00 | $5.00 | $0.0015 |

### Standard Budget (умеренные задачи)

| Модель | Input/1M | Output/1M | Примерная стоимость за запрос |
|--------|----------|-----------|-------------------------------|
| **gpt-4o-mini** (OpenAI) | $0.15 | $0.60 | **$0.0006** ⭐ ДЕШЕВЛЕ |
| claude-sonnet-4.5 (Anthropic) | $3.00 | $15.00 | $0.0090 |

### Deep Budget (сложные задачи)

| Модель | Input/1M | Output/1M | Примерная стоимость за запрос |
|--------|----------|-----------|-------------------------------|
| **gpt-4o** (OpenAI) | $2.50 | $10.00 | **$0.0200** ⭐ ДЕШЕВЛЕ |
| claude-opus-4.5 (Anthropic) | $5.00 | $25.00 | $0.0500 |

**Вывод:** OpenAI модели дешевле для всех budget levels, но Claude может давать лучшее качество для специфичных задач (юридический анализ, рассуждения).

---

## 🔄 Автоматический Fallback

### Когда происходит переключение провайдера?

1. **Rate Limit (429 error)**
   ```
   OpenAI: 429 Too Many Requests
   → Автоматическое переключение на Anthropic
   ```

2. **Authentication Error (401/403)**
   ```
   OpenAI: 401 Unauthorized (invalid key)
   → Автоматическое переключение на Anthropic
   ```

3. **API Timeout**
   ```
   OpenAI: Request timeout after 60s
   → Автоматическое переключение на Anthropic
   ```

4. **Ротация API ключей**
   ```
   OpenAI Key 1: 429 Rate Limit
   → Попытка с OpenAI Key 2
   → Если и Key 2 не работает → Anthropic
   ```

### Пример логов

```
[INFO] LLM Client Manager initialized { providers: ['openai', 'anthropic'] }
[DEBUG] Selected chat model { provider: 'openai', model: 'gpt-4o-mini', budget: 'standard' }
[WARN] Primary provider openai failed: Rate limit exceeded
[INFO] Falling back to anthropic
[DEBUG] Selected chat model { provider: 'anthropic', model: 'claude-sonnet-4.5', budget: 'standard' }
[INFO] ✅ Request completed successfully with anthropic
```

---

## 📊 Отслеживание стоимости

Все вызовы API (OpenAI и Anthropic) автоматически записываются в базу данных.

### SQL запрос для анализа использования провайдеров

```sql
-- Сколько токенов и денег потрачено на каждого провайдера
SELECT
  CASE
    WHEN call->>'model' LIKE 'gpt%' THEN 'OpenAI'
    WHEN call->>'model' LIKE 'claude%' THEN 'Anthropic'
    ELSE 'Unknown'
  END AS provider,
  call->>'model' AS model,
  COUNT(*) AS total_calls,
  SUM((call->>'prompt_tokens')::int) AS total_input_tokens,
  SUM((call->>'completion_tokens')::int) AS total_output_tokens,
  SUM((call->>'cost_usd')::numeric) AS total_cost_usd
FROM
  cost_tracking,
  jsonb_array_elements(openai_calls) AS call
WHERE
  created_at >= NOW() - INTERVAL '24 hours'
GROUP BY
  provider, model
ORDER BY
  total_cost_usd DESC;
```

**Пример результата:**

```
provider  | model             | total_calls | total_input | total_output | total_cost
----------|-------------------|-------------|-------------|--------------|------------
OpenAI    | gpt-4o-mini       | 432         | 324,567     | 87,234       | $0.10
OpenAI    | gpt-4o            | 145         | 582,340     | 198,456      | $2.45
Anthropic | claude-sonnet-4.5 | 23          | 67,890      | 23,456       | $0.56
Anthropic | claude-haiku-4.5  | 12          | 12,345      | 4,567        | $0.03
```

---

## 🧪 Тестирование

### Тест 1: Проверка доступности провайдеров

```bash
cd mcp_backend
node -e "
const { ModelSelector } = require('./dist/utils/model-selector.js');
const providers = ModelSelector.getAvailableProviders();
console.log('Available providers:', providers);
"
```

**Ожидаемый результат:**
```
Available providers: ['openai', 'anthropic']
```

### Тест 2: Выбор модели для каждого budget

```bash
node -e "
const { ModelSelector } = require('./dist/utils/model-selector.js');
console.log('Quick:', ModelSelector.getModelSelection('quick'));
console.log('Standard:', ModelSelector.getModelSelection('standard'));
console.log('Deep:', ModelSelector.getModelSelection('deep'));
"
```

**Ожидаемый результат:**
```
Quick: { provider: 'openai', model: 'gpt-4o-mini', budget: 'quick' }
Standard: { provider: 'openai', model: 'gpt-4o-mini', budget: 'standard' }
Deep: { provider: 'openai', model: 'gpt-4o', budget: 'deep' }
```

### Тест 3: Проверка fallback

```bash
# Временно укажите неверный OpenAI ключ
OPENAI_API_KEY=invalid node -e "
const { getLLMManager } = require('./dist/utils/llm-client-manager.js');
const llm = getLLMManager();
llm.chatCompletion({
  messages: [{ role: 'user', content: 'Test' }]
}, 'quick').then(res => console.log('Success:', res.provider));
"
```

**Ожидаемый результат:**
```
[WARN] Primary provider openai failed: Invalid API key
[INFO] Falling back to anthropic
Success: anthropic
```

---

## 📚 Примеры использования в коде

### Пример 1: Простой запрос с автоматическим выбором провайдера

```typescript
import { getLLMManager } from './utils/llm-client-manager.js';

const llm = getLLMManager();

const response = await llm.chatCompletion({
  messages: [
    { role: 'system', content: 'Ты юридический ассистент' },
    { role: 'user', content: 'Найди дела про развод' }
  ],
  temperature: 0.3,
}, 'standard'); // Budget: standard → gpt-4o-mini (OpenAI)

console.log(response.content); // Ответ модели
console.log(response.provider); // 'openai'
console.log(response.model); // 'gpt-4o-mini'
```

### Пример 2: Явное указание провайдера

```typescript
const response = await llm.chatCompletion({
  messages: [
    { role: 'user', content: 'Сложный юридический анализ' }
  ],
}, 'deep', 'anthropic'); // Используем Claude Opus 4.5

console.log(response.provider); // 'anthropic'
console.log(response.model); // 'claude-opus-4.5'
```

### Пример 3: Обработка fallback

```typescript
try {
  const response = await llm.chatCompletion({
    messages: [{ role: 'user', content: 'Тест' }]
  }, 'quick');

  console.log(`✅ Успешно с ${response.provider}`);
} catch (error) {
  console.error('❌ Оба провайдера недоступны:', error.message);
}
```

---

## 🚨 Troubleshooting

### Проблема: "No OpenAI API keys configured"

**Решение:**
1. Проверьте `.env` файл - есть ли `OPENAI_API_KEY`?
2. Перезапустите сервер после изменения `.env`

### Проблема: "No Anthropic API keys configured - Anthropic provider will be unavailable"

**Это warning, не ошибка!** Anthropic опционален. Если вы не планируете использовать Anthropic:
- Просто игнорируйте это сообщение
- Или добавьте ключи Anthropic в `.env`

### Проблема: Rate limit на обоих провайдерах

**Решение:**
1. Добавьте больше API ключей (OPENAI_API_KEY2, ANTHROPIC_API_KEY2)
2. Используйте стратегию `round-robin` для распределения нагрузки
3. Увеличьте rate limits в настройках API (платно)

### Проблема: "Failed to track usage"

Это не критическая ошибка. Запрос выполнился успешно, но не удалось записать метрики в БД.

**Проверьте:**
- Доступна ли PostgreSQL?
- Правильно ли настроен `DATABASE_URL`?

---

## 📊 Рекомендуемая конфигурация

### Для production (максимальная надёжность)

```bash
# Используйте оба провайдера с несколькими ключами
OPENAI_API_KEY=sk-proj-key-1
OPENAI_API_KEY2=sk-proj-key-2

ANTHROPIC_API_KEY=sk-ant-key-1
ANTHROPIC_API_KEY2=sk-ant-key-2

# Дешёвые модели для большинства задач
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o

ANTHROPIC_MODEL_QUICK=claude-haiku-4.5
ANTHROPIC_MODEL_STANDARD=claude-sonnet-4.5
ANTHROPIC_MODEL_DEEP=claude-opus-4.5

# OpenAI первым (дешевле)
LLM_PROVIDER_STRATEGY=openai-first
```

### Для development (минимальная стоимость)

```bash
# Только OpenAI с одним ключом
OPENAI_API_KEY=sk-proj-your-key

# Самые дешёвые модели
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o-mini  # Даже для deep!

# Anthropic можно не настраивать
```

### Для тестирования Claude (качество > стоимость)

```bash
# Оба провайдера
OPENAI_API_KEY=sk-proj-your-key
ANTHROPIC_API_KEY=sk-ant-your-key

# Используем Claude везде
ANTHROPIC_MODEL_QUICK=claude-haiku-4.5
ANTHROPIC_MODEL_STANDARD=claude-sonnet-4.5
ANTHROPIC_MODEL_DEEP=claude-opus-4.5

# Claude первым
LLM_PROVIDER_STRATEGY=anthropic-first
```

---

## 🎯 Следующие шаги

1. ✅ Получите API ключи (OpenAI обязательно, Anthropic опционально)
2. ✅ Обновите `.env` файл
3. ✅ Перезапустите сервер
4. ✅ Проверьте логи - должны увидеть `LLM Client Manager initialized`
5. ✅ Сделайте тестовый запрос через API
6. ✅ Проверьте в БД - записались ли метрики использования
7. 📊 Анализируйте стоимость и оптимизируйте конфигурацию

---

## 📚 Связанные документы

- [MODEL_SELECTION_GUIDE.md](MODEL_SELECTION_GUIDE.md) - Подробное руководство по выбору моделей
- [MODEL_SELECTION_DIAGRAM.md](MODEL_SELECTION_DIAGRAM.md) - Диаграммы и quick reference
- [COST_TRACKING_ANALYSIS.md](COST_TRACKING_ANALYSIS.md) - Анализ отслеживания стоимости
- [pricing_combined.json](../pricing_combined.json) - Актуальные цены всех моделей

---

**Создано:** 2026-01-18
**Статус:** ✅ Готово к использованию
