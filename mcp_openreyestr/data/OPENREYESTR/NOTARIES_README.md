# Реєстр Нотаріусів України (NAIS)

## Статус Імпорту

✅ **База даних створена та наповнена**

- **Всього записів**: 5,809 нотаріусів
- **База даних**: `opendata_db`
- **Таблиця**: `notaries`
- **Джерело даних**: NAIS (Національні інформаційні системи)
- **Файл даних**: `17-ex_xml_wern.xml` (20260120140657-96.zip)
- **Дата даних**: 2026-01-20

## Структура Таблиці

| Поле | Тип | Опис |
|------|-----|------|
| `id` | UUID | Унікальний ідентифікатор запису |
| `certificate_number` | VARCHAR(50) | Номер свідоцтва нотаріуса (UNIQUE) |
| `full_name` | VARCHAR(255) | Повне ім'я нотаріуса |
| `region` | VARCHAR(255) | Регіон України |
| `district` | VARCHAR(255) | Район (не заповнено) |
| `organization` | VARCHAR(500) | Назва нотаріальної контори |
| `address` | TEXT | Повна адреса з контактами |
| `phone` | VARCHAR(50) | Телефон (витягнуто з address) |
| `email` | VARCHAR(255) | Email (витягнуто з address) |
| `certificate_date` | DATE | Дата видачі свідоцтва (не заповнено) |
| `status` | VARCHAR(100) | Статус (за замовчуванням 'active') |
| `raw_data` | JSONB | Повні оригінальні дані з XML |
| `created_at` | TIMESTAMP | Дата створення запису |
| `updated_at` | TIMESTAMP | Дата останнього оновлення |
| `data_source` | VARCHAR(255) | Джерело даних (NAIS) |
| `source_file` | VARCHAR(500) | Назва файлу джерела |

## Індекси

- **Primary Key**: `id` (UUID)
- **Unique**: `certificate_number`
- **B-tree**: `region`, `status`
- **GIN Full-Text Search**: `full_name`

## Статистика по Регіонам

| Регіон | Кількість Нотаріусів |
|--------|---------------------|
| м.Київ | 1,276 |
| Львівська обл. | 446 |
| Дніпропетровська обл. | 444 |
| Одеська обл. | 413 |
| Харківська обл. | 402 |
| Київська обл. | 382 |
| Вінницька обл. | 205 |
| Полтавська обл. | 194 |
| Івано-Франківська обл. | 178 |
| Закарпатська обл. | 175 |

## Приклади SQL Запитів

### 1. Пошук нотаріусів за ім'ям

```sql
-- Full-text search
SELECT certificate_number, full_name, region, organization
FROM notaries
WHERE to_tsvector('simple', full_name) @@ to_tsquery('simple', 'Іванов')
LIMIT 10;

-- LIKE search
SELECT certificate_number, full_name, region, organization
FROM notaries
WHERE full_name ILIKE '%іванов%'
LIMIT 10;
```

### 2. Всі нотаріуси в місті Київ

```sql
SELECT
  certificate_number,
  full_name,
  organization,
  phone,
  email
FROM notaries
WHERE region = 'м.Київ'
ORDER BY full_name
LIMIT 20;
```

### 3. Нотаріуси по конкретній організації

```sql
SELECT
  certificate_number,
  full_name,
  phone,
  email
FROM notaries
WHERE organization ILIKE '%бучанська%'
ORDER BY full_name;
```

### 4. Статистика нотаріусів по регіонам

```sql
SELECT
  region,
  COUNT(*) as total_notaries
FROM notaries
GROUP BY region
ORDER BY total_notaries DESC;
```

### 5. Нотаріуси з email адресами

```sql
SELECT
  certificate_number,
  full_name,
  region,
  email
FROM notaries
WHERE email IS NOT NULL AND email != ''
ORDER BY region, full_name
LIMIT 50;
```

### 6. Пошук по номеру свідоцтва

```sql
SELECT
  certificate_number,
  full_name,
  region,
  organization,
  address,
  phone,
  email,
  raw_data
FROM notaries
WHERE certificate_number = '1209';
```

### 7. Кількість нотаріусів в кожній конторі

```sql
SELECT
  organization,
  COUNT(*) as notary_count,
  STRING_AGG(full_name, ', ' ORDER BY full_name) as notaries
FROM notaries
GROUP BY organization
HAVING COUNT(*) > 1
ORDER BY notary_count DESC
LIMIT 20;
```

### 8. Нотаріуси без email

```sql
SELECT
  certificate_number,
  full_name,
  region,
  organization,
  phone
FROM notaries
WHERE email IS NULL OR email = ''
ORDER BY region, full_name
LIMIT 50;
```

### 9. JSON запит до raw_data

```sql
SELECT
  certificate_number,
  full_name,
  raw_data->>'region' as region_from_json,
  raw_data->>'name_obj' as org_from_json,
  raw_data->>'contacts' as full_contacts
FROM notaries
WHERE certificate_number = '1209';
```

### 10. Експорт в CSV

```sql
-- Copy to CSV (run from psql)
\copy (SELECT certificate_number, full_name, region, organization, phone, email FROM notaries ORDER BY region, full_name) TO '/tmp/notaries_export.csv' WITH CSV HEADER;
```

## Підключення до Бази Даних

### З командного рядка

```bash
# Connect to database
docker exec -it secondlayer-postgres-1 psql -U opendatauser -d opendata_db

# Or with password in environment
docker exec -it -e PGPASSWORD=secondlayer_password secondlayer-postgres-1 psql -U opendatauser -d opendata_db
```

### З Node.js

```javascript
const { Client } = require('pg');

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'opendata_db',
  user: 'opendatauser',
  password: 'secondlayer_password'
});

await client.connect();

// Query notaries
const result = await client.query(
  'SELECT * FROM notaries WHERE region = $1 LIMIT 10',
  ['Київська обл.']
);

console.log(result.rows);

await client.end();
```

### Connection String

```
postgresql://opendatauser:secondlayer_password@localhost:5432/opendata_db
```

## Оновлення Даних

Для оновлення даних з нового XML файлу:

```bash
# 1. Convert XML to UTF-8 (if needed)
iconv -f windows-1251 -t utf-8 new-file.xml -o new-file_utf8.xml

# 2. Run import script (will update existing records)
node import-notaries.js
```

Скрипт використовує `ON CONFLICT (certificate_number) DO UPDATE`, тому існуючі записи будуть оновлені.

## Файли Проекту

- **18-ex_xml_wern.xsd** - XSD схема для XML даних
- **17-ex_xml_wern.xml** - Оригінальні дані (windows-1251)
- **17-ex_xml_wern_utf8.xml** - Дані в UTF-8
- **create-notaries-table.sql** - SQL для створення таблиці
- **import-notaries.js** - Node.js скрипт імпорту
- **NOTARIES_README.md** - Ця документація

## Корисні Команди

```bash
# Count all notaries
docker exec -e PGPASSWORD=secondlayer_password secondlayer-postgres-1 \
  psql -U opendatauser -d opendata_db -c "SELECT COUNT(*) FROM notaries;"

# Show table structure
docker exec -e PGPASSWORD=secondlayer_password secondlayer-postgres-1 \
  psql -U opendatauser -d opendata_db -c "\d notaries"

# Show indexes
docker exec -e PGPASSWORD=secondlayer_password secondlayer-postgres-1 \
  psql -U opendatauser -d opendata_db -c "\di notaries*"

# Show sample data
docker exec -e PGPASSWORD=secondlayer_password secondlayer-postgres-1 \
  psql -U opendatauser -d opendata_db -c "SELECT * FROM notaries LIMIT 5;"
```

## Джерело Даних

**Офіційний сайт**: https://nais.gov.ua/m/ediniy-reestr-notariusiv-188

**Формат даних**: XML
**Оновлення**: Щотижня
**Провайдер**: ДП "Національні інформаційні системи"

## Ліцензія Даних

Дані є відкритими (Open Data) та публічною інформацією відповідно до законодавства України.
