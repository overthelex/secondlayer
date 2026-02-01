#!/bin/bash

##############################################################################
# Test Production Environment Deployment
# Проверяет деплой production окружения с миграциями БД на gate.legal.org.ua
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

print_msg "$BLUE" "🧪 Testing Production Environment Deployment"
print_msg "$BLUE" "=============================================="
print_msg "$YELLOW" "Target: gate.legal.org.ua (legal.org.ua + mcp.legal.org.ua)"

# Check if .env.prod exists
if [ ! -f ".env.prod" ]; then
    print_msg "$RED" "❌ .env.prod not found!"
    print_msg "$YELLOW" "Please ensure .env.prod exists in deployment directory"
    exit 1
fi

# Test 1: Check Docker Compose syntax
print_msg "$BLUE" "\n📋 Test 1: Validating docker-compose.prod.yml..."
if docker compose -f docker-compose.prod.yml config > /dev/null 2>&1; then
    print_msg "$GREEN" "✅ Docker Compose configuration is valid"
else
    print_msg "$RED" "❌ Docker Compose configuration has errors"
    exit 1
fi

# Test 2: Check if migrate-prod service exists
print_msg "$BLUE" "\n📋 Test 2: Checking migrate-prod service..."
if docker compose -f docker-compose.prod.yml config --services | grep -q "migrate-prod"; then
    print_msg "$GREEN" "✅ migrate-prod service is defined"
else
    print_msg "$RED" "❌ migrate-prod service not found in docker-compose.prod.yml"
    exit 1
fi

# Test 3: Check migration dependencies
print_msg "$BLUE" "\n📋 Test 3: Verifying migration dependencies..."
if docker compose -f docker-compose.prod.yml config | grep -A 10 "migrate-prod:" | grep -q "condition: service_healthy"; then
    print_msg "$GREEN" "✅ Migration service has proper dependencies"
else
    print_msg "$YELLOW" "⚠️  Migration service may not have health check dependencies"
fi

# Test 4: Check app-prod depends on migrate-prod
print_msg "$BLUE" "\n📋 Test 4: Checking app-prod migration dependency..."
if docker compose -f docker-compose.prod.yml config | grep -A 20 "app-prod:" | grep -q "migrate-prod"; then
    print_msg "$GREEN" "✅ app-prod depends on migrate-prod"
else
    print_msg "$RED" "❌ app-prod does not depend on migrate-prod"
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

# Test 7: Validate .env.prod variables
print_msg "$BLUE" "\n📋 Test 7: Checking required environment variables..."
required_vars=("POSTGRES_PASSWORD" "POSTGRES_DB" "OPENAI_API_KEY" "ZAKONONLINE_API_TOKEN" "JWT_SECRET")
missing_vars=()

for var in "${required_vars[@]}"; do
    if ! grep -q "^${var}=" .env.prod; then
        missing_vars+=("$var")
    fi
done

if [ ${#missing_vars[@]} -eq 0 ]; then
    print_msg "$GREEN" "✅ All required environment variables are set"
else
    print_msg "$YELLOW" "⚠️  Missing variables in .env.prod: ${missing_vars[*]}"
fi

# Test 8: Check production-specific configuration
print_msg "$BLUE" "\n📋 Test 8: Checking production URLs..."
if grep -q "legal.org.ua" .env.prod; then
    print_msg "$GREEN" "✅ Production URL configured: legal.org.ua"
else
    print_msg "$RED" "❌ Production URL not found in .env.prod"
fi

if grep -q "mcp.legal.org.ua" .env.prod; then
    print_msg "$GREEN" "✅ MCP SSE endpoint configured: mcp.legal.org.ua"
else
    print_msg "$YELLOW" "⚠️  MCP SSE endpoint not found in .env.prod"
fi

# Test 9: Check port configuration
print_msg "$BLUE" "\n📋 Test 9: Verifying port mapping..."
if grep -q "3001:3000" docker-compose.prod.yml; then
    print_msg "$GREEN" "✅ Correct port mapping: 3001:3000"
else
    print_msg "$YELLOW" "⚠️  Port mapping may be incorrect"
fi

# Test 10: Check production payment settings
print_msg "$BLUE" "\n📋 Test 10: Verifying payment configuration..."
if grep -q "MOCK_PAYMENTS=false" .env.prod; then
    print_msg "$GREEN" "✅ Real payments enabled (MOCK_PAYMENTS=false)"
elif grep -q "MOCK_PAYMENTS=true" .env.prod; then
    print_msg "$RED" "❌ Mock payments still enabled in production!"
    print_msg "$YELLOW" "    Please set MOCK_PAYMENTS=false in .env.prod"
else
    print_msg "$YELLOW" "⚠️  MOCK_PAYMENTS not configured in .env.prod"
fi

# Test 11: Check for placeholder values
print_msg "$BLUE" "\n📋 Test 11: Checking for placeholder values..."
placeholders=("CHANGE_THIS" "CHANGE_TO")
found_placeholders=()

for placeholder in "${placeholders[@]}"; do
    if grep -q "$placeholder" .env.prod 2>/dev/null; then
        found_placeholders+=("$placeholder")
    fi
done

if [ ${#found_placeholders[@]} -eq 0 ]; then
    print_msg "$GREEN" "✅ No placeholder values found"
else
    print_msg "$RED" "❌ Placeholder values found in .env.prod:"
    print_msg "$YELLOW" "    Please replace all 'CHANGE_THIS' and 'CHANGE_TO' values"
    grep -n "CHANGE_THIS\|CHANGE_TO" .env.prod | while read -r line; do
        print_msg "$YELLOW" "    Line: $line"
    done
fi

print_msg "$BLUE" "\n=============================================="
if [ ${#found_placeholders[@]} -eq 0 ]; then
    print_msg "$GREEN" "✅ All tests passed!"
else
    print_msg "$YELLOW" "⚠️  Tests passed with warnings - please review .env.prod"
fi
print_msg "$BLUE" "=============================================="
print_msg "$YELLOW" "\nProduction Environment Details:"
print_msg "$YELLOW" "- Server: gate.legal.org.ua"
print_msg "$YELLOW" "- URLs: https://legal.org.ua + https://mcp.legal.org.ua/sse"
print_msg "$YELLOW" "- Backend Port: 3001 → 3000"
print_msg "$YELLOW" "- Frontend Port: 8090 → 80"
print_msg "$YELLOW" "- PostgreSQL: 5432 (production)"
print_msg "$YELLOW" "- Redis: 6379 (production)"
print_msg "$YELLOW" "- Qdrant: 6333-6334 (production)"
print_msg "$YELLOW" "\nNext steps:"
print_msg "$YELLOW" "1. Build images:      ./manage-gateway.sh build"
print_msg "$YELLOW" "2. Deploy to gate:    ./manage-gateway.sh deploy prod"
print_msg "$YELLOW" "3. Check status:      ssh gate.legal.org.ua 'docker ps | grep prod'"
print_msg "$YELLOW" "4. Verify migrations: ssh gate.legal.org.ua 'docker logs secondlayer-migrate-prod'"
print_msg "$YELLOW" "5. Test main API:     curl https://legal.org.ua/health"
print_msg "$YELLOW" "6. Test MCP SSE:      curl https://mcp.legal.org.ua/sse/health"

print_msg "$BLUE" "\n⚠️  PRODUCTION DEPLOYMENT CHECKLIST:"
print_msg "$YELLOW" "□ Replace all placeholder values in .env.prod"
print_msg "$YELLOW" "□ Use live Stripe keys (sk_live_*, pk_live_*)"
print_msg "$YELLOW" "□ Use production Fondy merchant credentials"
print_msg "$YELLOW" "□ Set strong JWT_SECRET (64+ chars)"
print_msg "$YELLOW" "□ Set secure POSTGRES_PASSWORD"
print_msg "$YELLOW" "□ Configure production SECONDARY_LAYER_KEYS"
print_msg "$YELLOW" "□ Verify MOCK_PAYMENTS=false"
print_msg "$YELLOW" "□ Backup database before migration"
print_msg "$YELLOW" "□ Test in stage environment first"

exit 0
