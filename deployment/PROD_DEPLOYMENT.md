# Production Environment Deployment Guide

## Обзор

Production окружение развернуто на **gate.legal.org.ua** с доступом через **https://legal.org.ua** и **https://mcp.legal.org.ua/sse**.

### Что было исправлено:

1. ✅ Добавлен сервис `migrate-prod` в `docker-compose.prod.yml`
2. ✅ Исправлена конфигурация портов (3001:3000)
3. ✅ Обновлен healthcheck для использования wget с 127.0.0.1
4. ✅ Добавлена зависимость app-prod от успешного выполнения миграций
5. ✅ Создан .env.prod с полной конфигурацией
6. ✅ Удалена дублирующая переменная PORT

## Архитектура

```
Production Stack (gate.legal.org.ua → legal.org.ua + mcp.legal.org.ua):
├── postgres-prod (5432)
├── redis-prod (6379)
├── qdrant-prod (6333-6334)
├── migrate-prod (one-time: runs migrations)
├── app-prod (3001:3000) - depends on migrate-prod
└── lexwebapp-prod (8090:80)
```

### Nginx routing (на gate.legal.org.ua)

- **HTTPS**: https://legal.org.ua → nginx (443) → app-prod (3001) + lexwebapp-prod (8090)
- **HTTPS**: https://mcp.legal.org.ua/sse → nginx (443) → app-prod (3001)
- **HTTP**: http://legal.org.ua → redirect to HTTPS (301)
- **SSL**: Let's Encrypt certificates
- **Config**: `/etc/nginx/sites-available/legal.org.ua.conf` + `/etc/nginx/sites-available/mcp.legal.org.ua.conf`

## Структура миграций

Миграции находятся в `mcp_backend/src/migrations/`:
- SQL файлы: `001_initial_schema.sql`, `002_add_html_field.sql`, и т.д.
- Runner script: `migrate.ts` (компилируется в `dist/migrations/migrate.js`)

Всего миграций: **14 файлов**

## Порядок запуска при деплое

1. Останавливаются существующие контейнеры
2. Запускаются инфраструктурные сервисы (postgres, redis, qdrant)
3. Ожидание готовности базы данных (15 секунд)
4. Запускается migrate-prod контейнер
5. Выполняются все SQL миграции по порядку
6. После успешных миграций запускаются app-prod и lexwebapp-prod

## ⚠️ ВАЖНО: Предварительная подготовка

### Перед деплоем в production:

1. **Заполните placeholder значения в `.env.prod`:**
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

2. **Создайте резервную копию базы данных:**
   ```bash
   ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db > /backup/db_backup_$(date +%Y%m%d_%H%M%S).sql"
   ```

3. **Протестируйте в stage окружении:**
   ```bash
   # Убедитесь, что stage работает корректно
   curl https://stage.legal.org.ua/health
   ```

## Использование

### 1. Проверка конфигурации

```bash
cd deployment
./test-prod-deployment.sh
```

Скрипт проверит:
- ✅ Синтаксис docker-compose.prod.yml
- ✅ Наличие сервиса migrate-prod
- ✅ Зависимости между сервисами
- ✅ Наличие SQL миграций (14 файлов)
- ✅ Переменные окружения в .env.prod
- ✅ Правильность портов (3001:3000)
- ✅ Production URLs (legal.org.ua + mcp.legal.org.ua)
- ✅ MOCK_PAYMENTS=false
- ⚠️  Placeholder значения (должны быть заменены)

### 2. Сборка Docker образов (локально)

```bash
cd deployment
./manage-gateway.sh build
```

Это создаст образ `secondlayer-app:latest` со всеми миграциями.

### 3. Деплой на gate.legal.org.ua

```bash
# Используя manage-gateway.sh (рекомендуется)
cd deployment
./manage-gateway.sh deploy prod

# ИЛИ вручную:
cd deployment

# Скопировать файлы
scp docker-compose.prod.yml gate.legal.org.ua:~/secondlayer/
scp .env.prod gate.legal.org.ua:~/secondlayer/.env

# SSH на gate сервер
ssh gate.legal.org.ua

# Перейти в директорию
cd ~/secondlayer

# Создать резервную копию БД
docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db > /backup/db_backup_$(date +%Y%m%d_%H%M%S).sql

# Остановить старые контейнеры (кроме БД)
docker compose -f docker-compose.prod.yml stop app-prod lexwebapp-prod

# Запустить инфраструктуру (если не запущена)
docker compose -f docker-compose.prod.yml up -d postgres-prod redis-prod qdrant-prod

# Подождать готовности БД
sleep 15

# Запустить миграции
docker compose -f docker-compose.prod.yml up migrate-prod

# Запустить приложение
docker compose -f docker-compose.prod.yml up -d app-prod lexwebapp-prod

# Проверить статус
docker compose -f docker-compose.prod.yml ps
```

### 4. Проверка статуса

```bash
# На gate сервере
ssh gate.legal.org.ua "docker ps | grep prod"

# Ожидаемый вывод:
# secondlayer-postgres-prod   Up (healthy)      0.0.0.0:5432->5432/tcp
# secondlayer-redis-prod      Up (healthy)      0.0.0.0:6379->6379/tcp
# secondlayer-qdrant-prod     Up                0.0.0.0:6333-6334->6333-6334/tcp
# secondlayer-migrate-prod    Exited (0)        # ✅ Должен завершиться успешно
# secondlayer-app-prod        Up (healthy)      0.0.0.0:3001->3000/tcp
# lexwebapp-prod              Up (healthy)      0.0.0.0:8090->80/tcp
```

### 5. Проверка работы

```bash
# Health check через HTTPS (main domain)
curl https://legal.org.ua/health

# Ожидаемый результат:
# {"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}

# Health check MCP SSE endpoint
curl https://mcp.legal.org.ua/sse/health

# Проверить frontend
curl -I https://legal.org.ua/

# Проверить API
curl https://legal.org.ua/api/tools
```

## Проверка миграций

После деплоя проверьте, что миграции выполнились успешно:

```bash
# Посмотреть логи миграции
ssh gate.legal.org.ua "docker logs secondlayer-migrate-prod"

# Ожидаемый вывод:
# ✅ Migration 001_initial_schema.sql completed successfully
# ✅ Migration 002_add_html_field.sql completed successfully
# ...
# ✅ All migrations completed successfully

# Проверить таблицы в БД
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db -c '\\dt'"

# Проверить конкретную таблицу (например, биллинг)
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db -c '\\d user_billing'"
```

## Конфигурация окружения

Основные переменные в `.env.prod`:

```bash
# Database
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=<SECURE_PRODUCTION_PASSWORD>
POSTGRES_DB=secondlayer_db

# Application
NODE_ENV=production
HTTP_PORT=3000  # Внутренний порт контейнера
LOG_LEVEL=info

# JWT Secret (64+ characters)
JWT_SECRET=<SECURE_64_CHAR_RANDOM_STRING>

# OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=https://legal.org.ua/auth/google/callback

# Frontend URLs
FRONTEND_URL=https://legal.org.ua
ALLOWED_ORIGINS=https://legal.org.ua,https://mcp.legal.org.ua

# Email (mail.legal.org.ua SMTP)
EMAIL_FROM=billing@legal.org.ua
SMTP_HOST=mail.legal.org.ua
SMTP_PORT=587

# Real Payments (PRODUCTION)
MOCK_PAYMENTS=false
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
FONDY_MERCHANT_ID=<production_merchant_id>
```

## Troubleshooting

### Миграции не запускаются

**Проблема**: Контейнер migrate-prod завершается с ошибкой

**Решение**:
```bash
# Проверить логи миграции
ssh gate.legal.org.ua "docker logs secondlayer-migrate-prod"

# Проверить подключение к БД
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db -c 'SELECT 1'"

# Проверить пароль
ssh gate.legal.org.ua "cat ~/secondlayer/.env | grep POSTGRES_PASSWORD"
```

### App-prod не стартует

**Проблема**: app-prod в состоянии restarting

**Решение**:
```bash
# Проверить зависимости
ssh gate.legal.org.ua "cd ~/secondlayer && docker compose -f docker-compose.prod.yml ps"

# Убедиться, что migrate-prod завершился успешно
ssh gate.legal.org.ua "docker ps -a | grep migrate-prod"

# Проверить логи app-prod
ssh gate.legal.org.ua "docker logs secondlayer-app-prod"

# Проверить порты
ssh gate.legal.org.ua "docker exec secondlayer-app-prod netstat -tlnp | grep node"
# Должно быть: tcp  0.0.0.0:3000  LISTEN
```

### HTTPS не работает

**Проблема**: `curl: (60) SSL certificate problem`

**Решение**:
```bash
# Проверить nginx конфигурацию
ssh gate.legal.org.ua "sudo nginx -t"

# Проверить, что конфиг загружен
ssh gate.legal.org.ua "sudo nginx -T | grep legal.org.ua -A 10"

# Перезагрузить nginx
ssh gate.legal.org.ua "sudo systemctl reload nginx"

# Проверить SSL сертификат
ssh gate.legal.org.ua "sudo openssl x509 -in /etc/letsencrypt/live/legal.org.ua/fullchain.pem -text -noout | grep DNS"

# Обновить сертификат (если истек)
ssh gate.legal.org.ua "sudo certbot renew"
```

### Ошибка платежей

**Проблема**: Stripe/Fondy платежи не работают

**Решение**:
```bash
# Проверить переменные окружения
ssh gate.legal.org.ua "docker exec secondlayer-app-prod env | grep STRIPE"
ssh gate.legal.org.ua "docker exec secondlayer-app-prod env | grep FONDY"

# Убедиться, что используются live keys, не test
ssh gate.legal.org.ua "docker exec secondlayer-app-prod env | grep STRIPE_SECRET_KEY"
# Должно начинаться с: sk_live_

# Проверить MOCK_PAYMENTS
ssh gate.legal.org.ua "docker exec secondlayer-app-prod env | grep MOCK_PAYMENTS"
# Должно быть: false
```

### Откат после неудачной миграции

**Проблема**: Миграция прошла неудачно, нужен откат

**Решение**:
```bash
# Остановить приложение
ssh gate.legal.org.ua "cd ~/secondlayer && docker compose -f docker-compose.prod.yml stop app-prod"

# Восстановить БД из резервной копии
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db < /backup/db_backup_YYYYMMDD_HHMMSS.sql"

# Проверить данные
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db -c '\\dt'"

# Запустить приложение с предыдущей версией образа
ssh gate.legal.org.ua "cd ~/secondlayer && docker compose -f docker-compose.prod.yml up -d app-prod"
```

## Структура docker-compose.prod.yml

```yaml
services:
  postgres-prod:
    # База данных на стандартном порту 5432
    healthcheck: pg_isready

  redis-prod:
    # Кэш на порту 6379
    healthcheck: redis-cli ping

  qdrant-prod:
    # Vector DB на портах 6333-6334

  migrate-prod:
    # Запускает миграции ONE TIME
    image: secondlayer-app:latest
    command: ["node", "dist/migrations/migrate.js"]
    depends_on:
      - postgres-prod (healthy)
      - redis-prod (healthy)
    restart: "no"  # Не перезапускается

  app-prod:
    # Основное приложение
    depends_on:
      - migrate-prod (completed_successfully)
    ports: ["3001:3000"]  # Host:Container
    environment:
      FRONTEND_URL: https://legal.org.ua
      ALLOWED_ORIGINS: https://legal.org.ua,https://mcp.legal.org.ua

  lexwebapp-prod:
    # Фронтенд
    ports: ["8090:80"]
```

## Endpoints после деплоя

- **Backend API**: https://legal.org.ua/api/
- **Frontend**: https://legal.org.ua/
- **Health check**: https://legal.org.ua/health
- **Auth**: https://legal.org.ua/auth/google
- **MCP SSE**: https://mcp.legal.org.ua/sse
- **Direct backend**: http://gate.legal.org.ua:3001/health (internal)

## Порты Production (на gate.legal.org.ua)

- **App**: 3001 (host) → 3000 (container)
- **PostgreSQL**: 5432 (standard production port)
- **Redis**: 6379 (standard production port)
- **Qdrant**: 6333-6334 (standard production ports)
- **Frontend**: 8090 (host) → 80 (container)

## Безопасность

⚠️ **Критически важно для production**:
- ✅ Используйте Stripe **live** keys (`sk_live_*`, `pk_live_*`)
- ✅ Используйте production Fondy credentials
- ✅ Установите `MOCK_PAYMENTS=false`
- ✅ JWT secret минимум 64 символа, криптографически случайный
- ✅ Сильный POSTGRES_PASSWORD
- ✅ SECONDARY_LAYER_KEYS уникальны для production
- ✅ Регулярные резервные копии БД
- ✅ HTTPS для всех endpoints
- ✅ Rate limiting на Nginx
- ✅ Firewall правила для портов

## Отличия от Development и Stage

| Feature | Development (gate) | Stage (mail) | **Production** |
|---------|-------------------|--------------|----------------|
| Server | gate.legal.org.ua | mail.legal.org.ua | **gate.legal.org.ua** |
| URL | dev.legal.org.ua | stage.legal.org.ua | **legal.org.ua** |
| MCP SSE | - | - | **mcp.legal.org.ua/sse** |
| Backend Port | 3003 | 3004 | **3001** |
| Frontend Port | 8091 | 8093 | **8090** |
| PostgreSQL | 5433 | 5434 | **5432** |
| Redis | 6380 | 6381 | **6379** |
| Qdrant | 6335-6336 | 6337-6338 | **6333-6334** |
| Logging | debug | info | **info** |
| Mock Payments | true | true | **false** |
| Memory Limit | 2GB | 3GB | **4GB** |
| Test Account | $100 | $50 | **None** |

## Мониторинг Production

### Проверка здоровья сервисов

```bash
# Ежедневная проверка
ssh gate.legal.org.ua "docker ps --filter 'name=prod' --format 'table {{.Names}}\t{{.Status}}'"

# Проверка логов на ошибки
ssh gate.legal.org.ua "docker logs --since 24h secondlayer-app-prod | grep ERROR"

# Проверка использования ресурсов
ssh gate.legal.org.ua "docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' | grep prod"

# Проверка размера БД
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db -c 'SELECT pg_size_pretty(pg_database_size(current_database()));'"
```

### Автоматические резервные копии

Настройте cron job на gate сервере:

```bash
# Редактировать crontab
ssh gate.legal.org.ua "crontab -e"

# Добавить (бэкап каждые 6 часов)
0 */6 * * * docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db | gzip > /backup/secondlayer_$(date +\%Y\%m\%d_\%H\%M).sql.gz

# Очистка старых бэкапов (старше 7 дней)
0 2 * * * find /backup/ -name "secondlayer_*.sql.gz" -mtime +7 -delete
```

## Обновление Production

Для обновления production окружения:

```bash
# 1. Создать резервную копию БД
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db > /backup/pre_update_$(date +%Y%m%d_%H%M%S).sql"

# 2. Протестировать на stage
curl https://stage.legal.org.ua/health

# 3. Собрать новые образы локально
cd deployment
./manage-gateway.sh build

# 4. Сохранить образ в tar
docker save secondlayer-app:latest | gzip > /tmp/secondlayer-app.tar.gz
docker save lexwebapp-lexwebapp:latest | gzip > /tmp/lexwebapp.tar.gz

# 5. Скопировать на gate сервер
scp /tmp/secondlayer-app.tar.gz gate.legal.org.ua:/tmp/
scp /tmp/lexwebapp.tar.gz gate.legal.org.ua:/tmp/

# 6. Загрузить образы на gate сервере
ssh gate.legal.org.ua "docker load < /tmp/secondlayer-app.tar.gz"
ssh gate.legal.org.ua "docker load < /tmp/lexwebapp.tar.gz"

# 7. Обновить конфигурацию (если изменилась)
scp docker-compose.prod.yml .env.prod gate.legal.org.ua:~/secondlayer/

# 8. Деплой (zero-downtime через blue-green)
ssh gate.legal.org.ua << 'EOF'
cd ~/secondlayer
# Остановить только app и frontend
docker compose -f docker-compose.prod.yml stop app-prod lexwebapp-prod
# Запустить миграции
docker compose -f docker-compose.prod.yml up migrate-prod
# Запустить обновленные сервисы
docker compose -f docker-compose.prod.yml up -d app-prod lexwebapp-prod
EOF

# 9. Проверить работу
sleep 10
curl https://legal.org.ua/health
curl https://mcp.legal.org.ua/sse/health
```

## Next Steps

После успешного деплоя production:
1. Проверить работу API: `curl https://legal.org.ua/health`
2. Проверить MCP SSE: `curl https://mcp.legal.org.ua/sse/health`
3. Зайти на фронтенд: https://legal.org.ua
4. Протестировать OAuth: https://legal.org.ua/auth/google
5. Проверить real payment flow с тестовой картой
6. Убедиться, что все 14 миграций выполнились
7. Проверить логи: `docker logs secondlayer-app-prod`
8. Настроить мониторинг и alerting
9. Проверить резервные копии БД
10. Настроить автоматические обновления SSL сертификатов

## Support

При возникновении проблем:
1. Запустить `./test-prod-deployment.sh` для диагностики
2. Проверить логи на gate сервере: `ssh gate.legal.org.ua "docker logs secondlayer-app-prod"`
3. Проверить статус: `ssh gate.legal.org.ua "docker ps | grep prod"`
4. Посмотреть логи миграций: `ssh gate.legal.org.ua "docker logs secondlayer-migrate-prod"`
5. Проверить nginx: `ssh gate.legal.org.ua "sudo nginx -t && sudo systemctl status nginx"`
6. Проверить SSL: `ssh gate.legal.org.ua "sudo certbot certificates"`
7. Восстановить из резервной копии при необходимости
