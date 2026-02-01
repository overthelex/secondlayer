#!/bin/bash

##############################################################################
# Test Development Environment Deployment
# Проверяет деплой dev окружения с миграциями БД
##############################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_msg() {
    local color=$1
    shift
    echo -e "${color}$@${NC}"
}

print_msg "$BLUE" "🧪 Testing Development Environment Deployment"
print_msg "$BLUE" "=============================================="

# Check if .env.dev exists
if [ ! -f ".env.dev" ]; then
    print_msg "$RED" "❌ .env.dev not found!"
    print_msg "$YELLOW" "Please ensure .env.dev exists in deployment directory"
    exit 1
fi

# Test 1: Check Docker Compose syntax
print_msg "$BLUE" "\n📋 Test 1: Validating docker-compose.dev.yml..."
if docker compose -f docker-compose.dev.yml config > /dev/null 2>&1; then
    print_msg "$GREEN" "✅ Docker Compose configuration is valid"
else
    print_msg "$RED" "❌ Docker Compose configuration has errors"
    exit 1
fi

# Test 2: Check if migrate-dev service exists
print_msg "$BLUE" "\n📋 Test 2: Checking migrate-dev service..."
if docker compose -f docker-compose.dev.yml config --services | grep -q "migrate-dev"; then
    print_msg "$GREEN" "✅ migrate-dev service is defined"
else
    print_msg "$RED" "❌ migrate-dev service not found in docker-compose.dev.yml"
    exit 1
fi

# Test 3: Check migration dependencies
print_msg "$BLUE" "\n📋 Test 3: Verifying migration dependencies..."
if docker compose -f docker-compose.dev.yml config | grep -A 10 "migrate-dev:" | grep -q "condition: service_healthy"; then
    print_msg "$GREEN" "✅ Migration service has proper dependencies"
else
    print_msg "$YELLOW" "⚠️  Migration service may not have health check dependencies"
fi

# Test 4: Check app-dev depends on migrate-dev
print_msg "$BLUE" "\n📋 Test 4: Checking app-dev migration dependency..."
if docker compose -f docker-compose.dev.yml config | grep -A 20 "app-dev:" | grep -q "migrate-dev"; then
    print_msg "$GREEN" "✅ app-dev depends on migrate-dev"
else
    print_msg "$RED" "❌ app-dev does not depend on migrate-dev"
    exit 1
fi

# Test 5: Check migration files
print_msg "$BLUE" "\n📋 Test 5: Counting migration files..."
migration_count=$(ls -1 ../mcp_backend/src/migrations/*.sql 2>/dev/null | wc -l)
if [ "$migration_count" -gt 0 ]; then
    print_msg "$GREEN" "✅ Found $migration_count SQL migration files"
else
    print_msg "$RED" "❌ No migration files found in mcp_backend/src/migrations/"
    exit 1
fi

# Test 6: Check if Docker image exists
print_msg "$BLUE" "\n📋 Test 6: Checking Docker image..."
if docker images | grep -q "secondlayer-app"; then
    print_msg "$GREEN" "✅ secondlayer-app:latest image exists"
else
    print_msg "$YELLOW" "⚠️  secondlayer-app:latest image not found"
    print_msg "$YELLOW" "    Run: ./manage-gateway.sh build"
fi

# Test 7: Validate .env.dev variables
print_msg "$BLUE" "\n📋 Test 7: Checking required environment variables..."
required_vars=("POSTGRES_PASSWORD" "POSTGRES_DB" "OPENAI_API_KEY" "ZAKONONLINE_API_TOKEN" "JWT_SECRET")
missing_vars=()

for var in "${required_vars[@]}"; do
    if ! grep -q "^${var}=" .env.dev; then
        missing_vars+=("$var")
    fi
done

if [ ${#missing_vars[@]} -eq 0 ]; then
    print_msg "$GREEN" "✅ All required environment variables are set"
else
    print_msg "$YELLOW" "⚠️  Missing variables in .env.dev: ${missing_vars[*]}"
fi

print_msg "$BLUE" "\n=============================================="
print_msg "$GREEN" "✅ All tests passed!"
print_msg "$BLUE" "=============================================="
print_msg "$YELLOW" "\nNext steps:"
print_msg "$YELLOW" "1. Build images:    ./manage-gateway.sh build"
print_msg "$YELLOW" "2. Start local:     ./manage-gateway.sh start dev"
print_msg "$YELLOW" "3. Check status:    ./manage-gateway.sh status"
print_msg "$YELLOW" "4. Deploy to gate:  ./manage-gateway.sh deploy dev"
print_msg "$YELLOW" "5. View logs:       ./manage-gateway.sh logs dev"

exit 0
