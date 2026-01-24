#!/bin/bash

# Migration script for legislation storage schema
# This script creates all necessary tables for storing and indexing legislation

set -e

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Database connection parameters
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_NAME="${POSTGRES_DB:-secondlayer_db}"
DB_USER="${POSTGRES_USER:-secondlayer}"

echo "================================================"
echo "Legislation Schema Migration"
echo "================================================"
echo "Database: $DB_NAME"
echo "Host: $DB_HOST:$DB_PORT"
echo "User: $DB_USER"
echo "================================================"

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo "Error: psql command not found. Please install PostgreSQL client."
    exit 1
fi

# Test connection
echo "Testing database connection..."
PGPASSWORD=$POSTGRES_PASSWORD psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "Error: Cannot connect to database. Please check your credentials."
    exit 1
fi
echo "✓ Database connection successful"

# Run migration
echo ""
echo "Running migration..."
PGPASSWORD=$POSTGRES_PASSWORD psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f src/database/legislation-schema.sql

if [ $? -eq 0 ]; then
    echo ""
    echo "================================================"
    echo "✓ Migration completed successfully!"
    echo "================================================"
    echo ""
    echo "Next steps:"
    echo "1. Load legislation data:"
    echo "   npm run load-legislation 1618-15  # ЦПК України"
    echo "   npm run load-legislation 435-15   # ГПК України"
    echo "   npm run load-legislation 2747-15  # КАС України"
    echo "   npm run load-legislation 4651-17  # КПК України"
    echo ""
    echo "2. Or load all at once:"
    echo "   npm run load-all-legislation"
    echo ""
else
    echo ""
    echo "================================================"
    echo "✗ Migration failed!"
    echo "================================================"
    exit 1
fi
