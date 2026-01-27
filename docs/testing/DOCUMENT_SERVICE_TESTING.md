# Document Service Testing Guide

## Быстрый старт

### Вариант 1: Автоматический тест (рекомендуется)

```bash
# Запустить все тесты (автоматически стартует сервис если нужно)
./run-document-service-test.sh

# Или явно:
./run-document-service-test.sh test
```

### Вариант 2: Ручной запуск

```bash
# 1. Запустить document-service
./run-document-service-test.sh start

# 2. Проверить статус
./run-document-service-test.sh status

# 3. Запустить тесты
npx ts-node test-document-service.ts

# 4. Посмотреть логи
./run-document-service-test.sh logs

# 5. Остановить сервис
./run-document-service-test.sh stop
```

### Вариант 3: Docker Compose напрямую

```bash
# Запустить все зависимости + document-service
cd deployment
docker-compose -f docker-compose.local.yml up -d \
  postgres-local \
  qdrant-local \
  redis-local \
  document-service-local

# Посмотреть логи
docker logs -f document-service-local

# Остановить
docker-compose -f docker-compose.local.yml down
```

## Доступные команды

```bash
./run-document-service-test.sh test      # Запустить тесты
./run-document-service-test.sh start     # Запустить сервис
./run-document-service-test.sh stop      # Остановить сервис
./run-document-service-test.sh restart   # Перезапустить
./run-document-service-test.sh logs      # Показать логи
./run-document-service-test.sh status    # Проверить статус
./run-document-service-test.sh clean     # Полная очистка
```

## Тестовые файлы

Тесты используют реальные документы из папки `test_data/`:

- `1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.html` - HTML судебное решение
- `2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.PDF` - PDF судебное решение
- `zo6NAJrqmQjM2qn3.docx` - DOCX документ

## Что тестируется

### 1. Парсинг документов
- ✓ HTML → текст
- ✓ PDF → текст (с OCR если нужно)
- ✓ DOCX → текст

### 2. Извлечение ключевых положений
- ✓ Анализ контрактных условий
- ✓ Оценка рисков
- ✓ Классификация пунктов

### 3. Суммаризация
- ✓ Быстрая сводка (quick)
- ✓ Стандартная сводка (standard)
- ✓ Детальный анализ (deep)

### 4. Сравнение документов
- ✓ Выявление изменений
- ✓ Оценка важности изменений (critical/significant/minor)
- ✓ Генерация отчета о различиях

## Endpoints API

Document service работает на **http://localhost:3002**

### Health Check
```bash
curl http://localhost:3002/health
```

### Parse Document
```bash
curl -X POST http://localhost:3002/api/parse-document \
  -H "Content-Type: application/json" \
  -d '{
    "fileBase64": "base64_encoded_file_content",
    "mimeType": "application/pdf",
    "filename": "document.pdf"
  }'
```

### Extract Clauses
```bash
curl -X POST http://localhost:3002/api/extract-clauses \
  -H "Content-Type: application/json" \
  -d '{
    "documentText": "текст документа...",
    "documentId": "optional-id"
  }'
```

### Summarize Document
```bash
curl -X POST http://localhost:3002/api/summarize-document \
  -H "Content-Type: application/json" \
  -d '{
    "documentText": "текст документа...",
    "detailLevel": "quick"
  }'
```

### Compare Documents
```bash
curl -X POST http://localhost:3002/api/compare-documents \
  -H "Content-Type: application/json" \
  -d '{
    "oldDocumentText": "старая версия...",
    "newDocumentText": "новая версия..."
  }'
```

## Требования

### Обязательные переменные окружения

Создайте файл `deployment/.env` или `.env` в корне проекта:

```bash
# OpenAI API (обязательно для работы)
OPENAI_API_KEY=sk-...

# Google Cloud Vision (опционально, для OCR)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/vision-credentials.json
VISION_CREDENTIALS_PATH=/path/to/vision-credentials.json

# PostgreSQL (используются значения по умолчанию для локальной разработки)
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=local_dev_password
POSTGRES_DB=secondlayer_local
```

### Минимальные требования

- Docker и Docker Compose
- Node.js 20+ (для ts-node)
- 4GB RAM для контейнеров

## Troubleshooting

### Сервис не запускается

```bash
# Проверить логи
docker logs document-service-local

# Проверить что все зависимости запущены
docker ps | grep -E "postgres-local|qdrant-local|redis-local"

# Перезапустить
./run-document-service-test.sh restart
```

### Ошибка "OPENAI_API_KEY not set"

Добавьте API ключ в `.env`:
```bash
echo "OPENAI_API_KEY=sk-your-key-here" >> deployment/.env
```

### Ошибка парсинга PDF

Если PDF содержит отсканированные изображения, нужен Google Cloud Vision:
```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
```

### Порт 3002 занят

```bash
# Остановить сервис
./run-document-service-test.sh stop

# Или изменить порт в docker-compose.local.yml:
# ports:
#   - "3003:3002"  # внешний:внутренний
```

## Интеграция с основным backend

Document service используется как микросервис. Основной backend (mcp_backend) может обращаться к нему через HTTP:

```typescript
import { DocumentServiceClient } from './clients/document-service-client';

const client = new DocumentServiceClient('http://localhost:3002');

// Парсинг документа
const parsed = await client.parseDocument({
  fileBase64: base64Content,
  mimeType: 'application/pdf'
});

// Извлечение положений
const clauses = await client.extractKeyClauses({
  documentText: parsed.text
});
```

## Дальнейшие шаги

1. **Production deployment**: См. `deployment/docker-compose.prod.yml`
2. **Scaling**: Document service можно масштабировать горизонтально
3. **Monitoring**: Добавить Prometheus метрики
4. **Caching**: Redis уже подключен для кеширования результатов парсинга

## Дополнительная информация

- [CLIENT_INTEGRATION.md](mcp_backend/docs/CLIENT_INTEGRATION.md) - Интеграция клиентов
- [CLAUDE.md](CLAUDE.md) - Архитектура проекта
- [docker-compose.local.yml](deployment/docker-compose.local.yml) - Конфигурация
