# Диаграмма выбора моделей SecondLayer

## 🔄 Как работает выбор модели

```
┌─────────────────────────────────────────────────────────────────┐
│                    ЗАПРОС ОТ ПОЛЬЗОВАТЕЛЯ                       │
│           "Найти похожие дела про защиту прав потребителя"      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                ┌────────────────────────┐
                │  ModelSelector.        │
                │  recommendBudget()     │
                │                        │
                │  queryLength: 50 chars │
                │  → budget = 'standard' │
                └────────┬───────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
    ┌────────┐     ┌─────────┐     ┌──────────┐
    │ QUICK  │     │STANDARD │     │  DEEP    │
    │< 20 chr│     │20-200chr│     │ >200 chr │
    └────┬───┘     └────┬────┘     └────┬─────┘
         │              │               │
         │              │               │
┌────────▼──────────────▼───────────────▼─────────────┐
│                                                      │
│          ModelSelector.getChatModel(budget)         │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │   ПРОВЕРКА: есть OPENAI_MODEL?               │   │
│  └──────────────────┬───────────────────────────┘   │
│                     │                               │
│          ┌──────────┴──────────┐                    │
│          │ ДА                  │ НЕТ                │
│          ▼                     ▼                    │
│  ┌───────────────┐    ┌────────────────────┐       │
│  │ SINGLE MODEL  │    │ DYNAMIC SELECTION  │       │
│  │               │    │                    │       │
│  │  quick:       │    │  quick:    QUICK   │       │
│  │  standard:    │    │  standard: STANDARD│       │
│  │  deep:        │    │  deep:     DEEP    │       │
│  │    ↓          │    │    ↓       ↓    ↓  │       │
│  │  gpt-4o       │    │  gpt-4o-mini gpt-4o│       │
│  └───────────────┘    └────────────────────┘       │
└──────────────────────────┬───────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │   OpenAI API Call      │
              │                        │
              │  model: "gpt-4o-mini"  │
              │  messages: [...]       │
              └────────┬───────────────┘
                       │
                       ▼
              ┌────────────────────────┐
              │    API Response        │
              │                        │
              │  model: "gpt-4o-mini"  │
              │  usage:                │
              │    prompt_tokens: 234  │
              │    completion: 156     │
              │    total: 390          │
              └────────┬───────────────┘
                       │
                       ▼
        ┌──────────────────────────────────┐
        │  ModelSelector.estimateCostAccurate()    │
        │                                  │
        │  model: "gpt-4o-mini"            │
        │  input: 234 × $0.15 = $0.000035  │
        │  output: 156 × $0.60 = $0.000094 │
        │  TOTAL: $0.000129                │
        └──────────┬───────────────────────┘
                   │
                   ▼
        ┌──────────────────────────────┐
        │  CostTracker.recordOpenAICall()        │
        │                              │
        │  INSERT INTO cost_tracking:  │
        │  {                           │
        │    model: "gpt-4o-mini",     │
        │    prompt_tokens: 234,       │
        │    completion_tokens: 156,   │
        │    total_tokens: 390,        │
        │    cost_usd: 0.000129,       │
        │    task: "intent_classification"│
        │  }                           │
        └──────────────────────────────┘
```

---

## 📍 Где используются модели в коде

```
SecondLayer Backend
│
├── QueryPlanner (классификация запроса)
│   ├── budget='quick' → regex (БЕЗ API)
│   ├── budget='standard' → getChatModel('standard')
│   └── budget='deep' → getChatModel('deep')
│
├── EmbeddingService (векторизация)
│   └── ВСЕГДА → getEmbeddingModel()
│       └── text-embedding-ada-002 (НЕ МЕНЯЕТСЯ!)
│
├── SemanticSectionizer (извлечение секций)
│   ├── regex первый проход
│   └── LLM fallback → getChatModel('deep')  ← ЖЕСТКО 'deep'
│
└── HTMLParser (извлечение ключевых слов)
    └── getChatModel('quick')
```

---

## ⚙️ Конфигурация через .env

### Вариант 1: SINGLE MODEL (текущая конфигурация)

```bash
# .env
OPENAI_MODEL=gpt-4o  ← Одна модель для ВСЕХ задач
```

```
Результат:
  quick    → gpt-4o ($2.50/$10.00)  ← ДОРОГО!
  standard → gpt-4o ($2.50/$10.00)  ← ДОРОГО!
  deep     → gpt-4o ($2.50/$10.00)  ← OK
```

### Вариант 2: DYNAMIC SELECTION (рекомендуется)

```bash
# .env
# Удалите OPENAI_MODEL

OPENAI_MODEL_QUICK=gpt-4o-mini     ← Дешевая для простых
OPENAI_MODEL_STANDARD=gpt-4o-mini  ← Дешевая для средних
OPENAI_MODEL_DEEP=gpt-4o           ← Мощная для сложных
```

```
Результат:
  quick    → gpt-4o-mini ($0.15/$0.60)  ← ЭКОНОМИЯ 93%!
  standard → gpt-4o-mini ($0.15/$0.60)  ← ЭКОНОМИЯ 93%!
  deep     → gpt-4o ($2.50/$10.00)      ← OK
```

---

## 💰 Сравнение стоимости

### Сценарий: 1000 запросов в день

| Тип | Количество | Single Model | Dynamic Selection | Экономия |
|-----|-----------|--------------|-------------------|----------|
| quick | 400 (40%) | 400 × $0.006 = **$2.40** | 400 × $0.0002 = **$0.08** | **$2.32** (97%) |
| standard | 500 (50%) | 500 × $0.006 = **$3.00** | 500 × $0.0002 = **$0.10** | **$2.90** (97%) |
| deep | 100 (10%) | 100 × $0.006 = **$0.60** | 100 × $0.006 = **$0.60** | $0 (0%) |
| **ИТОГО** | **1000** | **$6.00/день** | **$0.78/день** | **$5.22/день (87%)** |

**За месяц:**
- Single Model: $180
- Dynamic Selection: $23.40
- **ЭКОНОМИЯ: $156.60 в месяц!**

---

## 🔍 Отслеживание в базе данных

```sql
-- Какие модели использовались
SELECT
  call->>'model' AS model,
  call->>'task' AS task,
  COUNT(*) AS times_used,
  SUM((call->>'cost_usd')::numeric) AS total_cost
FROM cost_tracking,
     jsonb_array_elements(openai_calls) AS call
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY model, task
ORDER BY total_cost DESC;
```

**Результат:**
```
model          | task                   | times_used | total_cost
---------------|------------------------|------------|------------
gpt-4o-mini    | intent_classification  | 432        | $0.10
gpt-4o         | deep_analysis          | 145        | $2.45
gpt-4o         | section_extraction     | 89         | $0.78
text-embedding | embedding              | 234        | $0.02
```

---

## 🎯 Quick Reference

### Текущее состояние
```bash
docker exec secondlayer-app env | grep OPENAI_MODEL
# → OPENAI_MODEL=gpt-4o  (SINGLE MODEL режим)
```

### Рекомендуемое изменение
```bash
# 1. Отредактируйте mcp_backend/.env:
nano mcp_backend/.env

# 2. Закомментируйте или удалите:
# OPENAI_MODEL=gpt-4o

# 3. Раскомментируйте или добавьте:
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o

# 4. Перезапустите контейнеры:
cd mcp_backend
docker-compose down
docker-compose up -d

# 5. Проверьте:
docker logs secondlayer-app | grep "Selected chat model"
```

**Ожидаемый результат:**
```
Selected chat model { budget: 'quick', model: 'gpt-4o-mini' }
Selected chat model { budget: 'standard', model: 'gpt-4o-mini' }
Selected chat model { budget: 'deep', model: 'gpt-4o' }
```

---

## 📚 Связанные документы

- [MODEL_SELECTION_GUIDE.md](MODEL_SELECTION_GUIDE.md) - Подробное руководство
- [COST_TRACKING_ANALYSIS.md](COST_TRACKING_ANALYSIS.md) - Анализ отслеживания стоимости
- [pricing_combined.json](../pricing_combined.json) - Актуальные цены всех моделей

---

**Создано:** 2026-01-18
**Статус:** Актуально
