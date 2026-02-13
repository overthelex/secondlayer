#!/bin/sh
set -e

echo "Initializing RADA schema/user in ${POSTGRES_DB}..."

# Wait for postgres to be truly ready (belt-and-suspenders with depends_on)
for i in $(seq 1 30); do
  if pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  echo "Waiting for postgres... ($i/30)"
  sleep 2
done

export PGPASSWORD="$POSTGRES_PASSWORD"

psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 <<SQL

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create role if missing
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RADA_POSTGRES_USER}') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${RADA_POSTGRES_USER}', '${RADA_POSTGRES_PASSWORD}');
  ELSE
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', '${RADA_POSTGRES_USER}', '${RADA_POSTGRES_PASSWORD}');
  END IF;
END
\$\$;

-- Create schema if missing
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '${RADA_POSTGRES_SCHEMA}') THEN
    EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', '${RADA_POSTGRES_SCHEMA}', '${RADA_POSTGRES_USER}');
  END IF;
END
\$\$;

-- Ensure privileges
GRANT USAGE, CREATE ON SCHEMA ${RADA_POSTGRES_SCHEMA} TO ${RADA_POSTGRES_USER};

-- Set default search_path
ALTER ROLE ${RADA_POSTGRES_USER} IN DATABASE ${POSTGRES_DB} SET search_path = ${RADA_POSTGRES_SCHEMA}, public;

SQL

echo "RADA schema/user initialized successfully."
