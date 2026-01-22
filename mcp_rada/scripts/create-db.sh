#!/bin/bash

# Database creation script for RADA MCP Server
# This script creates the PostgreSQL database if it doesn't exist

set -e

# Load environment variables from .env if it exists
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Default values
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5433}
POSTGRES_USER=${POSTGRES_USER:-rada_mcp}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-rada_password}
POSTGRES_DB=${POSTGRES_DB:-rada_db}

echo "Creating database '$POSTGRES_DB' on $POSTGRES_HOST:$POSTGRES_PORT..."

# Check if database exists
DB_EXISTS=$(PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DB'")

if [ "$DB_EXISTS" = "1" ]; then
  echo "Database '$POSTGRES_DB' already exists."
else
  echo "Creating database '$POSTGRES_DB'..."
  PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d postgres -c "CREATE DATABASE $POSTGRES_DB;"
  echo "✅ Database '$POSTGRES_DB' created successfully."
fi

echo "Done!"
