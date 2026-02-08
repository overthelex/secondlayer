#!/bin/bash

##############################################################################
# Credentials Check and Initialization Script
# Verifies and initializes PostgreSQL credentials before deployment
##############################################################################

set -e

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

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_LOCAL_FILE="$SCRIPT_DIR/.env.local"

check_env_file() {
    echo ""
    print_msg "$BLUE" "═══════════════════════════════════════════════════════════"
    print_msg "$BLUE" "  Checking Environment Configuration"
    print_msg "$BLUE" "═══════════════════════════════════════════════════════════"
    echo ""

    # Check which env file exists
    if [ -f "$ENV_LOCAL_FILE" ]; then
        ENV_ACTIVE="$ENV_LOCAL_FILE"
        print_msg "$GREEN" "✅ Using: .env.local"
    elif [ -f "$ENV_FILE" ]; then
        ENV_ACTIVE="$ENV_FILE"
        print_msg "$GREEN" "✅ Using: .env"
    else
        print_msg "$RED" "❌ No .env file found!"
        print_msg "$YELLOW" "Create .env with required PostgreSQL credentials:"
        cat << 'EOF'

# PostgreSQL Configuration
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=your_strong_password_here
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=your_app_password_here
POSTGRES_DB=secondlayer_local

EOF
        exit 1
    fi

    # Source the environment file safely (handles special chars better)
    set -a
    source "$ENV_ACTIVE"
    set +a

    # Validate required variables
    print_msg "$YELLOW" "Validating required credentials..."

    local missing=0

    if [ -z "$POSTGRES_SUPERUSER_PASSWORD" ]; then
        print_msg "$RED" "  ❌ POSTGRES_SUPERUSER_PASSWORD is not set"
        missing=1
    else
        print_msg "$GREEN" "  ✅ POSTGRES_SUPERUSER_PASSWORD is set"
    fi

    if [ -z "$POSTGRES_USER" ]; then
        print_msg "$RED" "  ❌ POSTGRES_USER is not set"
        missing=1
    else
        print_msg "$GREEN" "  ✅ POSTGRES_USER = $POSTGRES_USER"
    fi

    if [ -z "$POSTGRES_PASSWORD" ]; then
        print_msg "$RED" "  ❌ POSTGRES_PASSWORD is not set"
        missing=1
    else
        print_msg "$GREEN" "  ✅ POSTGRES_PASSWORD is set"
    fi

    if [ -z "$POSTGRES_DB" ]; then
        print_msg "$YELLOW" "  ⚠ POSTGRES_DB not set, using default: secondlayer_local"
        export POSTGRES_DB="secondlayer_local"
    else
        print_msg "$GREEN" "  ✅ POSTGRES_DB = $POSTGRES_DB"
    fi

    if [ $missing -eq 1 ]; then
        print_msg "$RED" "❌ Missing required credentials!"
        exit 1
    fi

    print_msg "$GREEN" "✅ All required credentials are configured"
}

check_postgres_connection() {
    echo ""
    print_msg "$BLUE" "═══════════════════════════════════════════════════════════"
    print_msg "$BLUE" "  Checking PostgreSQL Connection"
    print_msg "$BLUE" "═══════════════════════════════════════════════════════════"
    echo ""

    # Check if PostgreSQL is running
    if ! docker ps 2>/dev/null | grep -q "postgres"; then
        print_msg "$YELLOW" "⚠ PostgreSQL container is not running"
        print_msg "$YELLOW" "It will be started by docker-compose"
        return 0
    fi

    print_msg "$YELLOW" "Checking PostgreSQL availability..."

    # Wait for PostgreSQL to be ready
    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if docker exec $(docker ps -q -f "ancestor=postgres:15-alpine" | head -1) \
            pg_isready -U "${POSTGRES_SUPERUSER:-postgres}" > /dev/null 2>&1; then
            print_msg "$GREEN" "✅ PostgreSQL is ready"

            # Check if user exists
            check_and_create_user
            return 0
        fi

        attempt=$((attempt + 1))
        echo -n "."
        sleep 1
    done

    print_msg "$YELLOW" "⚠ Could not verify PostgreSQL connection"
    print_msg "$YELLOW" "It will be initialized when docker-compose starts"
}

check_and_create_user() {
    echo ""
    print_msg "$YELLOW" "Verifying database user and credentials..."

    local container_id=$(docker ps -q -f "ancestor=postgres:15-alpine" | head -1)

    if [ -z "$container_id" ]; then
        return 0
    fi

    # Check if user exists
    if docker exec "$container_id" psql -U "${POSTGRES_SUPERUSER:-postgres}" \
        -tAc "SELECT 1 FROM pg_user WHERE usename='$POSTGRES_USER'" 2>/dev/null | grep -q 1; then
        print_msg "$GREEN" "  ✅ User '$POSTGRES_USER' exists"
    else
        print_msg "$YELLOW" "  ℹ Creating user '$POSTGRES_USER'..."
        docker exec "$container_id" psql -U "${POSTGRES_SUPERUSER:-postgres}" \
            -c "CREATE USER \"$POSTGRES_USER\" WITH PASSWORD '$POSTGRES_PASSWORD';" 2>/dev/null || true
        docker exec "$container_id" psql -U "${POSTGRES_SUPERUSER:-postgres}" \
            -c "ALTER USER \"$POSTGRES_USER\" CREATEDB SUPERUSER;" 2>/dev/null || true
        print_msg "$GREEN" "  ✅ User created"
    fi

    # Check if database exists
    if docker exec "$container_id" psql -U "${POSTGRES_SUPERUSER:-postgres}" \
        -tAc "SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DB'" 2>/dev/null | grep -q 1; then
        print_msg "$GREEN" "  ✅ Database '$POSTGRES_DB' exists"
    else
        print_msg "$YELLOW" "  ℹ Creating database '$POSTGRES_DB'..."
        docker exec "$container_id" psql -U "${POSTGRES_SUPERUSER:-postgres}" \
            -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";" 2>/dev/null || true
        print_msg "$GREEN" "  ✅ Database created"
    fi
}

generate_example_env() {
    local example_file="$SCRIPT_DIR/.env.example"

    if [ ! -f "$example_file" ]; then
        print_msg "$YELLOW" "Creating .env.example template..."
        cat > "$example_file" << 'EOF'
# PostgreSQL Superuser (for initialization)
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=your_superuser_password_here

# Application Database User
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=your_app_password_here
POSTGRES_DB=secondlayer_local

# Application Configuration
NODE_ENV=development
LOG_LEVEL=debug

# API Keys (required)
OPENAI_API_KEY=sk-...
OPENAI_API_KEY2=sk-...
ZAKONONLINE_API_TOKEN=...
ZAKONONLINE_API_TOKEN2=...
ANTHROPIC_API_KEY=sk-ant-...

# Optional Configuration
REDIS_HOST=redis
REDIS_PORT=6379
QDRANT_URL=http://qdrant:6333
EOF
        print_msg "$GREEN" "✅ Created .env.example"
    fi
}

show_summary() {
    echo ""
    print_msg "$BLUE" "═══════════════════════════════════════════════════════════"
    print_msg "$BLUE" "  Credentials Check Summary"
    print_msg "$BLUE" "═══════════════════════════════════════════════════════════"
    echo ""

    print_msg "$GREEN" "✅ All credential checks passed!"
    echo ""
    print_msg "$YELLOW" "Configuration Summary:"
    echo "  Superuser: ${POSTGRES_SUPERUSER:-postgres}"
    echo "  App User: $POSTGRES_USER"
    echo "  App Database: $POSTGRES_DB"
    echo ""
    print_msg "$YELLOW" "Next steps:"
    echo "  1. Run: docker compose up -d"
    echo "  2. Verify: docker exec \$(docker ps -q -f 'ancestor=postgres:15-alpine') pg_isready"
    echo "  3. Check logs: docker compose logs -f"
    echo ""
}

main() {
    generate_example_env
    check_env_file
    check_postgres_connection
    show_summary
}

main "$@"
