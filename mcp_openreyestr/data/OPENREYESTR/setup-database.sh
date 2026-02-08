#!/bin/bash
# Database Setup Script for NAIS Open Data
# This script creates the database, user, and schema

set -e

echo "=========================================="
echo "NAIS Open Data Database Setup"
echo "=========================================="
echo ""

# Load environment variables
if [ -f .env ]; then
    echo "✓ Loading environment variables from .env"
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "❌ Error: .env file not found"
    exit 1
fi

# Check if required variables are set
if [ -z "$POSTGRES_ODATA_DB" ] || [ -z "$POSTGRES_ODATA_USER" ] || [ -z "$POSTGRES_ODATA_PASSWORD" ]; then
    echo "❌ Error: Required environment variables not set"
    echo "   Please ensure POSTGRES_ODATA_DB, POSTGRES_ODATA_USER, and POSTGRES_ODATA_PASSWORD are defined in .env"
    exit 1
fi

echo "Database: $POSTGRES_ODATA_DB"
echo "User: $POSTGRES_ODATA_USER"
echo "Host: ${POSTGRES_ODATA_HOST:-localhost}"
echo "Port: ${POSTGRES_ODATA_PORT:-5432}"
echo ""

# Check if PostgreSQL is running
if ! pg_isready -h "${POSTGRES_ODATA_HOST:-localhost}" -p "${POSTGRES_ODATA_PORT:-5432}" > /dev/null 2>&1; then
    echo "❌ Error: PostgreSQL is not running or not accessible"
    echo "   Please start PostgreSQL and try again"
    exit 1
fi

echo "✓ PostgreSQL is running"
echo ""

# Prompt for PostgreSQL admin password
echo "Creating database and user requires PostgreSQL admin access"
read -sp "Enter PostgreSQL admin (postgres) password: " PGADMIN_PASSWORD
echo ""
echo ""

# Create user if not exists
echo "Creating database user..."
PGPASSWORD=$PGADMIN_PASSWORD psql -h "${POSTGRES_ODATA_HOST:-localhost}" -p "${POSTGRES_ODATA_PORT:-5432}" -U postgres -tc "SELECT 1 FROM pg_user WHERE usename = '$POSTGRES_ODATA_USER'" | grep -q 1 || \
PGPASSWORD=$PGADMIN_PASSWORD psql -h "${POSTGRES_ODATA_HOST:-localhost}" -p "${POSTGRES_ODATA_PORT:-5432}" -U postgres <<EOF
CREATE USER $POSTGRES_ODATA_USER WITH PASSWORD '$POSTGRES_ODATA_PASSWORD';
EOF

if [ $? -eq 0 ]; then
    echo "✓ User '$POSTGRES_ODATA_USER' created or already exists"
else
    echo "❌ Error creating user"
    exit 1
fi

# Create database if not exists
echo "Creating database..."
PGPASSWORD=$PGADMIN_PASSWORD psql -h "${POSTGRES_ODATA_HOST:-localhost}" -p "${POSTGRES_ODATA_PORT:-5432}" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_ODATA_DB'" | grep -q 1 || \
PGPASSWORD=$PGADMIN_PASSWORD psql -h "${POSTGRES_ODATA_HOST:-localhost}" -p "${POSTGRES_ODATA_PORT:-5432}" -U postgres <<EOF
CREATE DATABASE $POSTGRES_ODATA_DB OWNER $POSTGRES_ODATA_USER;
EOF

if [ $? -eq 0 ]; then
    echo "✓ Database '$POSTGRES_ODATA_DB' created or already exists"
else
    echo "❌ Error creating database"
    exit 1
fi

# Grant privileges
echo "Granting privileges..."
PGPASSWORD=$PGADMIN_PASSWORD psql -h "${POSTGRES_ODATA_HOST:-localhost}" -p "${POSTGRES_ODATA_PORT:-5432}" -U postgres <<EOF
GRANT ALL PRIVILEGES ON DATABASE $POSTGRES_ODATA_DB TO $POSTGRES_ODATA_USER;
ALTER DATABASE $POSTGRES_ODATA_DB OWNER TO $POSTGRES_ODATA_USER;
EOF

if [ $? -eq 0 ]; then
    echo "✓ Privileges granted"
else
    echo "❌ Error granting privileges"
    exit 1
fi

# Run schema
echo ""
echo "Running database schema..."
PGPASSWORD=$POSTGRES_ODATA_PASSWORD psql -h "${POSTGRES_ODATA_HOST:-localhost}" -p "${POSTGRES_ODATA_PORT:-5432}" -U $POSTGRES_ODATA_USER -d $POSTGRES_ODATA_DB -f schema.sql

if [ $? -eq 0 ]; then
    echo "✓ Schema created successfully"
else
    echo "❌ Error creating schema"
    exit 1
fi

# Get table count
TABLE_COUNT=$(PGPASSWORD=$POSTGRES_ODATA_PASSWORD psql -h "${POSTGRES_ODATA_HOST:-localhost}" -p "${POSTGRES_ODATA_PORT:-5432}" -U $POSTGRES_ODATA_USER -d $POSTGRES_ODATA_DB -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")

echo ""
echo "=========================================="
echo "✅ Database Setup Complete!"
echo "=========================================="
echo ""
echo "Database: $POSTGRES_ODATA_DB"
echo "User: $POSTGRES_ODATA_USER"
echo "Tables created: $TABLE_COUNT"
echo ""
echo "Connection URL:"
echo "postgresql://$POSTGRES_ODATA_USER:****@${POSTGRES_ODATA_HOST:-localhost}:${POSTGRES_ODATA_PORT:-5432}/$POSTGRES_ODATA_DB"
echo ""
echo "You can now connect to the database using:"
echo "psql -h ${POSTGRES_ODATA_HOST:-localhost} -p ${POSTGRES_ODATA_PORT:-5432} -U $POSTGRES_ODATA_USER -d $POSTGRES_ODATA_DB"
echo ""
