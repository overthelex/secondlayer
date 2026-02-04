# Alternative API Access (Current Staging Backend)

Текущий staging backend (на mail сервере) использует старый формат API endpoints и пока не поддерживает стандартные MCP SSE endpoints (`/mcp`, `/sse`).

## Доступные Endpoints

### 1. Health Check
```bash
curl https://stage.legal.org.ua/health
```

### 2. List Tools
```bash
curl -H "Authorization: Bearer test-key-123" \
     https://stage.legal.org.ua/api/tools
```

### 3. Call Tool (JSON)
```bash
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Знайти судові рішення про розірвання шлюбу"
  }' \
  https://stage.legal.org.ua/api/tools/classify_intent
```

### 4. Call Tool (SSE Streaming)
```bash
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "query": "Знайти судові рішення про розірвання шлюбу"
  }' \
  https://stage.legal.org.ua/api/tools/classify_intent/stream
```

## Доступні Tools

Основные tools:
- `classify_intent` - Классификация запроса
- `search_court_cases` - Поиск судебных решений
- `get_document_text` - Получение текста документа
- `semantic_search` - Семантический поиск
- `find_legal_patterns` - Поиск правовых паттернов
- `validate_citations` - Валидация цитат
- `packaged_lawyer_answer` - Комплексный юридический анализ
- `get_legal_advice` - Получение юридической консультации (с streaming)

## После Обновления Backend

После обновления backend до новой версии с MCP SSE support, станут доступны стандартные endpoints:

### MCP Discovery
```bash
curl -H "Authorization: Bearer test-key-123" \
     https://stage.mcp.legal.org.ua/mcp
```

### MCP SSE Transport
```bash
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  https://stage.mcp.legal.org.ua/sse
```

## Обновление Backend

Для обновления до версии с MCP SSE support:

1. Собрать новый образ (без кеша):
```bash
cd /path/to/SecondLayer
docker build --no-cache -f mcp_backend/Dockerfile -t secondlayer-app:latest .
```

2. Экспортировать образ:
```bash
docker save secondlayer-app:latest | gzip > /tmp/secondlayer-app-latest.tar.gz
```

3. Загрузить на mail сервер:
```bash
scp /tmp/secondlayer-app-latest.tar.gz mail:/tmp/
ssh mail "docker load < /tmp/secondlayer-app-latest.tar.gz"
```

4. Перезапустить контейнер:
```bash
ssh mail "docker restart secondlayer-app-stage"
```

5. Проверить новые endpoints:
```bash
ssh mail "curl -H 'Authorization: Bearer test-key-123' http://localhost:3004/mcp"
```

## Временное решение (пока backend не обновлен)

Используйте прямые API endpoints через nginx:

```nginx
# В nginx конфигурации для stage.mcp.legal.org.ua
location /api {
    proxy_pass http://localhost:3004;
    # ... остальные настройки
}
```

Это позволит использовать URL:
```
https://stage.mcp.legal.org.ua/api/tools/:toolName
```

## Status

- ✅ Staging backend запущен на mail сервере (порт 3004)
- ✅ Nginx базовая конфигурация готова
- ⏳ Обновление backend до версии с `/mcp` и `/sse` endpoints
- ⏳ SSL сертификат для stage.mcp.legal.org.ua (после nginx конфигурации)
