# Quick Start: Development Environment

## Быстрый деплой на gate сервер

```bash
cd deployment

# 1. Проверка (опционально)
./test-dev-deployment.sh

# 2. Сборка образов
./manage-gateway.sh build

# 3. Деплой на gate
./manage-gateway.sh deploy dev

# 4. Проверка статуса
./manage-gateway.sh status

# 5. Просмотр логов
./manage-gateway.sh logs dev
```

## Проверка работы миграций

```bash
# Посмотреть логи миграции
ssh gate.legal.org.ua "docker logs secondlayer-migrate-dev"

# Ожидаемый вывод:
# ✅ Migration 001_initial_schema.sql completed successfully
# ✅ Migration 002_add_html_field.sql completed successfully
# ...
# ✅ All migrations completed successfully
```

## Проверка работы приложения

```bash
# Health check
curl https://dev.legal.org.ua/health

# Ожидаемый результат:
# {"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}

# Проверить таблицы
ssh gate.legal.org.ua "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_dev -c '\dt'"
```

## Структура контейнеров

```
secondlayer-postgres-dev   Up (healthy)      0.0.0.0:5433->5432/tcp
secondlayer-redis-dev      Up (healthy)      0.0.0.0:6380->6379/tcp
secondlayer-qdrant-dev     Up                0.0.0.0:6335-6336->6333-6334/tcp
secondlayer-migrate-dev    Exited (0)        # Должен завершиться успешно
secondlayer-app-dev        Up (healthy)      0.0.0.0:3003->3003/tcp
lexwebapp-dev              Up (healthy)      0.0.0.0:8091->80/tcp
```

## Troubleshooting

### Миграции failed
```bash
docker logs secondlayer-migrate-dev
docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_dev -c "SELECT 1"
```

### App не стартует
```bash
docker logs secondlayer-app-dev
docker compose -f docker-compose.dev.yml ps
```

### Пересоздать окружение
```bash
./manage-gateway.sh stop dev
./manage-gateway.sh clean dev  # Удалит volumes!
./manage-gateway.sh deploy dev
```

## Полная документация

См. [DEV_DEPLOYMENT.md](./DEV_DEPLOYMENT.md) для подробностей.
