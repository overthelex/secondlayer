# Настройка базы данных

## Быстрый старт

### 1. Создание базы данных и пользователя

```bash
npm run db:create
```

Или вручную:

```bash
./scripts/create-db.sh
```

Скрипт создаст:
- Пользователя PostgreSQL: `secondlayer` (или из `POSTGRES_USER`)
- Базу данных: `secondlayer_db` (или из `POSTGRES_DB`)
- Настроит права доступа

### 2. Запуск миграций

```bash
npm run migrate
```

Или все сразу:

```bash
npm run db:setup
```

## Переменные окружения

Создайте файл `.env`:

```env
# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=secondlayer_db
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=secondlayer_password

# Для создания БД (если нужны права superuser)
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=your_postgres_password
```

## Ручная настройка

Если скрипт не работает, создайте БД вручную:

```sql
-- Подключитесь как postgres superuser
psql -U postgres

-- Создайте пользователя
CREATE USER secondlayer WITH PASSWORD 'secondlayer_password';

-- Создайте базу данных
CREATE DATABASE secondlayer_db OWNER secondlayer;

-- Выдайте права
GRANT ALL PRIVILEGES ON DATABASE secondlayer_db TO secondlayer;
```

Затем запустите миграции:

```bash
npm run migrate
```

## Структура базы данных

После миграций будут созданы следующие таблицы:

1. **documents** - Документы из Zakononline
2. **document_sections** - Семантические секции документов
3. **legal_patterns** - Юридические паттерны
4. **embedding_chunks** - Чанки для векторного поиска
5. **citation_links** - Связи цитирований между делами
6. **precedent_status** - Статусы прецедентов
7. **events** - События (event table вместо Kafka)

## Проверка

Проверьте, что БД создана и миграции применены:

```bash
psql -U secondlayer -d secondlayer_db -c "\dt"
```

Должны быть видны все таблицы.

## Troubleshooting

### Ошибка: "role does not exist"

Запустите скрипт создания БД:
```bash
npm run db:create
```

### Ошибка: "permission denied"

Убедитесь, что у пользователя есть права на создание БД, или используйте superuser:
```bash
POSTGRES_SUPERUSER=postgres POSTGRES_SUPERUSER_PASSWORD=your_pass npm run db:create
```

### Ошибка подключения

Проверьте, что PostgreSQL запущен:
```bash
# macOS
brew services list | grep postgresql

# Linux
sudo systemctl status postgresql
```

### Ошибка миграций

Если миграции падают, проверьте логи:
```bash
npm run migrate 2>&1 | tee migration.log
```
