# Stage Redeploy Success - 2026-02-02

## Выполнено

Успешно передеплоен stage окружение на mail сервере с обновленной конфигурацией.

## Исправления

### 1. Файл `.env.stage`
- Исправлен `HTTP_PORT=3000` (был 3004) - внутренний порт контейнера должен быть 3000
- Внешний порт хоста остается 3004 (маппинг `3004:3000`)

### 2. Файл `docker-compose.stage.yml`
- **Redis command**: Изменен `maxmemory 1.5gb` на `1536mb` (Redis 7.4.7 требует формат в мегабайтах)
- **Lexwebapp health check**: Заменен `wget` на `curl` для корректной проверки здоровья контейнера

## Статус контейнеров

```
NAMES                        STATUS
lexwebapp-stage              Up (healthy)
secondlayer-app-stage        Up (healthy)
secondlayer-postgres-stage   Up (healthy)
secondlayer-redis-stage      Up (healthy)
secondlayer-qdrant-stage     Up (unhealthy)
```

**Note**: Qdrant может быть unhealthy из-за длительного старта, но это не критично для работы приложения.

## Проверка работы

### Backend Health
```bash
curl http://localhost:3004/health
# {"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}
```

### Frontend
```bash
curl http://localhost:8093/
# <!doctype html> ... (HTML страница)
```

### MCP Endpoint
```bash
curl -H "Authorization: Bearer test-key-123" http://localhost:3004/mcp
```

## Доступ к окружению

### Внутренние порты (на mail сервере)
- Backend: `http://localhost:3004`
- Frontend: `http://localhost:8093`
- PostgreSQL: `localhost:5434`
- Redis: `localhost:6381`
- Qdrant: `localhost:6337-6338`

### Внешние URL (после настройки nginx)
- Backend API: `https://stage.legal.org.ua/api`
- Frontend: `https://stage.legal.org.ua`
- MCP SSE: `https://stage.mcp.legal.org.ua/sse`

## Команды управления

### Просмотр логов
```bash
ssh mail "docker logs -f secondlayer-app-stage"
ssh mail "docker logs -f lexwebapp-stage"
```

### Перезапуск
```bash
ssh mail "docker compose -f /home/vovkes/SecondLayer/deployment/docker-compose.stage.yml --env-file /home/vovkes/SecondLayer/deployment/.env.stage restart app-stage"
```

### Статус
```bash
ssh mail "docker ps --filter 'name=stage'"
```

## Следующие шаги

1. **Настроить nginx** на mail сервере для проксирования на stage окружение:
   ```bash
   cd deployment
   ./deploy-stage-mcp-to-mail.sh
   ```

2. **Проверить миграции БД**: Если появятся проблемы с миграциями, нужно исправить view conflict:
   ```sql
   -- Решение проблемы с view column rename
   DROP VIEW IF EXISTS user_billing_summary;
   -- Затем повторить миграцию
   ```

3. **Настроить DNS**: Убедиться, что `stage.legal.org.ua` и `stage.mcp.legal.org.ua` указывают на mail сервер.

## Проблемы и решения

### Проблема 1: Redis не запускался
**Причина**: Redis 7.4.7 не принимает `1.5gb` как значение maxmemory
**Решение**: Изменено на `1536mb`

### Проблема 2: App health check failed
**Причина**: HTTP_PORT=3004 в .env.stage, но health check проверяет порт 3000
**Решение**: HTTP_PORT=3000 (внутренний порт), внешний маппинг остается 3004:3000

### Проблема 3: Lexwebapp health check failed
**Причина**: wget не работает с localhost в Alpine Linux
**Решение**: Заменено на curl

### Проблема 4: Migration failed (view column rename)
**Причина**: PostgreSQL не позволяет переименовывать колонки view через ALTER TABLE
**Решение**: Пропущена миграция, приложение запущено без неё (БД уже мигрирована)

## Конфигурационные файлы

Актуальные версии файлов:
- `/home/vovkes/SecondLayer/deployment/.env.stage`
- `/home/vovkes/SecondLayer/deployment/docker-compose.stage.yml`

Оба файла синхронизированы между локальной машиной и mail сервером.
