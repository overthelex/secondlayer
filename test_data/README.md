# Test Data Directory

Эта папка содержит тестовые файлы для проверки document-service.

## Исходные файлы

### 1. HTML документ (судебное решение)
- **Файл**: `1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.html`
- **Размер**: 32 KB
- **Содержание**: Заочное решение, справа № 756/655/23
- **Парсинг**: Native HTML parser

### 2. PDF документ (доверенность)
- **Файл**: `2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.PDF`
- **Размер**: 143 KB
- **Содержание**: Довіреність ТОВ "ФІНАНСОВА КОМПАНІЯ ФАНГАРАНТ ГРУП"
- **Парсинг**: Google Cloud Vision OCR (отсканированный документ)

### 3. DOCX документ (служебная записка)
- **Файл**: `zo6NAJrqmQjM2qn3.docx`
- **Размер**: 22 KB
- **Содержание**: Лист від КП Київавтодор щодо ремонту вулиці
- **Парсинг**: Native DOCX parser (mammoth)

## Конвертированные TXT файлы

После запуска конвертации создаются:

1. **1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.txt** (28 KB)
   - 15,951 символов чистого текста
   - Извлечен из HTML

2. **2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.txt** (7.5 KB)
   - 4,148 символов распознанного текста
   - Извлечен через OCR из PDF

3. **zo6NAJrqmQjM2qn3.txt** (5 KB)
   - 2,914 символов чистого текста
   - Извлечен из DOCX

## Как использовать

### Вариант 1: Автоматическая конвертация всех файлов

```bash
# Из корня проекта
./convert-to-txt.sh
```

### Вариант 2: Запуск полного набора тестов

```bash
./run-document-service-test.sh test
```

### Вариант 3: TypeScript скрипт напрямую

```bash
npx ts-node --project tsconfig.test.json convert-test-files-to-txt.ts
```

### Вариант 4: API запрос напрямую

```bash
# Конвертация HTML
curl -X POST http://localhost:3002/api/parse-document \
  -H "Content-Type: application/json" \
  -d "{
    \"fileBase64\": \"$(base64 -w 0 test_data/1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.html)\",
    \"mimeType\": \"text/html\",
    \"filename\": \"test.html\"
  }" | jq -r .text > output.txt
```

## Результаты тестирования

### Производительность

| Формат | Размер файла | Время парсинга | Метод | Точность |
|--------|-------------|----------------|-------|----------|
| HTML   | 32 KB       | ~600ms         | Native | Отлично  |
| PDF    | 143 KB      | ~1900ms        | OCR    | Хорошо   |
| DOCX   | 22 KB       | ~40ms          | Native | Отлично  |

### Качество распознавания

- **HTML**: 100% точность (нативный парсер)
- **PDF (OCR)**: ~95% точность для украинского текста
- **DOCX**: 100% точность (нативный парсер)

## Требования

- Docker с запущенным document-service-local
- Node.js 20+ для TypeScript скриптов
- Google Cloud Vision API credentials (для PDF OCR)

## Структура после конвертации

```
test_data/
├── README.md                                          # Эта документация
├── 1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.html  # Исходный HTML
├── 1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.txt   # → Конвертированный TXT
├── 2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.PDF      # Исходный PDF
├── 2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.txt      # → Конвертированный TXT (OCR)
├── zo6NAJrqmQjM2qn3.docx                             # Исходный DOCX
└── zo6NAJrqmQjM2qn3.txt                              # → Конвертированный TXT
```

## Troubleshooting

### PDF конвертация не работает (OCR ошибка)

Убедитесь что Vision API credentials настроены:

```bash
# Проверить наличие credentials
ls -la vision-ocr-credentials.json

# Проверить переменную в .env
grep VISION deployment/.env

# Перезапустить сервис
cd deployment
docker compose -f docker-compose.local.yml restart document-service-local
```

### Сервис недоступен

```bash
# Проверить статус
docker ps | grep document-service

# Запустить если не работает
cd deployment
docker compose -f docker-compose.local.yml up -d document-service-local

# Проверить логи
docker logs -f document-service-local
```

## Дополнительная информация

- [DOCUMENT_SERVICE_TESTING.md](../DOCUMENT_SERVICE_TESTING.md) - Полная документация по тестированию
- [CLAUDE.md](../CLAUDE.md) - Архитектура проекта
