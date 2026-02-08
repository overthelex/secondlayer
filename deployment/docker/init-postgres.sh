#!/bin/bash
# PostgreSQL initialization script
# Runs inside postgres container to create users and databases from environment variables

set -e

# PostgreSQL connection variables (from container environment)
# These are set by docker-compose from .env file
POSTGRES_SUPERUSER="${POSTGRES_USER:-postgres}"  # Docker sets POSTGRES_USER, not POSTGRES_SUPERUSER
POSTGRES_SUPERUSER_PASSWORD="${POSTGRES_PASSWORD}"

# Application database credentials (from docker-compose environment variables)
APP_USER="${POSTGRES_APP_USER:-secondlayer}"
APP_PASSWORD="${POSTGRES_APP_PASSWORD:-local_dev_password}"
APP_DB="${POSTGRES_APP_DB:-secondlayer_local}"

# Wait for PostgreSQL to be ready
echo "[Init] Waiting for PostgreSQL to be ready..."
until pg_isready -U "$POSTGRES_SUPERUSER" > /dev/null 2>&1; do
  echo "[Init] PostgreSQL is unavailable, waiting..."
  sleep 2
done

echo "[Init] PostgreSQL is ready!"
echo "[Init] Creating user: $APP_USER"
echo "[Init] Creating database: $APP_DB"

# Create initialization SQL using safe double-dollar quoting to avoid password escaping issues
INIT_SQL=$(mktemp)
cat > "$INIT_SQL" << 'SQLEOF'
-- Create application user (safe password handling)
DO $$ BEGIN
  CREATE USER %APP_USER% WITH PASSWORD %APP_PASSWORD%;
  ALTER USER %APP_USER% CREATEDB SUPERUSER;
EXCEPTION WHEN duplicate_object THEN
  ALTER USER %APP_USER% WITH PASSWORD %APP_PASSWORD%;
END $$;

-- Create application database
DO $$ BEGIN
  CREATE DATABASE %APP_DB% OWNER %APP_USER%;
EXCEPTION WHEN duplicate_database THEN
  NULL;
END $$;

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE %APP_DB% TO %APP_USER%;

-- Connect and grant schema privileges
\c %APP_DB%
GRANT ALL ON SCHEMA public TO %APP_USER%;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %APP_USER%;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %APP_USER%;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO %APP_USER%;
SQLEOF

# Replace placeholders with safely quoted values
sed -i "s|%APP_USER%|'$APP_USER'|g" "$INIT_SQL"
sed -i "s|%APP_PASSWORD%|'$(echo "$APP_PASSWORD" | sed "s/'/''/g")'|g" "$INIT_SQL"
sed -i "s|%APP_DB%|'$APP_DB'|g" "$INIT_SQL"

# Execute initialization
echo "[Init] Executing initialization SQL..."
PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" psql -U "$POSTGRES_SUPERUSER" -f "$INIT_SQL" 2>&1 | grep -v "^$" || true

# Clean up
rm -f "$INIT_SQL"

echo "[Init] PostgreSQL initialization complete!"
