# 🔄 Backend Restart Instructions

После внесения изменений в код backend нужно его перезапустить.

## Шаг 1: Найти и остановить backend

```bash
# Найти процесс
ps aux | grep node | grep mcp_backend

# Остановить через PID (замените <PID> на реальный)
kill <PID>

# Или через pkill (осторожно - остановит все node процессы)
pkill -f "mcp_backend"
```

## Шаг 2: Пересобрать backend

```bash
cd mcp_backend
npm run build
```

## Шаг 3: Запустить backend снова

```bash
# В отдельном терминале
cd mcp_backend
npm run dev:http

# Должно появиться:
# HTTP MCP Server started on http://0.0.0.0:3000
```

## Шаг 4: Проверить что backend работает

```bash
curl http://localhost:3000/health
# Должно вернуть: {"status":"ok","service":"secondlayer-mcp-http"}
```

## Шаг 5: Запустить тест

```bash
export SECONDLAYER_API_KEY=test-key-123  # Используйте реальный ключ
./test-batch-processing.sh
```

## Быстрый перезапуск (one-liner)

```bash
pkill -f "mcp_backend" && cd mcp_backend && npm run build && npm run dev:http &
```

## Альтернатива: PM2 (Production)

Если используете PM2:

```bash
pm2 restart mcp-backend
# или
pm2 reload mcp-backend  # Zero-downtime restart
```
