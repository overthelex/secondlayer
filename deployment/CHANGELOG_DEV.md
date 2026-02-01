# Development Deployment Changelog

## 2026-01-29: Добавлена поддержка автоматических миграций БД

### Проблема
Development окружение не выполняло миграции базы данных при деплое, что приводило к ошибкам при запуске приложения из-за отсутствующих таблиц.

### Решение

#### 1. Обновлен `docker-compose.dev.yml`

**Добавлен сервис `migrate-dev`:**
```yaml
migrate-dev:
  image: secondlayer-app:latest
  container_name: secondlayer-migrate-dev
  depends_on:
    postgres-dev:
      condition: service_healthy
    redis-dev:
      condition: service_healthy
  command: ["node", "dist/migrations/migrate.js"]
  restart: "no"  # Запускается один раз
```

**Добавлена зависимость в `app-dev`:**
```yaml
app-dev:
  depends_on:
    migrate-dev:
      condition: service_completed_successfully
```

**Исправления:**
- ✅ Удалена переменная `PORT` (используется только `HTTP_PORT`)
- ✅ Обновлен healthcheck с node на wget для совместимости с Alpine
- ✅ Удалена устаревшая строка `version: '3.8'`

#### 2. Обновлен `manage-gateway.sh`

**Изменена функция `deploy_to_gate()`:**
- Последовательный запуск: инфраструктура → миграции → приложение
- Ожидание готовности БД перед миграциями (15 секунд)
- Отображение статуса после деплоя

```bash
docker compose up -d postgres-$env redis-$env qdrant-$env
sleep 15
docker compose up migrate-$env
docker compose up -d app-$env lexwebapp-$env
```

#### 3. Обновлен `deploy-environments.sh`

**Функция `start_development_environment()`:**
- Запуск инфраструктуры отдельно
- Выполнение миграций
- Запуск приложения

#### 4. Созданы новые файлы

**`test-dev-deployment.sh`** - Автоматическая проверка:
- ✅ Валидация docker-compose.dev.yml
- ✅ Проверка наличия migrate-dev сервиса
- ✅ Проверка зависимостей
- ✅ Подсчет миграций (14 файлов)
- ✅ Проверка .env.dev переменных

**`DEV_DEPLOYMENT.md`** - Полная документация:
- Архитектура development окружения
- Порядок запуска при деплое
- Troubleshooting
- Проверка миграций на сервере

**`QUICK_START_DEV.md`** - Быстрая памятка:
- 5 команд для деплоя
- Проверка работы миграций
- Базовый troubleshooting

### Миграции

Всего **14 SQL миграций** в `mcp_backend/src/migrations/`:
1. `001_initial_schema.sql` - Базовая схема
2. `002_add_html_field.sql` - HTML поле для документов
3. `003_add_cost_tracking.sql` - Трекинг стоимости API
4. `004_add_secondlayer_tracking.sql` - Трекинг SecondLayer
5. `005_convert_uah_to_usd.sql` - Конвертация валют
6. `006_add_users_table.sql` - Таблица пользователей
7. `007_add_eula_acceptance.sql` - Принятие EULA
8. `008_add_prompt_lifecycle_tables.sql` - Lifecycle промптов
9. `008_add_user_billing.sql` - Биллинг пользователей
10. `009_add_document_structured_metadata.sql` - Метаданные документов
11. `010_fix_cost_tracking_schema.sql` - Фикс схемы трекинга
12. `011_add_legislation_tables.sql` - Таблицы законодательства
13. `012_update_legislation_schema.sql` - Обновление схемы
14. `012_payment_integration.sql` - Интеграция платежей

### Использование

```bash
# Проверка конфигурации
cd deployment
./test-dev-deployment.sh

# Деплой
./manage-gateway.sh build
./manage-gateway.sh deploy dev

# Проверка
./manage-gateway.sh status
curl https://dev.legal.org.ua/health
```

### Endpoints

- **Backend API**: https://dev.legal.org.ua/api/
- **Frontend**: https://dev.legal.org.ua/
- **Health**: https://dev.legal.org.ua/health
- **Direct**: http://gate.legal.org.ua:3003/health

### Порты Development

- **App**: 3003
- **PostgreSQL**: 5433
- **Redis**: 6380
- **Qdrant**: 6335-6336
- **Frontend**: 8091

### Следующие шаги

1. ✅ Протестировать деплой на gate сервере
2. ✅ Проверить выполнение всех 14 миграций
3. ✅ Убедиться, что app-dev стартует после миграций
4. ✅ Проверить работу API через https://dev.legal.org.ua

### Breaking Changes

Нет breaking changes. Существующие development окружения продолжат работать, но не будут иметь актуальной схемы БД до следующего деплоя.

### Совместимость

- Docker Compose v2.x (CLI v2)
- PostgreSQL 15-alpine
- Node.js 20-alpine
- Все существующие .env.dev переменные

### Тестирование

Запустить `./test-dev-deployment.sh` для проверки:
- ✅ 7/7 тестов должны пройти
- ⚠️  Docker образ может отсутствовать до `./manage-gateway.sh build`
