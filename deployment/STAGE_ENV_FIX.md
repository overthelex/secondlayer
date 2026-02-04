# Stage Environment Configuration Fix

## Проблема

Файл `.env.stage` содержал конфигурацию для локального окружения вместо staging окружения, что приводило к неправильным настройкам при развертывании.

## Исправления

### 1. Обновлен `.env.stage`

Создана правильная конфигурация для staging окружения:

- **NODE_ENV**: `staging` (было `development`)
- **HTTP_PORT**: `3004` (было `3000`)
- **POSTGRES_DB**: `secondlayer_stage` (было `secondlayer_local`)
- **POSTGRES_PASSWORD**: Уникальный пароль для stage
- **JWT_SECRET**: Уникальный секрет для stage
- **SECONDARY_LAYER_KEYS**: Stage-специфичные ключи API
- **GOOGLE_CALLBACK_URL**: `https://stage.legal.org.ua/auth/google/callback`
- **FRONTEND_URL**: `https://stage.legal.org.ua`
- **ALLOWED_ORIGINS**: Включает stage.legal.org.ua и stage.mcp.legal.org.ua
- **REDIS_HOST**: `redis-stage` (было `redis-local`)
- **QDRANT_URL**: `http://qdrant-stage:6333` (было `http://qdrant-local:6333`)
- **RADA_MCP_URL**: `http://rada-mcp-app-stage:3001`

### 2. Исправлен `deploy-stage-mcp-to-mail.sh`

**Строка 48**: Заменен placeholder путь `/path/to/deployment` на правильный путь `/home/vovkes/SecondLayer/deployment`

```bash
# Было:
ssh ${MAIL_USER}@${MAIL_SERVER} "cd /path/to/deployment && docker compose ..."

# Стало:
ssh ${MAIL_USER}@${MAIL_SERVER} "cd /home/vovkes/SecondLayer/deployment && docker compose ..."
```

### 3. Проверены другие скрипты

Все остальные скрипты уже правильно настроены:

- ✅ `manage-gateway.sh` - использует `cd "$SCRIPT_DIR"` для перехода в deployment/
- ✅ `update-stage-backend-on-mail.sh` - использует правильные пути
- ✅ `test-stage-deployment.sh` - использует `cd "$SCRIPT_DIR"`
- ✅ `test-stage-local.sh` - проверяет наличие `.env.stage`
- ✅ `docker-compose.stage.yml` - правильно читает переменные из `.env.stage`

## Как использовать

### Локальное тестирование stage окружения

```bash
cd deployment
./test-stage-local.sh
```

### Запуск stage окружения

```bash
cd deployment
./manage-gateway.sh start stage
```

### Деплой на mail сервер

```bash
cd deployment
./update-stage-backend-on-mail.sh
./deploy-stage-mcp-to-mail.sh
```

### Проверка конфигурации

```bash
cd deployment
./test-stage-deployment.sh
```

## Важные замечания

1. **Все скрипты должны запускаться из директории `deployment/`** - скрипты используют относительные пути к `.env.stage`

2. **Файл `.env.stage` содержит секретные данные** - не коммитьте его в публичный репозиторий

3. **Порты для stage окружения**:
   - Backend: 3004 (HTTP)
   - PostgreSQL: 5434
   - Redis: 6381
   - Qdrant: 6337-6338
   - Frontend: 8093

4. **URL для доступа**: https://stage.legal.org.ua

## Проверка работы

После деплоя проверьте:

```bash
# Здоровье сервиса
curl https://stage.legal.org.ua/health

# MCP endpoint
curl -H "Authorization: Bearer test-key-123" https://stage.legal.org.ua/mcp

# SSE endpoint
curl -X POST -H "Authorization: Bearer test-key-123" \
     -H "Content-Type: application/json" \
     -H "Accept: text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' \
     https://stage.legal.org.ua/sse
```
