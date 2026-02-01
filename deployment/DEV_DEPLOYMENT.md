# Development Environment Deployment Guide

## Обзор изменений

Development окружение теперь включает автоматическое выполнение миграций базы данных при деплое.

### Что было исправлено:

1. ✅ Добавлен сервис `migrate-dev` в `docker-compose.dev.yml`
2. ✅ Исправлена конфигурация портов (PORT → HTTP_PORT)
3. ✅ Обновлен healthcheck для использования wget вместо node
4. ✅ Добавлена зависимость app-dev от успешного выполнения миграций
5. ✅ Обновлены скрипты деплоя для корректного запуска миграций

## Архитектура

```
Development Stack (gate.legal.org.ua):
├── postgres-dev (5433:5432)
├── redis-dev (6380:6379)
├── qdrant-dev (6335-6336:6333-6334)
├── migrate-dev (one-time: runs migrations)
├── app-dev (3003:3003) - depends on migrate-dev
└── lexwebapp-dev (8091:80)
```

## Структура миграций

Миграции находятся в `mcp_backend/src/migrations/`:
- SQL файлы: `001_initial_schema.sql`, `002_add_html_field.sql`, и т.д.
- Runner script: `migrate.ts` (компилируется в `dist/migrations/migrate.js`)

Всего миграций: **14 файлов**

## Порядок запуска при деплое

1. Останавливаются существующие контейнеры
2. Запускаются инфраструктурные сервисы (postgres, redis, qdrant)
3. Ожидание готовности базы данных (15 секунд)
4. Запускается migrate-dev контейнер
5. Выполняются все SQL миграции по порядку
6. После успешных миграций запускаются app-dev и lexwebapp-dev

## Использование

### 1. Проверка конфигурации

```bash
cd deployment
./test-dev-deployment.sh
```

Скрипт проверит:
- ✅ Синтаксис docker-compose.dev.yml
- ✅ Наличие сервиса migrate-dev
- ✅ Зависимости между сервисами
- ✅ Наличие SQL миграций
- ✅ Переменные окружения в .env.dev
- ✅ Наличие Docker образа

### 2. Сборка Docker образов

```bash
cd deployment
./manage-gateway.sh build
```

Это создаст образ `secondlayer-app:latest` со всеми миграциями.

### 3. Локальный запуск (опционально)

```bash
./manage-gateway.sh start dev
```

### 4. Деплой на gate сервер

```bash
./manage-gateway.sh deploy dev
```

Скрипт автоматически:
1. Скопирует файлы на gate.legal.org.ua
2. Остановит старые контейнеры
3. Запустит инфраструктуру
4. Выполнит миграции
5. Запустит приложение

### 5. Проверка статуса

```bash
./manage-gateway.sh status
```

### 6. Просмотр логов

```bash
./manage-gateway.sh logs dev
```

## Проверка миграций на сервере

После деплоя проверьте, что миграции выполнились успешно:

```bash
# Посмотреть логи миграции
ssh gate.legal.org.ua "docker logs secondlayer-migrate-dev"

# Проверить структуру БД
ssh gate.legal.org.ua "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_dev -c '\dt'"

# Проверить конкретную таблицу
ssh gate.legal.org.ua "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_dev -c '\d user_billing'"
```

## Конфигурация окружения

Основные переменные в `.env.dev`:

```bash
# Database
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=dev_password_2026
POSTGRES_DB=secondlayer_dev

# Application
NODE_ENV=development
HTTP_PORT=3003
LOG_LEVEL=debug

# JWT Secret
JWT_SECRET=dev-jwt-secret-q8w7e6r5t4y3u2i1o0p9

# AI Models
OPENAI_API_KEY=sk-proj-...
ZAKONONLINE_API_TOKEN=E67988-...

# OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=https://dev.legal.org.ua/auth/google/callback
FRONTEND_URL=https://dev.legal.org.ua
```

## Troubleshooting

### Миграции не запускаются

**Проблема**: Контейнер migrate-dev завершается с ошибкой

**Решение**:
```bash
# Проверить логи миграции
docker logs secondlayer-migrate-dev

# Проверить подключение к БД
docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_dev -c "SELECT 1"
```

### App-dev не стартует

**Проблема**: app-dev в состоянии restarting

**Решение**:
```bash
# Проверить зависимости
docker compose -f docker-compose.dev.yml ps

# Убедиться, что migrate-dev завершился успешно
docker ps -a | grep migrate-dev

# Проверить логи app-dev
docker logs secondlayer-app-dev
```

### Дублирующиеся миграции

**Проблема**: Миграции пытаются создать существующие таблицы

**Решение**: Скрипт migrate.ts игнорирует ошибки "already exists" и "duplicate", так что это нормально. Проверьте логи:
```bash
docker logs secondlayer-migrate-dev | grep "already applied"
```

### Ошибка подключения к БД

**Проблема**: `password authentication failed for user "secondlayer"`

**Решение**:
```bash
# Проверить пароль в .env.dev
cat .env.dev | grep POSTGRES_PASSWORD

# Пересоздать БД контейнер
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d postgres-dev
```

## Структура docker-compose.dev.yml

```yaml
services:
  postgres-dev:
    # База данных на порту 5433
    healthcheck: pg_isready

  redis-dev:
    # Кэш на порту 6380
    healthcheck: redis-cli ping

  qdrant-dev:
    # Vector DB на портах 6335-6336

  migrate-dev:
    # Запускает миграции ONE TIME
    image: secondlayer-app:latest
    command: ["node", "dist/migrations/migrate.js"]
    depends_on:
      - postgres-dev (healthy)
      - redis-dev (healthy)
    restart: "no"  # Не перезапускается

  app-dev:
    # Основное приложение
    depends_on:
      - migrate-dev (completed_successfully)
    ports: ["3003:3003"]

  lexwebapp-dev:
    # Фронтенд
    ports: ["8091:80"]
```

## Endpoints после деплоя

- **Backend API**: https://dev.legal.org.ua/api/
- **Frontend**: https://dev.legal.org.ua/
- **Health check**: https://dev.legal.org.ua/health
- **Direct backend**: http://gate.legal.org.ua:3003/health

## Безопасность

⚠️ **Важно**: Development окружение использует тестовые ключи и пароли. Не используйте production данные!

- Mock payments включены (`MOCK_PAYMENTS=true`)
- Stripe test keys
- Отладочное логирование (`LOG_LEVEL=debug`)
- Доступ через gate.legal.org.ua (внутренний IP)

## Отличия от Production

| Feature | Development | Production |
|---------|-------------|------------|
| Ports | 3003, 5433, 6380, 6335 | 3001, 5432, 6379, 6333 |
| Logging | debug | info |
| Mock Payments | true | false |
| Memory Limit | 2GB | 3GB |
| Auto-restart | unless-stopped | unless-stopped |
| OAuth URL | dev.legal.org.ua | legal.org.ua |

## Next Steps

После успешного деплоя development:
1. Проверить работу API: `curl https://dev.legal.org.ua/health`
2. Зайти на фронтенд: https://dev.legal.org.ua
3. Протестировать OAuth: https://dev.legal.org.ua/auth/google
4. Проверить billing dashboard
5. Запустить тесты через API

## Support

При возникновении проблем:
1. Запустить `./test-dev-deployment.sh` для диагностики
2. Проверить логи: `./manage-gateway.sh logs dev`
3. Проверить статус: `./manage-gateway.sh status`
4. Посмотреть логи миграций: `docker logs secondlayer-migrate-dev`
