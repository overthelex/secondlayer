# Roadmap рефакторинга — Очерёдность и зависимости

**Проект:** SecondLayer — Ukrainian Legal Tech Platform
**Дата:** 2026-02-19
**Связан с:** [REFACTORING_PLAN.md](./REFACTORING_PLAN.md)

---

## Принципы приоритизации

1. **Сначала безопасность** — не выстрелить себе в ногу
2. **Наблюдаемость раньше изменений** — видеть, что ломается
3. **Фундамент перед надстройкой** — тесты и документация до архитектуры
4. **Минимальные зависимости** — начинать с изолированных изменений

---

## Этап 0 — Фундамент (2–3 недели)

### Безопасность (базовая)

| Задача | Усилие | Ветка |
|--------|--------|-------|
| Сканирование зависимостей (`npm audit`, Snyk) | 1 день | `refactor/security-scanning` |
| Сканирование контейнеров (Trivy) | 1 день | `refactor/security-scanning` |
| Регулярные проверки в CI (GitHub Actions) | 2 дня | `refactor/security-scanning` |

### Тестирование (базовое)

| Задача | Усилие | Ветка |
|--------|--------|-------|
| Контрактные тесты (Pact) между сервисами | 1 неделя | `refactor/add-contract-tests` |
| Stub-серверы для ZakonOnline/RADA API | 3 дня | `refactor/add-api-stubs` |
| Нагрузочное тестирование k6 — baseline | 2 дня | `refactor/add-load-tests-slo` |

### Документация

| Задача | Усилие | Ветка |
|--------|--------|-------|
| OpenAPI спецификации для всех HTTP эндпоинтов | 3 дня | `refactor/add-openapi-specs` |
| JSON-схемы и валидация для MCP инструментов | 2 дня | `refactor/add-openapi-specs` |

**Результат этапа:** Безопасная точка отсчёта — тесты зафиксировали поведение, можно рефакторить без страха регрессий.

---

## Этап 1 — Наблюдаемость (1–2 недели)

### Трассировка и метрики

| Задача | Усилие | Ветка |
|--------|--------|-------|
| OpenTelemetry — инструментация всех сервисов | 1 неделя | `refactor/add-opentelemetry` |
| SLO и error budgets в Grafana | 3 дня | `refactor/add-load-tests-slo` |
| Бизнес-метрики (дела, счета, активные пользователи) | 2 дня | `refactor/add-business-metrics` |

### Логирование

| Задача | Усилие | Ветка |
|--------|--------|-------|
| Loki для централизованного сбора логов | 3 дня | `refactor/add-loki-logging` |

**Результат этапа:** Полная видимость — каждое следующее изменение можно наблюдать в реальном времени.

---

## Этап 2 — Защита и устойчивость (2 недели)

### Внешние API

| Задача | Усилие | Ветка |
|--------|--------|-------|
| Circuit breaker (opossum) для ZakonOnline/RADA/OpenAI/VoyageAI | 3 дня | `refactor/add-circuit-breaker` |
| Расширение BullMQ на вызовы внешних API | 1 неделя | `refactor/extend-bullmq-api` |
| Cache warming для часто запрашиваемых законов | 2 дня | `refactor/add-cache-warming` |

### Безопасность (продолжение)

| Задача | Усилие | Ветка |
|--------|--------|-------|
| HashiCorp Vault для секретов | 1 неделя | `refactor/add-vault-secrets` |
| mTLS между внутренними сервисами | 3 дня | `refactor/add-mtls` |

**Результат этапа:** Система устойчива к внешним сбоям, секреты вне `.env`-файлов.

---

## Этап 3 — Коммуникация (3 недели)

### Межсервисная коммуникация

| Задача | Усилие | Ветка |
|--------|--------|-------|
| RabbitMQ инфраструктура в Docker Compose | 1 неделя | `refactor/add-message-bus` |
| Event schemas: `legislation.updated`, `document.processed`, `audit.event` | 1 неделя | `refactor/add-message-bus` |
| API Gateway агрегация (BFF / GraphQL federation) | 1 неделя | `refactor/api-gateway-aggregation` |

### Конфигурация

| Задача | Усилие | Ветка |
|--------|--------|-------|
| Feature flags (PostgreSQL + Redis кэш) | 1 неделя | `refactor/add-feature-flags` |
| Централизованная конфигурация (Consul или Kubernetes ConfigMaps) | 3 дня | `refactor/centralized-config` |

**Результат этапа:** Сервисы общаются через события, а не прямыми вызовами.

---

## Этап 4 — Архитектура данных (3–4 недели)

### Данные

| Задача | Усилие | Ветка |
|--------|--------|-------|
| Reference Data Service (`mcp_reference/`) | 2 недели | `refactor/reference-data-service` |
| Change Data Capture (Debezium) для синхронизации Qdrant | 1 неделя | `refactor/add-cdc-qdrant-sync` |
| Saga паттерн для распределённых транзакций | 1 неделя | `refactor/add-saga-pattern` |

### AI-качество

| Задача | Усилие | Ветка |
|--------|--------|-------|
| Метрики качества ответов LLM (human eval pipeline) | 1 неделя | `refactor/add-ai-quality-metrics` |

**Результат этапа:** Единый источник правды для справочников, консистентные данные между сервисами.

---

## Этап 5 — Масштабирование (4–6 недель)

### Фронтенд

| Задача | Усилие | Ветка |
|--------|--------|-------|
| React Hook Form + Zod для юридических форм | 1 неделя | `refactor/frontend-forms` |
| Lazy Loading для редких страниц (admin) | 2 дня | `refactor/frontend-lazy-loading` |
| Микрофронтенды (Module Federation) | 2 недели | `refactor/micro-frontends` |
| SSR / Next.js миграция (опционально) | 2–3 недели | `refactor/nextjs-migration` |

### Инфраструктура

| Задача | Усилие | Ветка |
|--------|--------|-------|
| Kubernetes манифесты + Helm charts | 2 недели | `refactor/add-kubernetes` |
| IaC (Terraform / Pulumi) | 1 неделя | `refactor/add-iac` |
| Полный CI/CD pipeline (GitHub Actions) | 1 неделя | `refactor/add-cicd-pipeline` |

**Результат этапа:** Система готова к горизонтальному масштабированию.

---

## Матрица зависимостей

```
Изменение               Зависит от                    Блокирует
─────────────────────   ───────────────────────────   ────────────────────────
Контрактные тесты       —                             RabbitMQ, CDC, Saga
OpenTelemetry           —                             RabbitMQ, Kubernetes
Circuit breaker         —                             —
Vault                   —                             mTLS
RabbitMQ                OpenTelemetry + Контракты     CDC, Saga, Event-driven
Reference Data Svc      RabbitMQ                      —
CDC (Debezium)          RabbitMQ                      —
Saga                    RabbitMQ                      —
Kubernetes              OpenTelemetry + Vault + CI    —
```

---

## Параллельные треки выполнения

```
Трек A (Backend)                    Трек B (Инфраструктура)
─────────────────────────────────   ──────────────────────────────
[Этап 0] Контрактные тесты          [Этап 0] OpenAPI документация
[Этап 1] OpenTelemetry              [Этап 2] Vault секреты
[Этап 2] Circuit breaker            [Этап 3] Feature flags
[Этап 4] Reference Data Service     [Этап 5] Фронтенд оптимизации
```

---

## Критические пути

### Кратчайший путь к production-ready (~6–7 недель)

```
Контрактные тесты
      ↓
  OpenTelemetry
      ↓
 Circuit breaker
      ↓
    Vault
      ↓
  RabbitMQ
```

### Полный рефакторинг (~15–20 недель)

Все этапы 0–5 последовательно с параллельными треками.

---

## Чеклист старта

Перед запуском каждого этапа:

- [ ] Контрактные тесты покрывают затрагиваемые интерфейсы
- [ ] Feature flag создан для нового компонента
- [ ] Baseline метрики сняты (k6 + Prometheus)
- [ ] `.env.example` обновлён новыми переменными
- [ ] `docker compose build` проходит без ошибок
- [ ] PR создан с описанием изменений и ссылкой на этот документ

---

## Связанные документы

- [`REFACTORING_PLAN.md`](./REFACTORING_PLAN.md) — детальное описание каждого из 10 пунктов
- [`docs/ALL_MCP_TOOLS.md`](../ALL_MCP_TOOLS.md) — полный список MCP инструментов
- [`CLAUDE.md`](../../CLAUDE.md) — правила разработки в проекте
