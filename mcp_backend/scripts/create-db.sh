#!/bin/bash

# Скрипт для создания базы данных и пользователя PostgreSQL
# Использование: ./scripts/create-db.sh

set -e

DB_NAME="${POSTGRES_DB:-secondlayer_db}"
DB_USER="${POSTGRES_USER:-secondlayer}"
DB_PASSWORD="${POSTGRES_PASSWORD:-secondlayer_password}"
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"

echo "🗄️  Создание базы данных для SecondLayer MCP"
echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo "Host: $DB_HOST:$DB_PORT"
echo ""

# Проверяем, доступен ли PostgreSQL
if ! command -v psql &> /dev/null; then
    echo "❌ psql не найден. Установите PostgreSQL client tools."
    exit 1
fi

# Проверяем подключение к PostgreSQL (как postgres superuser)
echo "📡 Проверка подключения к PostgreSQL..."
if ! PGPASSWORD="${POSTGRES_SUPERUSER_PASSWORD:-postgres}" psql -h "$DB_HOST" -p "$DB_PORT" -U "${POSTGRES_SUPERUSER:-postgres}" -d postgres -c "SELECT 1" &> /dev/null; then
    echo "❌ Не удалось подключиться к PostgreSQL"
    echo "   Убедитесь, что PostgreSQL запущен и доступен"
    echo "   Можно использовать: POSTGRES_SUPERUSER=your_user POSTGRES_SUPERUSER_PASSWORD=your_pass"
    exit 1
fi

echo "✅ Подключение к PostgreSQL установлено"
echo ""

# Создаем пользователя (если не существует)
echo "👤 Создание пользователя $DB_USER..."
PGPASSWORD="${POSTGRES_SUPERUSER_PASSWORD:-postgres}" psql -h "$DB_HOST" -p "$DB_PORT" -U "${POSTGRES_SUPERUSER:-postgres}" -d postgres <<EOF
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_user WHERE usename = '$DB_USER') THEN
        CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
        RAISE NOTICE 'User $DB_USER created';
    ELSE
        RAISE NOTICE 'User $DB_USER already exists';
    END IF;
END
\$\$;
EOF

# Создаем базу данных (если не существует)
echo "📦 Создание базы данных $DB_NAME..."
PGPASSWORD="${POSTGRES_SUPERUSER_PASSWORD:-postgres}" psql -h "$DB_HOST" -p "$DB_PORT" -U "${POSTGRES_SUPERUSER:-postgres}" -d postgres <<EOF
SELECT 'CREATE DATABASE $DB_NAME'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec
EOF

# Выдаем права пользователю
echo "🔐 Настройка прав доступа..."
PGPASSWORD="${POSTGRES_SUPERUSER_PASSWORD:-postgres}" psql -h "$DB_HOST" -p "$DB_PORT" -U "${POSTGRES_SUPERUSER:-postgres}" -d postgres <<EOF
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
ALTER DATABASE $DB_NAME OWNER TO $DB_USER;
EOF

echo ""
echo "✅ База данных и пользователь созданы успешно!"
echo ""
echo "📝 Следующий шаг: запустите миграции"
echo "   npm run migrate"
echo ""
