# Production Deployment Changelog

## 2026-01-29: Добавлена поддержка автоматических миграций БД для Production

### Проблема
Production окружение на gate.legal.org.ua не выполняло миграции базы данных при деплое, что приводило к ошибкам при запуске приложения из-за отсутствующих таблиц.

### Решение

#### 1. Обновлен `docker-compose.prod.yml`

**Добавлен сервис `migrate-prod`:**
```yaml
migrate-prod:
  image: secondlayer-app:latest
  container_name: secondlayer-migrate-prod
  depends_on:
    postgres-prod:
      condition: service_healthy
    redis-prod:
      condition: service_healthy
  environment:
    DATABASE_URL: postgresql://${POSTGRES_USER:-secondlayer}:${POSTGRES_PASSWORD}@postgres-prod:5432/${POSTGRES_DB:-secondlayer_db}
    # ... other env vars
  working_dir: /app/mcp_backend
  command: ["node", "dist/migrations/migrate.js"]
  restart: "no"  # Запускается один раз
```

**Добавлена зависимость в `app-prod`:**
```yaml
app-prod:
  depends_on:
    postgres-prod:
      condition: service_healthy
    qdrant-prod:
      condition: service_started
    redis-prod:
      condition: service_healthy
    migrate-prod:
      condition: service_completed_successfully
```

**Исправления:**
- ✅ Удалена дублирующая переменная `PORT` (используется только `HTTP_PORT`)
- ✅ Исправлен port mapping: `3001:3000` (внутренний порт 3000, внешний 3001)
- ✅ Обновлен healthcheck: `127.0.0.1:3000` (было неявное localhost)
- ✅ Добавлен комментарий с URLs: `https://legal.org.ua + https://mcp.legal.org.ua/sse`
- ✅ Удалена устаревшая строка `version: '3.8'` (не используется в Compose V2)

#### 2. Создан `.env.prod`

Полная конфигурация для production окружения:
- **Database**: `secondlayer_db` на стандартном порту 5432
- **Application**: Node.js на порту 3000 (internal), 3001 (external)
- **URLs**: https://legal.org.ua + https://mcp.legal.org.ua/sse
- **Real Payments**: Enabled (`MOCK_PAYMENTS=false`)
- **Email**: SMTP через mail.legal.org.ua
- **Security**: Placeholder значения для production secrets (требуют замены)

**Ключевые отличия от dev/stage:**
```bash
NODE_ENV=production
MOCK_PAYMENTS=false  # Реальные платежи!
FRONTEND_URL=https://legal.org.ua
ALLOWED_ORIGINS=https://legal.org.ua,https://mcp.legal.org.ua
```

**Требуют замены перед деплоем:**
```bash
POSTGRES_PASSWORD=CHANGE_THIS_PRODUCTION_PASSWORD
JWT_SECRET=CHANGE_THIS_TO_SECURE_RANDOM_64_CHAR_STRING_FOR_PRODUCTION
SECONDARY_LAYER_KEYS=CHANGE_THIS_PRODUCTION_KEY,ADD_ADDITIONAL_KEYS_HERE
STRIPE_SECRET_KEY=CHANGE_TO_LIVE_sk_live_KEY
STRIPE_PUBLISHABLE_KEY=CHANGE_TO_LIVE_pk_live_KEY
STRIPE_WEBHOOK_SECRET=CHANGE_TO_LIVE_whsec_KEY
FONDY_MERCHANT_ID=CHANGE_TO_PRODUCTION_MERCHANT_ID
FONDY_SECRET_KEY=CHANGE_TO_PRODUCTION_SECRET_KEY
```

#### 3. Созданы новые файлы

**`test-prod-deployment.sh`** - Автоматическая проверка (11 тестов):
- ✅ Валидация docker-compose.prod.yml
- ✅ Проверка наличия migrate-prod сервиса
- ✅ Проверка зависимостей
- ✅ Подсчет миграций (14 файлов)
- ✅ Проверка .env.prod переменных
- ✅ Проверка production URLs (legal.org.ua + mcp.legal.org.ua)
- ✅ Проверка port mapping (3001:3000)
- ✅ Проверка MOCK_PAYMENTS=false
- ⚠️  Проверка placeholder значений (должны быть заменены)
- ✅ Чеклист безопасности для production

**`PROD_DEPLOYMENT.md`** - Полная документация (19KB):
- Архитектура production окружения на gate.legal.org.ua
- Nginx routing для legal.org.ua + mcp.legal.org.ua
- Порядок запуска при деплое
- ⚠️ КРИТИЧНО: Предварительная подготовка перед деплоем
- Troubleshooting для production
- Проверка миграций на сервере
- Обновление production окружения
- Мониторинг и резервные копии
- Откат к предыдущей версии

**`QUICK_START_PROD.md`** - Быстрая памятка (5.2KB):
- ⚠️ Предупреждения о production
- Деплой за 5 шагов (с резервной копией БД)
- Проверка работы миграций
- Быстрые команды для управления
- Мониторинг production
- Troubleshooting
- Чеклист безопасности
- Автоматические резервные копии

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
./test-prod-deployment.sh

# ⚠️ ВАЖНО: Перед деплоем
# 1. Заполнить все CHANGE_THIS значения в .env.prod
# 2. Создать резервную копию БД
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db > /backup/db_backup_$(date +%Y%m%d_%H%M%S).sql"

# 3. Сборка и деплой
./manage-gateway.sh build
./manage-gateway.sh deploy prod

# ИЛИ вручную:
scp docker-compose.prod.yml .env.prod gate.legal.org.ua:~/secondlayer/

# На gate сервере
ssh gate.legal.org.ua
cd ~/secondlayer
docker compose -f docker-compose.prod.yml stop app-prod lexwebapp-prod
docker compose -f docker-compose.prod.yml up -d postgres-prod redis-prod qdrant-prod
sleep 15
docker compose -f docker-compose.prod.yml up migrate-prod
docker compose -f docker-compose.prod.yml up -d app-prod lexwebapp-prod

# Проверка
curl https://legal.org.ua/health
curl https://mcp.legal.org.ua/sse/health
```

### Endpoints

- **Main URL**: https://legal.org.ua
- **MCP SSE**: https://mcp.legal.org.ua/sse
- **Backend API**: https://legal.org.ua/api/
- **Frontend**: https://legal.org.ua/
- **Health**: https://legal.org.ua/health
- **Auth**: https://legal.org.ua/auth/google
- **Direct**: http://gate.legal.org.ua:3001/health (internal)

### Порты Production (на gate.legal.org.ua)

| Service | Host Port | Container Port | Note |
|---------|-----------|----------------|------|
| App | **3001** | **3000** | Main application |
| PostgreSQL | 5432 | 5432 | Standard production port |
| Redis | 6379 | 6379 | Standard production port |
| Qdrant | 6333-6334 | 6333-6334 | Standard production ports |
| Frontend | **8090** | 80 | Nginx serves frontend |

### Nginx Configuration

**Файлы**:
- `/etc/nginx/sites-available/legal.org.ua.conf` (main domain)
- `/etc/nginx/sites-available/mcp.legal.org.ua.conf` (MCP SSE endpoint)

**SSL**: Let's Encrypt

**Routing**:
```
https://legal.org.ua/api/*        → http://127.0.0.1:3001/*
https://legal.org.ua/*            → http://127.0.0.1:8090/*
https://mcp.legal.org.ua/sse/*    → http://127.0.0.1:3001/sse/*
http://legal.org.ua/*             → 301 redirect to HTTPS
http://mcp.legal.org.ua/*         → 301 redirect to HTTPS
```

### Следующие шаги

1. ⚠️ **КРИТИЧНО**: Заполнить все placeholder значения в .env.prod
2. ✅ Создать резервную копию БД перед деплоем
3. ✅ Протестировать в stage окружении
4. ✅ Запустить `./test-prod-deployment.sh`
5. ✅ Проверить, что используются Stripe live keys
6. ✅ Убедиться, что MOCK_PAYMENTS=false
7. ✅ Задеплоить на gate сервер
8. ✅ Проверить выполнение всех 14 миграций
9. ✅ Убедиться, что app-prod стартует после миграций
10. ✅ Проверить работу API через https://legal.org.ua
11. ✅ Проверить MCP SSE через https://mcp.legal.org.ua/sse
12. ✅ Проверить OAuth через Google
13. ✅ Протестировать real payment flow
14. ✅ Настроить автоматические резервные копии
15. ✅ Настроить мониторинг и alerting

### Breaking Changes

⚠️ **ВАЖНО для production**:
- Порты изменятся с 3001:3001 на 3001:3000
- Требуется пересоздание контейнеров
- Миграции выполнятся автоматически при первом запуске
- **ОБЯЗАТЕЛЬНА** резервная копия БД перед обновлением
- Используются реальные платежи (MOCK_PAYMENTS=false)
- Требуются live Stripe/Fondy credentials

### Совместимость

- Docker Compose v2.x (CLI v2)
- PostgreSQL 15-alpine
- Node.js 20-alpine
- Nginx на gate.legal.org.ua
- Let's Encrypt SSL certificates
- Все существующие .env переменные
- Двойной endpoint: legal.org.ua + mcp.legal.org.ua

### Тестирование

Запустить `./test-prod-deployment.sh` для проверки:
- ✅ 11 тестов проверяют конфигурацию
- ⚠️ Предупреждения о placeholder значениях
- ⚠️ Docker образ может отсутствовать до сборки
- ✅ Чеклист безопасности

### Сравнение окружений

| Feature | Development | Stage | **Production** |
|---------|-------------|-------|----------------|
| Server | gate.legal.org.ua | mail.legal.org.ua | **gate.legal.org.ua** |
| URL | dev.legal.org.ua | stage.legal.org.ua | **legal.org.ua** |
| MCP SSE | - | - | **mcp.legal.org.ua/sse** |
| Backend Port | 3003 | 3004 | **3001** |
| Frontend Port | 8091 | 8093 | **8090** |
| PostgreSQL | 5433 | 5434 | **5432** |
| Redis | 6380 | 6381 | **6379** |
| Qdrant | 6335-6336 | 6337-6338 | **6333-6334** |
| Memory | 2GB | 3GB | **4GB** |
| Test Balance | $100 | $50 | **None** |
| Mock Payments | true | true | **false** |
| SSL | dev.legal.org.ua | stage.legal.org.ua | **legal.org.ua + mcp.legal.org.ua** |
| Logging | debug | info | **info** |

### Безопасность Production

⚠️ **КРИТИЧНО**:
- ✅ Stripe **live** keys (sk_live_*, pk_live_*), не test keys!
- ✅ Fondy production merchant credentials
- ✅ MOCK_PAYMENTS=false (реальные платежи)
- ✅ JWT_SECRET минимум 64 символа, криптографически случайный
- ✅ Сильный POSTGRES_PASSWORD (не использовать dev/stage пароли!)
- ✅ SECONDARY_LAYER_KEYS уникальны для production
- ✅ Регулярные резервные копии БД (каждые 6 часов рекомендуется)
- ✅ HTTPS для всех endpoints
- ✅ Rate limiting на Nginx
- ✅ Firewall правила
- ✅ Мониторинг и alerting

### Мониторинг

Рекомендуется настроить:

1. **Автоматические резервные копии** (cron):
   ```bash
   0 */6 * * * docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db | gzip > /backup/secondlayer_$(date +\%Y\%m\%d_\%H\%M).sql.gz
   0 2 * * * find /backup/ -name "secondlayer_*.sql.gz" -mtime +7 -delete
   ```

2. **Health checks** (каждые 5 минут):
   ```bash
   */5 * * * * curl -f https://legal.org.ua/health || echo "Main API down!" | mail -s "Production Alert" admin@legal.org.ua
   */5 * * * * curl -f https://mcp.legal.org.ua/sse/health || echo "MCP SSE down!" | mail -s "Production Alert" admin@legal.org.ua
   ```

3. **Resource monitoring**:
   ```bash
   # CPU/Memory alerts
   0 * * * * docker stats --no-stream | grep prod | awk '{if ($3 > 80 || $7 > 80) print}'
   ```

4. **Log monitoring**:
   ```bash
   # Check for errors
   0 * * * * docker logs --since 1h secondlayer-app-prod | grep ERROR | wc -l
   ```

### Откат (Rollback)

При необходимости отката:

```bash
# 1. Остановить приложение
ssh gate.legal.org.ua "cd ~/secondlayer && docker compose -f docker-compose.prod.yml stop app-prod"

# 2. Восстановить БД из резервной копии
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db < /backup/db_backup_YYYYMMDD_HHMMSS.sql"

# 3. Загрузить предыдущий образ
ssh gate.legal.org.ua "docker load < /backup/secondlayer-app-previous.tar.gz"

# 4. Запустить приложение
ssh gate.legal.org.ua "cd ~/secondlayer && docker compose -f docker-compose.prod.yml up -d app-prod"

# 5. Проверить работу
curl https://legal.org.ua/health
```

### Поддержка

- Документация: [PROD_DEPLOYMENT.md](./PROD_DEPLOYMENT.md)
- Быстрый старт: [QUICK_START_PROD.md](./QUICK_START_PROD.md)
- Тест: `./test-prod-deployment.sh`
- Сравнение: [MIGRATIONS_SUMMARY.md](./MIGRATIONS_SUMMARY.md)
