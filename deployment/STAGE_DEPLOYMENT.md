# Stage Environment Deployment Guide

## Обзор

Stage окружение развернуто на **mail.legal.org.ua** с доступом через **https://stage.legal.org.ua**.

### Что было исправлено:

1. ✅ Добавлен сервис `migrate-stage` в `docker-compose.stage.yml`
2. ✅ Исправлена конфигурация портов (3004:3000 вместо 3002:3002)
3. ✅ Обновлен healthcheck для использования wget с 127.0.0.1
4. ✅ Добавлена зависимость app-stage от успешного выполнения миграций
5. ✅ Создан .env.stage с полной конфигурацией
6. ✅ Удалена дублирующая переменная PORT

## Архитектура

```
Stage Stack (mail.legal.org.ua → stage.legal.org.ua):
├── postgres-stage (5434:5432)
├── redis-stage (6381:6379)
├── qdrant-stage (6337-6338:6333-6334)
├── migrate-stage (one-time: runs migrations)
├── app-stage (3004:3000) - depends on migrate-stage
└── lexwebapp-stage (8093:80)
```

### Nginx routing (на mail.legal.org.ua)

- **HTTPS**: https://stage.legal.org.ua → nginx (443) → app-stage (3004) + lexwebapp-stage (8093)
- **HTTP**: http://stage.legal.org.ua → redirect to HTTPS (301)
- **SSL**: Let's Encrypt certificate (valid until 2026-04-29)
- **Config**: `/etc/nginx/domains/stage.legal.org.ua.conf`

## Структура миграций

Миграции находятся в `mcp_backend/src/migrations/`:
- SQL файлы: `001_initial_schema.sql`, `002_add_html_field.sql`, и т.д.
- Runner script: `migrate.ts` (компилируется в `dist/migrations/migrate.js`)

Всего миграций: **14 файлов**

## Порядок запуска при деплое

1. Останавливаются существующие контейнеры
2. Запускаются инфраструктурные сервисы (postgres, redis, qdrant)
3. Ожидание готовности базы данных (15 секунд)
4. Запускается migrate-stage контейнер
5. Выполняются все SQL миграции по порядку
6. После успешных миграций запускаются app-stage и lexwebapp-stage

## Использование

### 1. Проверка конфигурации

```bash
cd deployment
./test-stage-deployment.sh
```

Скрипт проверит:
- ✅ Синтаксис docker-compose.stage.yml
- ✅ Наличие сервиса migrate-stage
- ✅ Зависимости между сервисами
- ✅ Наличие SQL миграций (14 файлов)
- ✅ Переменные окружения в .env.stage
- ✅ Правильность портов (3004:3000)
- ✅ Stage URL (stage.legal.org.ua)

### 2. Сборка Docker образов (локально)

```bash
cd deployment
./manage-gateway.sh build
```

Это создаст образ `secondlayer-app:latest` со всеми миграциями.

### 3. Копирование файлов на mail сервер

```bash
# Создать директорию
ssh mail.legal.org.ua "mkdir -p ~/secondlayer-stage"

# Скопировать файлы
scp docker-compose.stage.yml mail.legal.org.ua:~/secondlayer-stage/
scp .env.stage mail.legal.org.ua:~/secondlayer-stage/
```

### 4. Деплой на mail.legal.org.ua

```bash
# SSH на mail сервер
ssh mail.legal.org.ua

# Перейти в директорию
cd ~/secondlayer-stage

# Остановить старые контейнеры (если есть)
docker compose -f docker-compose.stage.yml down

# Запустить инфраструктуру
docker compose -f docker-compose.stage.yml up -d postgres-stage redis-stage qdrant-stage

# Подождать готовности БД
sleep 15

# Запустить миграции
docker compose -f docker-compose.stage.yml up migrate-stage

# Запустить приложение
docker compose -f docker-compose.stage.yml up -d app-stage lexwebapp-stage

# Проверить статус
docker compose -f docker-compose.stage.yml ps
```

### 5. Проверка статуса

```bash
# На mail сервере
ssh mail.legal.org.ua "docker ps | grep stage"

# Ожидаемый вывод:
# secondlayer-postgres-stage   Up (healthy)      0.0.0.0:5434->5432/tcp
# secondlayer-redis-stage      Up (healthy)      0.0.0.0:6381->6379/tcp
# secondlayer-qdrant-stage     Up                0.0.0.0:6337-6338->6333-6334/tcp
# secondlayer-migrate-stage    Exited (0)        # ✅ Должен завершиться успешно
# secondlayer-app-stage        Up (healthy)      0.0.0.0:3004->3000/tcp
# lexwebapp-stage              Up (healthy)      0.0.0.0:8093->80/tcp
```

### 6. Проверка работы

```bash
# Health check через HTTPS
curl https://stage.legal.org.ua/health

# Ожидаемый результат:
# {"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}

# Проверить frontend
curl -I https://stage.legal.org.ua/

# Проверить API
curl https://stage.legal.org.ua/api/tools
```

## Проверка миграций

После деплоя проверьте, что миграции выполнились успешно:

```bash
# Посмотреть логи миграции
ssh mail.legal.org.ua "docker logs secondlayer-migrate-stage"

# Ожидаемый вывод:
# ✅ Migration 001_initial_schema.sql completed successfully
# ✅ Migration 002_add_html_field.sql completed successfully
# ...
# ✅ All migrations completed successfully

# Проверить таблицы в БД
ssh mail.legal.org.ua "docker exec secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage -c '\dt'"

# Проверить конкретную таблицу (например, биллинг)
ssh mail.legal.org.ua "docker exec secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage -c '\d user_billing'"
```

## Конфигурация окружения

Основные переменные в `.env.stage`:

```bash
# Database
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=stage_password_2026
POSTGRES_DB=secondlayer_stage

# Application
NODE_ENV=staging
HTTP_PORT=3000  # Внутренний порт контейнера
LOG_LEVEL=info

# JWT Secret
JWT_SECRET=stage-jwt-secret-x9y8z7w6v5u4t3s2r1q0

# OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=https://stage.legal.org.ua/auth/google/callback
FRONTEND_URL=https://stage.legal.org.ua

# Email (mail.legal.org.ua SMTP)
EMAIL_FROM=billing@legal.org.ua
SMTP_HOST=mail.legal.org.ua
SMTP_PORT=587
SMTP_USER=billing@legal.org.ua

# Mock Payments (enabled in stage)
MOCK_PAYMENTS=true
```

## Troubleshooting

### Миграции не запускаются

**Проблема**: Контейнер migrate-stage завершается с ошибкой

**Решение**:
```bash
# Проверить логи миграции
ssh mail.legal.org.ua "docker logs secondlayer-migrate-stage"

# Проверить подключение к БД
ssh mail.legal.org.ua "docker exec secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage -c 'SELECT 1'"

# Проверить пароль
ssh mail.legal.org.ua "cat ~/secondlayer-stage/.env.stage | grep POSTGRES_PASSWORD"
```

### App-stage не стартует

**Проблема**: app-stage в состоянии restarting

**Решение**:
```bash
# Проверить зависимости
ssh mail.legal.org.ua "cd ~/secondlayer-stage && docker compose -f docker-compose.stage.yml ps"

# Убедиться, что migrate-stage завершился успешно
ssh mail.legal.org.ua "docker ps -a | grep migrate-stage"

# Проверить логи app-stage
ssh mail.legal.org.ua "docker logs secondlayer-app-stage"

# Проверить порты
ssh mail.legal.org.ua "docker exec secondlayer-app-stage netstat -tlnp | grep node"
# Должно быть: tcp  0.0.0.0:3000  LISTEN
```

### HTTPS не работает

**Проблема**: `curl: (60) SSL certificate problem`

**Решение**:
```bash
# Проверить nginx конфигурацию
ssh mail.legal.org.ua "sudo nginx -t"

# Проверить, что конфиг загружен
ssh mail.legal.org.ua "sudo nginx -T | grep stage.legal.org.ua -A 10"

# Перезагрузить nginx
ssh mail.legal.org.ua "sudo systemctl reload nginx"

# Проверить SSL сертификат
ssh mail.legal.org.ua "sudo openssl x509 -in /etc/letsencrypt/live/stage.legal.org.ua/fullchain.pem -text -noout | grep DNS"
```

### Ошибка подключения к БД

**Проблема**: `password authentication failed for user "secondlayer"`

**Решение**:
```bash
# Пересоздать БД контейнер с новым паролем
ssh mail.legal.org.ua << 'EOF'
cd ~/secondlayer-stage
docker compose -f docker-compose.stage.yml stop postgres-stage
docker compose -f docker-compose.stage.yml rm -f postgres-stage
docker volume rm secondlayer-stage_postgres_stage_data
docker compose -f docker-compose.stage.yml up -d postgres-stage
sleep 15
docker compose -f docker-compose.stage.yml up migrate-stage
docker compose -f docker-compose.stage.yml up -d app-stage
EOF
```

## Структура docker-compose.stage.yml

```yaml
services:
  postgres-stage:
    # База данных на порту 5434
    healthcheck: pg_isready

  redis-stage:
    # Кэш на порту 6381
    healthcheck: redis-cli ping

  qdrant-stage:
    # Vector DB на портах 6337-6338

  migrate-stage:
    # Запускает миграции ONE TIME
    image: secondlayer-app:latest
    command: ["node", "dist/migrations/migrate.js"]
    depends_on:
      - postgres-stage (healthy)
      - redis-stage (healthy)
    restart: "no"  # Не перезапускается

  app-stage:
    # Основное приложение
    depends_on:
      - migrate-stage (completed_successfully)
    ports: ["3004:3000"]  # Host:Container

  lexwebapp-stage:
    # Фронтенд
    ports: ["8093:80"]
```

## Endpoints после деплоя

- **Backend API**: https://stage.legal.org.ua/api/
- **Frontend**: https://stage.legal.org.ua/
- **Health check**: https://stage.legal.org.ua/health
- **Auth**: https://stage.legal.org.ua/auth/google
- **Direct backend**: http://mail.legal.org.ua:3004/health (internal)

## Порты Stage (на mail.legal.org.ua)

- **App**: 3004 (host) → 3000 (container)
- **PostgreSQL**: 5434 (host) → 5432 (container)
- **Redis**: 6381 (host) → 6379 (container)
- **Qdrant**: 6337-6338 (host) → 6333-6334 (container)
- **Frontend**: 8093 (host) → 80 (container)

## Безопасность

⚠️ **Важно**: Stage окружение использует:
- Mock payments (`MOCK_PAYMENTS=true`)
- Stripe test keys
- Test account: `stage@legal.org.ua` с $50 балансом
- SMTP через mail.legal.org.ua
- JWT secret для stage (не production!)

## Отличия от Development и Production

| Feature | Development (gate) | Stage (mail) | Production |
|---------|-------------------|--------------|------------|
| Server | gate.legal.org.ua | mail.legal.org.ua | gate.legal.org.ua |
| URL | dev.legal.org.ua | **stage.legal.org.ua** | legal.org.ua |
| Backend Port | 3003 | **3004** | 3001 |
| Frontend Port | 8091 | **8093** | 8090 |
| PostgreSQL | 5433 | **5434** | 5432 |
| Redis | 6380 | **6381** | 6379 |
| Qdrant | 6335-6336 | **6337-6338** | 6333-6334 |
| Logging | debug | **info** | info |
| Mock Payments | true | **true** | false |
| Memory Limit | 2GB | **3GB** | 4GB |
| Test Balance | $100 | **$50** | Real |

## Обновление Stage

Для обновления stage окружения:

```bash
# 1. Собрать новые образы локально
cd deployment
./manage-gateway.sh build

# 2. Сохранить образ в tar
docker save secondlayer-app:latest | gzip > /tmp/secondlayer-app.tar.gz
docker save lexwebapp-lexwebapp:latest | gzip > /tmp/lexwebapp.tar.gz

# 3. Скопировать на mail сервер
scp /tmp/secondlayer-app.tar.gz mail.legal.org.ua:/tmp/
scp /tmp/lexwebapp.tar.gz mail.legal.org.ua:/tmp/

# 4. Загрузить образы на mail сервере
ssh mail.legal.org.ua "docker load < /tmp/secondlayer-app.tar.gz"
ssh mail.legal.org.ua "docker load < /tmp/lexwebapp.tar.gz"

# 5. Обновить конфигурацию (если изменилась)
scp docker-compose.stage.yml .env.stage mail.legal.org.ua:~/secondlayer-stage/

# 6. Пересоздать контейнеры
ssh mail.legal.org.ua << 'EOF'
cd ~/secondlayer-stage
docker compose -f docker-compose.stage.yml down
docker compose -f docker-compose.stage.yml up -d postgres-stage redis-stage qdrant-stage
sleep 15
docker compose -f docker-compose.stage.yml up migrate-stage
docker compose -f docker-compose.stage.yml up -d app-stage lexwebapp-stage
EOF
```

## Next Steps

После успешного деплоя stage:
1. Проверить работу API: `curl https://stage.legal.org.ua/health`
2. Зайти на фронтенд: https://stage.legal.org.ua
3. Протестировать OAuth: https://stage.legal.org.ua/auth/google
4. Проверить billing dashboard
5. Убедиться, что все 14 миграций выполнились
6. Проверить логи: `docker logs secondlayer-app-stage`

## Support

При возникновении проблем:
1. Запустить `./test-stage-deployment.sh` для диагностики
2. Проверить логи на mail сервере: `ssh mail.legal.org.ua "docker logs secondlayer-app-stage"`
3. Проверить статус: `ssh mail.legal.org.ua "docker ps | grep stage"`
4. Посмотреть логи миграций: `ssh mail.legal.org.ua "docker logs secondlayer-migrate-stage"`
5. Проверить nginx: `ssh mail.legal.org.ua "sudo nginx -t && sudo systemctl status nginx"`
