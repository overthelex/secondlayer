# Рефакторинг SecondLayer MCP

Документація процесу рефакторингу проектів `mcp_backend` та `mcp_rada`.

## Мета

Усунути дублювання коду між двома MCP-серверами шляхом створення спільного пакету `@secondlayer/shared`.

## Виконані етапи

### ✅ Етап 1: Створення shared-пакету

**Дата:** 24 січня 2026

**Що зроблено:**
- Створено структуру `packages/shared/`
- Налаштовано TypeScript конфігурацію
- Перенесено LLM-утиліти:
  - `logger.ts` — фабрика winston-логгерів
  - `openai-client.ts` — менеджер OpenAI клієнтів з retry
  - `anthropic-client.ts` — менеджер Anthropic клієнтів
  - `llm-client-manager.ts` — унифікований інтерфейс для LLM
  - `model-selector.ts` — вибір моделей на основі бюджету

**Результат:**
- Економія ~1400 рядків дублікованого коду
- Обидва проекти успішно компілюються
- Всі тести проходять

### ✅ Етап 2: Унифікація Database

**Дата:** 24 січня 2026

**Що зроблено:**
- Створено `BaseDatabase` клас в shared-пакеті
- Додано `DatabaseConfig` інтерфейс
- Створено `createDatabaseFromEnv` фабричну функцію
- Оновлено `Database` класи в обох проектах

**Результат:**
- Економія ~120 рядків коду
- Єдина точка конфігурації для PostgreSQL
- Підтримка schema для multi-tenant архітектури

### ✅ Етап 3: SSEHandler

**Дата:** 24 січня 2026

**Що зроблено:**
- Створено `SSEHandler` клас для Server-Sent Events
- Винесено загальну логіку відправки SSE-подій
- Додано методи: `sendEvent`, `sendConnected`, `sendProgress`, `sendComplete`, `sendError`, `sendEnd`

**Результат:**
- Уніфікований інтерфейс для SSE
- Готовність до використання в обох проектах

## Статистика

### Загальна економія коду

| Компонент | До | Після | Економія |
|-----------|-----|-------|----------|
| Logger | 44 | 34 | 23% |
| OpenAI Client | 324 | 176 | 46% |
| Anthropic Client | 306 | 161 | 47% |
| LLM Manager | 474 | 251 | 47% |
| Model Selector | 564 | 294 | 48% |
| Database | 148 | 145 | 2% |
| **ВСЬОГО** | **1,860** | **1,061** | **43%** |

### Структура проекту

```
SecondLayer/
├── packages/
│   └── shared/              # Спільний пакет
│       ├── src/
│       │   ├── utils/       # LLM утиліти
│       │   ├── database/    # База даних
│       │   ├── http/        # HTTP утиліти
│       │   └── index.ts
│       ├── dist/            # Скомпільовані файли
│       └── package.json
├── mcp_backend/             # Backend MCP сервер
│   └── src/
│       ├── utils/           # Re-export з @secondlayer/shared
│       └── database/        # Extends BaseDatabase
├── mcp_rada/                # RADA MCP сервер
│   └── src/
│       ├── utils/           # Re-export з @secondlayer/shared
│       └── database/        # Extends BaseDatabase
└── REFACTORING.md           # Цей файл
```

## Наступні кроки

### Можливі покращення

1. **Базовий CostTracker**
   - Винести загальну логіку трекінгу вартості
   - Створити інтерфейс для специфічних методів

2. **Базовий HTTP-сервер**
   - Створити `BaseHTTPServer` клас
   - Винести загальну логіку middleware
   - Уніфікувати обробку помилок

3. **Спільні типи**
   - Створити `packages/shared/src/types/`
   - Винести загальні інтерфейси та типи

4. **Тестування**
   - Додати unit-тести для shared-компонентів
   - Налаштувати Jest для shared-пакету

## Використання

### Встановлення залежності

В `package.json` проектів:

```json
{
  "dependencies": {
    "@secondlayer/shared": "file:../packages/shared"
  }
}
```

### Імпорт утиліт

```typescript
// Logger
import { createLogger, type Logger } from '@secondlayer/shared';
const logger: Logger = createLogger('my-service');

// LLM
import { getLLMManager } from '@secondlayer/shared';
const llm = getLLMManager();

// Database
import { BaseDatabase, type DatabaseConfig } from '@secondlayer/shared';
class MyDB extends BaseDatabase { ... }

// SSE
import { SSEHandler } from '@secondlayer/shared';
SSEHandler.sendProgress(res, 'Processing...', 0.5);
```

## Переваги рефакторингу

### ✅ Технічні

- **Єдине джерело правди** для загального коду
- **Легше підтримувати** — виправлення один раз застосовується скрізь
- **Консистентна поведінка** між сервісами
- **Типобезпека** з TypeScript
- **Краща тестованість** — тестуємо спільний код один раз

### ✅ Бізнес

- **Швидша розробка** нових функцій
- **Менше помилок** через уніфікацію
- **Простіше онбордити** нових розробників
- **Легше масштабувати** архітектуру

## Міграція

### Кроки для додавання нового спільного компонента

1. Створити файл в `packages/shared/src/`
2. Додати експорт в `packages/shared/src/index.ts`
3. Зібрати shared-пакет: `cd packages/shared && npm run build`
4. Замінити локальні файли в проектах на re-export
5. Перевірити компіляцію обох проектів

### Приклад

```typescript
// packages/shared/src/utils/my-util.ts
export function myUtil() { ... }

// packages/shared/src/index.ts
export * from './utils/my-util';

// mcp_backend/src/utils/my-util.ts
export { myUtil } from '@secondlayer/shared';
```

## Контакти

Для питань щодо рефакторингу звертайтесь до команди розробки.

---

**Версія:** 1.0  
**Дата останнього оновлення:** 24 січня 2026
