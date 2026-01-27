#!/bin/bash

# OPENREYESTR Quick Start Script
# This script sets up and starts the OPENREYESTR database

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$SCRIPT_DIR/mcp_openreyestr"

echo "======================================"
echo "OPENREYESTR Database Setup"
echo "======================================"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Error: Docker is not running. Please start Docker first."
    exit 1
fi

# Step 1: Start containers
echo "📦 Step 1: Starting Docker containers..."
cd "$SCRIPT_DIR"
docker-compose up -d openreyestr-postgres openreyestr-redis

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
sleep 5

MAX_RETRIES=30
RETRY_COUNT=0
while ! docker exec openreyestr_postgres pg_isready -U openreyestr -d openreyestr > /dev/null 2>&1; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo "❌ Error: PostgreSQL did not become ready in time"
        docker-compose logs openreyestr-postgres
        exit 1
    fi
    echo "  Waiting... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

echo "✅ PostgreSQL is ready!"
echo ""

# Step 2: Check if mcp_openreyestr exists
if [ ! -d "$MCP_DIR" ]; then
    echo "❌ Error: mcp_openreyestr directory not found at $MCP_DIR"
    exit 1
fi

# Step 3: Install dependencies
echo "📦 Step 2: Installing Node.js dependencies..."
cd "$MCP_DIR"
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "  Dependencies already installed, skipping..."
fi
echo ""

# Step 4: Run migrations
echo "🗄️  Step 3: Running database migrations..."
npm run migrate
echo ""

# Step 5: Check if data needs to be imported
DATA_COUNT=$(docker exec openreyestr_postgres psql -U openreyestr -d openreyestr -t -c "SELECT COUNT(*) FROM legal_entities;" 2>/dev/null | tr -d ' ' || echo "0")

if [ "$DATA_COUNT" -eq "0" ]; then
    echo "📥 Step 4: No data found in database. Would you like to import data now?"
    echo ""
    echo "Please specify the path to your OPENREYESTR ZIP file:"
    echo "  Default: $SCRIPT_DIR/20260126174103-69.zip"
    echo ""
    read -p "Enter path (or press Enter for default): " ZIP_PATH

    if [ -z "$ZIP_PATH" ]; then
        ZIP_PATH="$SCRIPT_DIR/20260126174103-69.zip"
    fi

    if [ -f "$ZIP_PATH" ]; then
        echo "📥 Importing data from $ZIP_PATH..."
        echo "⚠️  This may take 1-3 hours depending on your hardware."
        npm run import:all "$ZIP_PATH"
        echo "✅ Data import completed!"
    else
        echo "⚠️  File not found: $ZIP_PATH"
        echo "You can import data later with: cd $MCP_DIR && npm run import:all /path/to/data.zip"
    fi
else
    echo "✅ Step 4: Database already contains $DATA_COUNT legal entities. Skipping import."
fi
echo ""

# Step 6: Show status
echo "======================================"
echo "✅ OPENREYESTR Setup Complete!"
echo "======================================"
echo ""
echo "Container Status:"
docker-compose ps openreyestr-postgres openreyestr-redis
echo ""
echo "Database Statistics:"
docker exec openreyestr_postgres psql -U openreyestr -d openreyestr -c "
SELECT
    'Legal Entities' as type,
    COUNT(*) as count
FROM legal_entities
UNION ALL
SELECT
    'Individual Entrepreneurs' as type,
    COUNT(*) as count
FROM individual_entrepreneurs
UNION ALL
SELECT
    'Public Associations' as type,
    COUNT(*) as count
FROM public_associations;" 2>/dev/null || echo "Database tables not yet populated"
echo ""
echo "Next Steps:"
echo "  1. Start MCP server:    cd $MCP_DIR && npm start"
echo "  2. Start HTTP API:      cd $MCP_DIR && npm run start:http"
echo "  3. View logs:           docker-compose logs -f openreyestr-postgres"
echo "  4. Stop containers:     docker-compose stop openreyestr-postgres openreyestr-redis"
echo ""
echo "For more information, see README_DOCKER.md"
echo ""
