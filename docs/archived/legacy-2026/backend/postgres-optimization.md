# PostgreSQL Оптимизация для судебных решений

## Текущая ситуация
- Средний размер документа: 52 KB
- Проекция на 1M документов: 28 GB
- **Вывод: PostgreSQL оптимален**

## Рекомендуемые улучшения

### 1. Full-Text Search индекс (GIN)

```sql
-- Добавить tsvector колонку для поиска
ALTER TABLE documents 
  ADD COLUMN full_text_search tsvector;

-- Создать триггер для автообновления
CREATE OR REPLACE FUNCTION documents_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.full_text_search := 
    setweight(to_tsvector('ukrainian', coalesce(NEW.title,'')), 'A') ||
    setweight(to_tsvector('ukrainian', coalesce(NEW.full_text,'')), 'B');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER tsvectorupdate BEFORE INSERT OR UPDATE
  ON documents FOR EACH ROW EXECUTE FUNCTION documents_search_trigger();

-- GIN индекс для быстрого поиска
CREATE INDEX idx_documents_fts ON documents USING GIN (full_text_search);

-- Использование:
SELECT * FROM documents 
WHERE full_text_search @@ to_tsquery('ukrainian', 'лізинг & заборгованість');
```

### 2. Компрессия TOAST

```sql
-- PostgreSQL автоматически сжимает большие тексты (TOAST)
-- Проверить настройки:
ALTER TABLE documents ALTER COLUMN full_text SET STORAGE EXTENDED;

-- EXTENDED = сжатие + вынос в TOAST таблицу (по умолчанию)
-- Экономия: ~30-50% места для текстовых данных
```

### 3. Партиционирование (при >1M документов)

```sql
-- Партиционирование по году
CREATE TABLE documents_2025 PARTITION OF documents
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

CREATE TABLE documents_2024 PARTITION OF documents
  FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
```

### 4. Оптимизация запросов

```sql
-- Индекс для частых запросов
CREATE INDEX idx_documents_date ON documents(date) WHERE full_text IS NOT NULL;
CREATE INDEX idx_documents_type ON documents(type);

-- Partial индекс только для документов с текстом
CREATE INDEX idx_documents_with_text ON documents(zakononline_id) 
  WHERE full_text IS NOT NULL;
```

## Мониторинг

```sql
-- Размер таблицы и индексов
SELECT 
  pg_size_pretty(pg_total_relation_size('documents')) as total,
  pg_size_pretty(pg_relation_size('documents')) as table_only,
  pg_size_pretty(pg_indexes_size('documents')) as indexes;

-- Эффективность индексов
SELECT 
  indexrelname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public' AND relname = 'documents';

-- TOAST статистика
SELECT 
  relname,
  pg_size_pretty(pg_total_relation_size(oid)) as size
FROM pg_class
WHERE relname LIKE 'pg_toast%documents%';
```

## Backup стратегия

```bash
# Ежедневный backup (только данные)
pg_dump -U secondlayer -t documents secondlayer_db | gzip > backup.sql.gz

# Incremental с WAL archiving
# postgresql.conf:
# wal_level = replica
# archive_mode = on
# archive_command = 'cp %p /backup/wal/%f'
```

## Когда переходить на MinIO?

Только если:
1. Размер документа > 5 MB (редко для судебных решений)
2. Нужна CDN для публичного доступа к документам
3. База данных > 500 GB и растет быстро

Для типичных судебных решений (5-500 KB) PostgreSQL остается лучшим выбором.
