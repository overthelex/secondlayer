#!/bin/bash
set -e

# This script runs automatically when the PostgreSQL container starts for the first time

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Enable text search extensions
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    -- Set default text search configuration to Russian (closest to Ukrainian)
    -- Russian provides better stemming and search results than 'simple' config
    ALTER DATABASE $POSTGRES_DB SET default_text_search_config = 'pg_catalog.russian';

    -- Grant necessary permissions
    GRANT ALL PRIVILEGES ON DATABASE $POSTGRES_DB TO $POSTGRES_USER;

    -- Create schema for migrations tracking
    CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
EOSQL

echo "Database initialization completed successfully!"
