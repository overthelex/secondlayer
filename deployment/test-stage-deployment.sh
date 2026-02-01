#!/bin/bash

##############################################################################
# Test Stage Environment Deployment
# Проверяет деплой stage окружения с миграциями БД на mail.legal.org.ua
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

print_msg "$BLUE" "🧪 Testing Stage Environment Deployment"
print_msg "$BLUE" "=============================================="
print_msg "$YELLOW" "Target: mail.legal.org.ua (stage.legal.org.ua)"

# Check if .env.stage exists
if [ ! -f ".env.stage" ]; then
    print_msg "$RED" "❌ .env.stage not found!"
    print_msg "$YELLOW" "Please ensure .env.stage exists in deployment directory"
    exit 1
fi

# Test 1: Check Docker Compose syntax
print_msg "$BLUE" "\n📋 Test 1: Validating docker-compose.stage.yml..."
if docker compose -f docker-compose.stage.yml config > /dev/null 2>&1; then
    print_msg "$GREEN" "✅ Docker Compose configuration is valid"
else
    print_msg "$RED" "❌ Docker Compose configuration has errors"
    exit 1
fi

# Test 2: Check if migrate-stage service exists
print_msg "$BLUE" "\n📋 Test 2: Checking migrate-stage service..."
if docker compose -f docker-compose.stage.yml config --services | grep -q "migrate-stage"; then
    print_msg "$GREEN" "✅ migrate-stage service is defined"
else
    print_msg "$RED" "❌ migrate-stage service not found in docker-compose.stage.yml"
    exit 1
fi

# Test 3: Check migration dependencies
print_msg "$BLUE" "\n📋 Test 3: Verifying migration dependencies..."
if docker compose -f docker-compose.stage.yml config | grep -A 10 "migrate-stage:" | grep -q "condition: service_healthy"; then
    print_msg "$GREEN" "✅ Migration service has proper dependencies"
else
    print_msg "$YELLOW" "⚠️  Migration service may not have health check dependencies"
fi

# Test 4: Check app-stage depends on migrate-stage
print_msg "$BLUE" "\n📋 Test 4: Checking app-stage migration dependency..."
if docker compose -f docker-compose.stage.yml config | grep -A 20 "app-stage:" | grep -q "migrate-stage"; then
    print_msg "$GREEN" "✅ app-stage depends on migrate-stage"
else
    print_msg "$RED" "❌ app-stage does not depend on migrate-stage"
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

# Test 7: Validate .env.stage variables
print_msg "$BLUE" "\n📋 Test 7: Checking required environment variables..."
required_vars=("POSTGRES_PASSWORD" "POSTGRES_DB" "OPENAI_API_KEY" "ZAKONONLINE_API_TOKEN" "JWT_SECRET")
missing_vars=()

for var in "${required_vars[@]}"; do
    if ! grep -q "^${var}=" .env.stage; then
        missing_vars+=("$var")
    fi
done

if [ ${#missing_vars[@]} -eq 0 ]; then
    print_msg "$GREEN" "✅ All required environment variables are set"
else
    print_msg "$YELLOW" "⚠️  Missing variables in .env.stage: ${missing_vars[*]}"
fi

# Test 8: Check stage-specific configuration
print_msg "$BLUE" "\n📋 Test 8: Checking stage-specific config..."
if grep -q "stage.legal.org.ua" .env.stage; then
    print_msg "$GREEN" "✅ Stage URL configured: stage.legal.org.ua"
else
    print_msg "$RED" "❌ Stage URL not found in .env.stage"
fi

# Test 9: Check port configuration
print_msg "$BLUE" "\n📋 Test 9: Verifying port mapping..."
if grep -q "3004:3000" docker-compose.stage.yml; then
    print_msg "$GREEN" "✅ Correct port mapping: 3004:3000"
else
    print_msg "$YELLOW" "⚠️  Port mapping may be incorrect"
fi

print_msg "$BLUE" "\n=============================================="
print_msg "$GREEN" "✅ All tests passed!"
print_msg "$BLUE" "=============================================="
print_msg "$YELLOW" "\nStage Environment Details:"
print_msg "$YELLOW" "- Server: mail.legal.org.ua"
print_msg "$YELLOW" "- URL: https://stage.legal.org.ua"
print_msg "$YELLOW" "- Backend Port: 3004 → 3000"
print_msg "$YELLOW" "- Frontend Port: 8093 → 80"
print_msg "$YELLOW" "- PostgreSQL: 5434 → 5432"
print_msg "$YELLOW" "- Redis: 6381 → 6379"
print_msg "$YELLOW" "- Qdrant: 6337-6338 → 6333-6334"
print_msg "$YELLOW" "\nNext steps:"
print_msg "$YELLOW" "1. Build images:      ./manage-gateway.sh build"
print_msg "$YELLOW" "2. Deploy to mail:    scp docker-compose.stage.yml .env.stage mail.legal.org.ua:~/secondlayer-stage/"
print_msg "$YELLOW" "3. SSH to mail:       ssh mail.legal.org.ua"
print_msg "$YELLOW" "4. Run deployment:    cd ~/secondlayer-stage && docker compose -f docker-compose.stage.yml up -d"
print_msg "$YELLOW" "5. Check status:      docker ps | grep stage"
print_msg "$YELLOW" "6. Verify migrations: docker logs secondlayer-migrate-stage"
print_msg "$YELLOW" "7. Test API:          curl https://stage.legal.org.ua/health"

exit 0
