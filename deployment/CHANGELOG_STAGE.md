# Stage Deployment Changelog

## 2026-01-29: Добавлена поддержка автоматических миграций БД для Stage

### Проблема
Stage окружение на mail.legal.org.ua не выполняло миграции базы данных при деплое, что приводило к ошибкам при запуске приложения из-за отсутствующих таблиц.

### Решение

#### 1. Обновлен `docker-compose.stage.yml`

**Добавлен сервис `migrate-stage`:**
```yaml
migrate-stage:
  image: secondlayer-app:latest
  container_name: secondlayer-migrate-stage
  depends_on:
    postgres-stage:
      condition: service_healthy
    redis-stage:
      condition: service_healthy
  command: ["node", "dist/migrations/migrate.js"]
  restart: "no"  # Запускается один раз
```

**Добавлена зависимость в `app-stage`:**
```yaml
app-stage:
  depends_on:
    migrate-stage:
      condition: service_completed_successfully
```

**Исправления:**
- ✅ Удалена переменная `PORT` (используется только `HTTP_PORT`)
- ✅ Исправлен port mapping: `3004:3000` (было `3002:3002`)
- ✅ Обновлен frontend port: `8093` (было `8092`)
- ✅ Обновлен healthcheck: `127.0.0.1:3000` (было `localhost:3002`)
- ✅ Удалена устаревшая строка `version: '3.8'`

#### 2. Создан `.env.stage`

Полная конфигурация для stage окружения:
- **Database**: `secondlayer_stage` на порту 5434
- **Application**: Node.js на порту 3000 (internal), 3004 (external)
- **URL**: https://stage.legal.org.ua
- **Mock Payments**: Enabled (true)
- **Email**: SMTP через mail.legal.org.ua
- **Test Account**: stage@legal.org.ua с $50 балансом

#### 3. Созданы новые файлы

**`test-stage-deployment.sh`** - Автоматическая проверка:
- ✅ Валидация docker-compose.stage.yml
- ✅ Проверка наличия migrate-stage сервиса
- ✅ Проверка зависимостей
- ✅ Подсчет миграций (14 файлов)
- ✅ Проверка .env.stage переменных
- ✅ Проверка stage URL
- ✅ Проверка port mapping (3004:3000)

**`STAGE_DEPLOYMENT.md`** - Полная документация:
- Архитектура stage окружения на mail.legal.org.ua
- Nginx routing через stage.legal.org.ua
- Порядок запуска при деплое
- Troubleshooting
- Проверка миграций на сервере
- Обновление stage окружения

**`QUICK_START_STAGE.md`** - Быстрая памятка:
- Деплой за 5 шагов
- Проверка работы миграций
- Быстрые команды для управления
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
./test-stage-deployment.sh

# Сборка и деплой
./manage-gateway.sh build
docker save secondlayer-app:latest | gzip > /tmp/secondlayer-app.tar.gz
docker save lexwebapp-lexwebapp:latest | gzip > /tmp/lexwebapp.tar.gz

scp docker-compose.stage.yml .env.stage mail.legal.org.ua:~/secondlayer-stage/
scp /tmp/*.tar.gz mail.legal.org.ua:/tmp/

# На mail сервере
ssh mail.legal.org.ua
docker load < /tmp/secondlayer-app.tar.gz
docker load < /tmp/lexwebapp.tar.gz
cd ~/secondlayer-stage
docker compose -f docker-compose.stage.yml up -d postgres-stage redis-stage qdrant-stage
sleep 15
docker compose -f docker-compose.stage.yml up migrate-stage
docker compose -f docker-compose.stage.yml up -d app-stage lexwebapp-stage

# Проверка
curl https://stage.legal.org.ua/health
```

### Endpoints

- **URL**: https://stage.legal.org.ua
- **Backend API**: https://stage.legal.org.ua/api/
- **Frontend**: https://stage.legal.org.ua/
- **Health**: https://stage.legal.org.ua/health
- **Auth**: https://stage.legal.org.ua/auth/google
- **Direct**: http://mail.legal.org.ua:3004/health (internal)

### Порты Stage (на mail.legal.org.ua)

| Service | Host Port | Container Port | Change |
|---------|-----------|----------------|--------|
| App | **3004** | **3000** | Было 3002:3002 |
| PostgreSQL | 5434 | 5432 | Без изменений |
| Redis | 6381 | 6379 | Без изменений |
| Qdrant | 6337-6338 | 6333-6334 | Без изменений |
| Frontend | **8093** | 80 | Было 8092 |

### Nginx Configuration

**Файл**: `/etc/nginx/domains/stage.legal.org.ua.conf`

**SSL**: Let's Encrypt (expires 2026-04-29)

**Routing**:
```
https://stage.legal.org.ua/api/*  → http://127.0.0.1:3004/*
https://stage.legal.org.ua/*      → http://127.0.0.1:8093/*
http://stage.legal.org.ua/*       → 301 redirect to HTTPS
```

### Следующие шаги

1. ✅ Протестировать деплой на mail сервере
2. ✅ Проверить выполнение всех 14 миграций
3. ✅ Убедиться, что app-stage стартует после миграций
4. ✅ Проверить работу API через https://stage.legal.org.ua
5. ✅ Проверить OAuth через Google
6. ✅ Протестировать billing dashboard

### Breaking Changes

Нет breaking changes для существующего stage окружения. При обновлении:
- Порты изменятся (3002→3004, 8092→8093)
- Миграции выполнятся автоматически
- Требуется пересоздание контейнеров

### Совместимость

- Docker Compose v2.x (CLI v2)
- PostgreSQL 15-alpine
- Node.js 20-alpine
- Nginx на mail.legal.org.ua
- Let's Encrypt SSL certificates
- Все существующие .env переменные

### Тестирование

Запустить `./test-stage-deployment.sh` для проверки:
- ✅ 9/9 тестов должны пройти
- ⚠️  Docker образ может отсутствовать до сборки

### Сравнение окружений

| Feature | Development | **Stage** | Production |
|---------|-------------|-----------|------------|
| Server | gate.legal.org.ua | **mail.legal.org.ua** | gate.legal.org.ua |
| URL | dev.legal.org.ua | **stage.legal.org.ua** | legal.org.ua |
| Backend Port | 3003 | **3004** | 3001 |
| Frontend Port | 8091 | **8093** | 8090 |
| PostgreSQL | 5433 | **5434** | 5432 |
| Redis | 6380 | **6381** | 6379 |
| Qdrant | 6335-6336 | **6337-6338** | 6333-6334 |
| Memory | 2GB | **3GB** | 4GB |
| Test Balance | $100 | **$50** | Real |
| Mock Payments | true | **true** | false |
| SSL | dev.legal.org.ua | **stage.legal.org.ua** | legal.org.ua |

### Безопасность

⚠️ Stage использует:
- Mock платежи (MOCK_PAYMENTS=true)
- Stripe test keys
- Тестовый аккаунт с $50
- Отдельный JWT secret
- SMTP через mail.legal.org.ua
- Отдельная БД от production

Все данные изолированы от production!
