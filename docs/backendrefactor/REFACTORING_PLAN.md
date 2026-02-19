# Backend Refactoring Plan

**Проект:** SecondLayer — Ukrainian Legal Tech Platform
**Дата:** 2026-02-19
**Статус:** Планирование

---

## Обзор

Рефакторинг реализуется поэтапно по принципу **Strangler Fig Pattern** — новые компоненты вводятся рядом со старыми, старые постепенно выводятся. Каждый пункт — независимая задача, которую можно выполнять параллельно.

---

## Фаза 1 — Фундамент (без ломающих изменений)

### 1. Контрактные тесты между сервисами

**Цель:** Зафиксировать интерфейсы между `mcp_backend`, `mcp_rada`, `mcp_openreyestr` до начала рефакторинга.

**Что делать:**
- Внедрить [Pact](https://docs.pact.io/) для контрактного тестирования HTTP-взаимодействий
- Покрыть критичные пути: `mcp_backend → mcp_rada` (legislation), `gateway → все сервисы`
- Добавить контрактные тесты в CI-пайплайн как gate перед мержем

**Файлы затронуты:** `tests/`, `mcp_backend/__tests__/`, `mcp_rada/__tests__/`
**Ветка:** `refactor/add-contract-tests`
**Риск:** Низкий

---

### 2. OpenAPI спецификации для всех HTTP-эндпоинтов

**Цель:** Автоматически генерировать и поддерживать актуальную документацию API.

**Что делать:**
- Внедрить [`tsoa`](https://tsoa-community.github.io/docs/) или `express-openapi-validator` в Express-серверы
- Сгенерировать OpenAPI 3.0 схемы из декораторов/аннотаций
- Поднять Swagger UI как эндпоинт `/api/docs` (только dev/stage)
- Валидировать входящие запросы по схеме (заменить ручные проверки)

**Файлы затронуты:** `mcp_backend/src/http-server.ts`, `mcp_rada/src/http-server.ts`, `mcp_openreyestr/src/http-server.ts`
**Ветка:** `refactor/add-openapi-specs`
**Риск:** Низкий

---

### 3. Circuit Breaker для внешних API

**Цель:** Предотвратить каскадные сбои при недоступности ZakonOnline, RADA API, OpenAI, VoyageAI.

**Что делать:**
- Внедрить [`opossum`](https://nodeshift.dev/opossum/) (circuit breaker для Node.js)
- Обернуть вызовы в адаптерах: `ZOAdapter`, `RadaLegislationAdapter`, `getOpenAIManager`, `getAnthropicManager`
- Настроить: threshold 50%, timeout 10s, resetTimeout 30s
- Добавить метрику `circuit_breaker_state` в Prometheus (open/closed/half-open)

**Файлы затронуты:** `mcp_backend/src/adapters/`, `packages/shared/src/`
**Ветка:** `refactor/add-circuit-breaker`
**Риск:** Низкий

---

## Фаза 2 — Инфраструктура

### 4. Управление секретами через Vault

**Цель:** Убрать секреты из `.env`-файлов, централизовать ротацию ключей.

**Что делать:**
- Поднять [HashiCorp Vault](https://www.vaultproject.io/) как Docker-сервис в `deployment/`
- Перенести: `OPENAI_API_KEY`, `VOYAGEAI_API_KEY`, `SECONDARY_LAYER_KEYS`, `JWT_SECRET`, `ZAKONONLINE_API_TOKEN`
- Написать `vault-config-loader.ts` в `packages/shared/src/` — загрузка секретов при старте
- Сохранить `.env`-файлы как fallback для local-разработки

**Файлы затронуты:** `deployment/docker-compose.*.yml`, `packages/shared/src/`, `.env.example`
**Ветка:** `refactor/add-vault-secrets`
**Риск:** Средний (требует координации деплоя)

---

### 5. Feature Flags

**Цель:** Безопасное включение новых функций без редеплоя, A/B-тестирование инструментов.

**Что делать:**
- Реализовать лёгкий self-hosted вариант (таблица `feature_flags` в PostgreSQL + кэш Redis)
- Создать `FeatureFlagService` в `packages/shared/src/services/`
- Использовать для переключения провайдеров LLM (`ENABLE_ANTHROPIC`, `LLM_PROVIDER_STRATEGY`)
- Эндпоинт `/api/admin/feature-flags` для управления через UI

**Файлы затронуты:** `packages/shared/src/`, `mcp_backend/src/factories/core-services.ts`
**Ветка:** `refactor/add-feature-flags`
**Риск:** Низкий

---

### 6. Распределённая трассировка (OpenTelemetry)

**Цель:** Трассировать запросы через все сервисы — особенно агентские LLM-цепочки с вызовами инструментов.

**Что делать:**
- Внедрить `@opentelemetry/sdk-node` в каждый сервис
- Инструментировать: Express middleware, PostgreSQL (pg), Redis, HTTP-клиенты (axios/fetch)
- Поднять [Jaeger](https://www.jaegertracing.io/) в `deployment/docker-compose.stage.yml`
- Экспортировать трейсы в Jaeger через OTLP; добавить `/jaeger/` location в Nginx
- Связать `traceId` с существующими логами Winston и метриками Prometheus

**Файлы затронуты:** `packages/shared/src/`, `deployment/`, `deployment/nginx/`
**Ветка:** `refactor/add-opentelemetry`
**Риск:** Средний (изменение всех сервисов)

---

## Фаза 3 — Архитектура данных

### 7. Reference Data Service (сервис справочников)

**Цель:** Единый источник правды для общих справочников: типы судов, регионы, коды законов, статусы.

**Что делать:**
- Выделить отдельный сервис `mcp_reference/` (лёгкий Express + PostgreSQL)
- Перенести: таблицы `zo_dictionaries`, коды законодательства из `mcp_backend`, справочники регионов
- REST API с агрессивным кэшированием (TTL 24h в Redis)
- Остальные сервисы получают справочники через HTTP + локальный in-memory кэш

**Файлы затронуты:** `mcp_backend/src/migrations/`, новый сервис `mcp_reference/`
**Ветка:** `refactor/reference-data-service`
**Риск:** Высокий (новый сервис, миграция данных)

---

### 8. Change Data Capture для синхронизации Qdrant

**Цель:** Автоматически синхронизировать векторные индексы Qdrant с изменениями в PostgreSQL.

**Что делать:**
- Включить [Debezium](https://debezium.io/) для CDC из PostgreSQL
- Стриминг изменений таблиц `documents`, `legislation_articles` через Kafka/RabbitMQ
- Consumer-сервис переиндексирует изменённые записи в Qdrant
- Заменить текущее синхронное обновление индексов при сохранении документов

**Файлы затронуты:** `mcp_backend/src/services/embedding-service.ts`, `deployment/`
**Ветка:** `refactor/add-cdc-qdrant-sync`
**Риск:** Высокий (новая инфраструктура)

---

## Фаза 4 — Коммуникация между сервисами

### 9. Message Bus (асинхронные события)

**Цель:** Декупировать сервисы через события — уведомления об изменениях законодательства, инвалидация кэша, аудит.

**Что делать:**
- Поднять [RabbitMQ](https://www.rabbitmq.com/) (или расширить существующий Redis через Streams)
- Определить схемы событий: `legislation.updated`, `document.processed`, `matter.created`, `audit.event`
- Производители: `mcp_rada` (при синхронизации законов), `mcp_backend` (при обработке документов)
- Потребители: инвалидация кэша, обновление Qdrant, аудит-лог
- Использовать BullMQ (уже в проекте) поверх Redis как первый шаг до полноценного брокера

**Файлы затронуты:** `deployment/`, `packages/shared/src/`, `mcp_backend/src/services/`, `mcp_rada/src/`
**Ветка:** `refactor/add-message-bus`
**Риск:** Высокий (межсервисная координация)

---

### 10. Нагрузочное тестирование и SLO

**Цель:** Определить узкие места, установить SLO для ключевых операций, добавить нагрузочные тесты в CI.

**Что делать:**
- Написать нагрузочные сценарии с [k6](https://k6.io/) для: семантического поиска, получения полного текста дела, агентского чата
- Установить SLO: p95 < 2s для поиска, p95 < 5s для анализа документов
- Добавить error budget алерты в Grafana (расширение существующих дашбордов)
- Создать stub-серверы для ZakonOnline/RADA чтобы тесты не зависели от внешних API
- Запускать нагрузочные тесты еженедельно в CI против stage-окружения

**Файлы затронуты:** `tests/`, `deployment/grafana/`, `deployment/prometheus/rules/`
**Ветка:** `refactor/add-load-tests-slo`
**Риск:** Низкий (только тесты и метрики)

---

## Приоритизация и дорожная карта

```
Месяц 1          Месяц 2          Месяц 3          Месяц 4
─────────────    ─────────────    ─────────────    ─────────────
[1] Контракты    [4] Vault        [7] Reference    [9] Msg Bus
[2] OpenAPI      [5] Feat Flags   [8] CDC Qdrant
[3] Circuit Br.  [6] OpenTelemy   [10] Load Tests/SLO
```

| # | Задача | Риск | Усилие | Приоритет |
|---|--------|------|--------|-----------|
| 3 | Circuit Breaker | Низкий | S | **P0** |
| 1 | Контрактные тесты | Низкий | M | **P0** |
| 6 | OpenTelemetry | Средний | L | **P1** |
| 10 | Load Tests / SLO | Низкий | M | **P1** |
| 2 | OpenAPI спецификации | Низкий | M | **P1** |
| 5 | Feature Flags | Низкий | S | **P2** |
| 4 | Vault | Средний | M | **P2** |
| 9 | Message Bus | Высокий | XL | **P3** |
| 7 | Reference Data Service | Высокий | L | **P3** |
| 8 | CDC + Qdrant | Высокий | XL | **P3** |

---

## Правила выполнения

1. **Один PR — одна задача.** Не смешивать несколько пунктов в одной ветке.
2. **Контрактные тесты до рефакторинга.** Пункт #1 блокирует пункты #7, #8, #9.
3. **Feature flag для каждого нового компонента.** Возможность откатить без редеплоя.
4. **Обратная совместимость API.** Не ломать существующих клиентов при миграции.
5. **Build + smoke test перед PR.** `docker compose build` обязателен.

---

## Связанные документы

- [`docs/ALL_MCP_TOOLS.md`](../ALL_MCP_TOOLS.md) — полный список 45 MCP инструментов
- [`docs/UNIFIED_GATEWAY_IMPLEMENTATION.md`](../UNIFIED_GATEWAY_IMPLEMENTATION.md) — архитектура шлюза
- [`deployment/LOCAL_DEVELOPMENT.md`](../../deployment/LOCAL_DEVELOPMENT.md) — локальная разработка
- [`CLAUDE.md`](../../CLAUDE.md) — правила разработки в проекте
