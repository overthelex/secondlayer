#!/bin/bash

##############################################################################
# SecondLayer Multi-Environment Management Script
# Manages Production, Staging, Development, and Local environments
##############################################################################

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
GATE_SERVER="gate.lexapp.co.ua"
GATE_USER="vovkes"
REMOTE_PATH="/home/vovkes/secondlayer-deployment"

# Print colored message
print_msg() {
    local color=$1
    shift
    echo -e "${color}$@${NC}"
}

# Print usage
usage() {
    cat << EOF
SecondLayer Multi-Environment Manager

Usage: $0 <command> [environment] [options]

Commands:
  start <env>       Start environment (prod|stage|dev|local|all)
  stop <env>        Stop environment (prod|stage|dev|local|all)
  restart <env>     Restart environment (prod|stage|dev|local|all)
  status            Show status of all environments
  logs <env>        Show logs for environment (prod|stage|dev|local|gateway)
  deploy <env>      Deploy to gate server (prod|stage|dev|all)
  build             Build Docker images
  gateway           Manage nginx gateway
    - start         Start nginx gateway
    - stop          Stop nginx gateway
    - restart       Restart nginx gateway
    - test          Test nginx configuration
  health            Check health of all services
  clean <env>       Clean environment data (USE WITH CAUTION!)

Environments:
  prod              Production (legal.org.ua)
  stage             Staging (legal.org.ua/staging)
  dev               Development (dev.legal.org.ua)
  local             Local development (localhost:3000)
  all               All gateway environments (prod+stage+dev, excludes local)

Examples:
  $0 start local             # Start local development environment
  $0 start prod              # Start production environment
  $0 start all               # Start all gateway environments (not local)
  $0 stop dev                # Stop development environment
  $0 restart stage           # Restart staging environment
  $0 logs local              # Show local environment logs
  $0 deploy prod             # Deploy production to gate server
  $0 gateway start           # Start nginx gateway
  $0 health                  # Check health of all services
  $0 status                  # Show status of all containers

EOF
    exit 1
}

# Check if docker-compose is available
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_msg "$RED" "❌ Docker is not installed or not in PATH"
        exit 1
    fi

    if ! command -v docker compose &> /dev/null && ! command -v docker-compose &> /dev/null; then
        print_msg "$RED" "❌ Docker Compose is not installed or not in PATH"
        exit 1
    fi
}

# Get docker compose command (handles both docker-compose and docker compose)
get_compose_cmd() {
    if command -v docker compose &> /dev/null; then
        echo "docker compose"
    else
        echo "docker-compose"
    fi
}

# Start environment
start_env() {
    local env=$1
    local compose_cmd=$(get_compose_cmd)

    print_msg "$BLUE" "🚀 Starting $env environment..."

    case $env in
        prod|production)
            if [ ! -f ".env.prod" ]; then
                print_msg "$RED" "❌ .env.prod not found. Copy .env.prod.example and configure it."
                exit 1
            fi
            $compose_cmd -f docker-compose.prod.yml --env-file .env.prod up -d
            ;;
        stage|staging)
            if [ ! -f ".env.stage" ]; then
                print_msg "$RED" "❌ .env.stage not found. Copy .env.stage.example and configure it."
                exit 1
            fi
            $compose_cmd -f docker-compose.stage.yml --env-file .env.stage up -d
            ;;
        dev|development)
            if [ ! -f ".env.dev" ]; then
                print_msg "$RED" "❌ .env.dev not found. Copy .env.dev.example and configure it."
                exit 1
            fi
            $compose_cmd -f docker-compose.dev.yml --env-file .env.dev up -d
            ;;
        local)
            if [ ! -f ".env.local" ]; then
                print_msg "$YELLOW" "⚠️  .env.local not found. Using defaults from docker-compose.local.yml"
                print_msg "$YELLOW" "    Copy .env.local.example to .env.local for custom configuration"
                $compose_cmd -f docker-compose.local.yml up -d --build \
                    postgres-local redis-local qdrant-local \
                    migrate-local app-local document-service-local \
                    rada-db-init-local rada-migrate-local rada-mcp-app-local
            else
                $compose_cmd -f docker-compose.local.yml --env-file .env.local up -d --build \
                    postgres-local redis-local qdrant-local \
                    migrate-local app-local document-service-local \
                    rada-db-init-local rada-migrate-local rada-mcp-app-local
            fi
            ;;
        all)
            start_env prod
            start_env stage
            start_env dev
            ;;
        *)
            print_msg "$RED" "❌ Invalid environment: $env"
            usage
            ;;
    esac

    if [ "$env" != "all" ]; then
        print_msg "$GREEN" "✅ $env environment started"
    fi
}

# Stop environment
stop_env() {
    local env=$1
    local compose_cmd=$(get_compose_cmd)

    print_msg "$BLUE" "🛑 Stopping $env environment..."

    case $env in
        prod|production)
            $compose_cmd -f docker-compose.prod.yml --env-file .env.prod down
            ;;
        stage|staging)
            $compose_cmd -f docker-compose.stage.yml --env-file .env.stage down
            ;;
        dev|development)
            $compose_cmd -f docker-compose.dev.yml --env-file .env.dev down
            ;;
        local)
            if [ -f ".env.local" ]; then
                $compose_cmd -f docker-compose.local.yml --env-file .env.local down
            else
                $compose_cmd -f docker-compose.local.yml down
            fi
            ;;
        all)
            stop_env prod
            stop_env stage
            stop_env dev
            ;;
        *)
            print_msg "$RED" "❌ Invalid environment: $env"
            usage
            ;;
    esac

    if [ "$env" != "all" ]; then
        print_msg "$GREEN" "✅ $env environment stopped"
    fi
}

# Restart environment
restart_env() {
    local env=$1
    stop_env "$env"
    sleep 2
    start_env "$env"
}

# Show status
show_status() {
    local compose_cmd=$(get_compose_cmd)

    print_msg "$BLUE" "📊 Environment Status\n"

    print_msg "$YELLOW" "=== Production ==="
    docker ps --filter "name=secondlayer-.*-prod" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""

    print_msg "$YELLOW" "=== Staging ==="
    docker ps --filter "name=secondlayer-.*-stage" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""

    print_msg "$YELLOW" "=== Development ==="
    docker ps --filter "name=secondlayer-.*-dev" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""

    print_msg "$YELLOW" "=== Local ==="
    docker ps --filter "name=secondlayer-.*-local" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""

    print_msg "$YELLOW" "=== Gateway ==="
    docker ps --filter "name=legal-nginx-gateway" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""
}

# Show logs
show_logs() {
    local env=$1
    local compose_cmd=$(get_compose_cmd)

    case $env in
        prod|production)
            $compose_cmd -f docker-compose.prod.yml --env-file .env.prod logs -f --tail=100
            ;;
        stage|staging)
            $compose_cmd -f docker-compose.stage.yml --env-file .env.stage logs -f --tail=100
            ;;
        dev|development)
            $compose_cmd -f docker-compose.dev.yml --env-file .env.dev logs -f --tail=100
            ;;
        local)
            if [ -f ".env.local" ]; then
                $compose_cmd -f docker-compose.local.yml --env-file .env.local logs -f --tail=100
            else
                $compose_cmd -f docker-compose.local.yml logs -f --tail=100
            fi
            ;;
        gateway)
            $compose_cmd -f docker-compose.gateway.yml logs -f --tail=100
            ;;
        *)
            print_msg "$RED" "❌ Invalid environment: $env"
            usage
            ;;
    esac
}

# Manage gateway
manage_gateway() {
    local action=$1
    local compose_cmd=$(get_compose_cmd)

    case $action in
        start)
            print_msg "$BLUE" "🚀 Starting nginx gateway..."
            $compose_cmd -f docker-compose.gateway.yml up -d
            print_msg "$GREEN" "✅ Nginx gateway started"
            ;;
        stop)
            print_msg "$BLUE" "🛑 Stopping nginx gateway..."
            $compose_cmd -f docker-compose.gateway.yml down
            print_msg "$GREEN" "✅ Nginx gateway stopped"
            ;;
        restart)
            manage_gateway stop
            sleep 2
            manage_gateway start
            ;;
        test)
            print_msg "$BLUE" "🔍 Testing nginx configuration..."
            docker exec legal-nginx-gateway nginx -t
            print_msg "$GREEN" "✅ Nginx configuration is valid"
            ;;
        *)
            print_msg "$RED" "❌ Invalid gateway action: $action"
            echo "Valid actions: start, stop, restart, test"
            exit 1
            ;;
    esac
}

# Build Docker images
build_images() {
    print_msg "$BLUE" "🔨 Building Docker images..."

    cd ..

    # Build backend (from root context with backend Dockerfile)
    print_msg "$BLUE" "Building backend image..."
    docker build -f mcp_backend/Dockerfile -t secondlayer-app:latest .

    # Build frontend
    print_msg "$BLUE" "Building frontend image..."
    if [ -d "frontend" ]; then
        cd frontend
        docker build -t lexwebapp-lexwebapp:latest .
        cd ..
    elif [ -d "lexwebapp" ]; then
        cd lexwebapp
        docker build -t lexwebapp-lexwebapp:latest .
        cd ..
    fi

    cd deployment
    print_msg "$GREEN" "✅ Images built successfully"
}

# Check health
check_health() {
    print_msg "$BLUE" "🏥 Checking health of all services...\n"

    # Production
    print_msg "$YELLOW" "=== Production ==="
    curl -sf https://legal.org.ua/health > /dev/null && print_msg "$GREEN" "✅ Backend: healthy" || print_msg "$RED" "❌ Backend: unhealthy"
    curl -sf https://legal.org.ua > /dev/null && print_msg "$GREEN" "✅ Frontend: healthy" || print_msg "$RED" "❌ Frontend: unhealthy"

    # Staging
    print_msg "$YELLOW" "\n=== Staging ==="
    curl -sf https://stage.legal.org.ua/health > /dev/null && print_msg "$GREEN" "✅ Backend: healthy" || print_msg "$RED" "❌ Backend: unhealthy"
    curl -sf https://stage.legal.org.ua > /dev/null && print_msg "$GREEN" "✅ Frontend: healthy" || print_msg "$RED" "❌ Frontend: unhealthy"

    # Development
    print_msg "$YELLOW" "\n=== Development ==="
    curl -sf https://dev.legal.org.ua/health > /dev/null && print_msg "$GREEN" "✅ Backend: healthy" || print_msg "$RED" "❌ Backend: unhealthy"
    curl -sf https://dev.legal.org.ua > /dev/null && print_msg "$GREEN" "✅ Frontend: healthy" || print_msg "$RED" "❌ Frontend: unhealthy"

    # Local
    print_msg "$YELLOW" "\n=== Local ==="
    curl -sf http://localhost:3000/health > /dev/null && print_msg "$GREEN" "✅ Backend: healthy" || print_msg "$RED" "❌ Backend: unhealthy"
    curl -sf http://localhost:3000 > /dev/null && print_msg "$GREEN" "✅ Frontend: healthy" || print_msg "$RED" "❌ Frontend: unhealthy"

    # Gateway
    print_msg "$YELLOW" "\n=== Gateway ==="
    curl -sf http://localhost:8080/health > /dev/null && print_msg "$GREEN" "✅ Gateway: healthy" || print_msg "$RED" "❌ Gateway: unhealthy"

    echo ""
}

# Deploy to gate server
deploy_to_gate() {
    local env=$1

    print_msg "$BLUE" "🚀 Deploying $env to gate server..."

    # Check if .env file exists
    case $env in
        prod|production)
            local env_file=".env.prod"
            local compose_file="docker-compose.prod.yml"
            ;;
        stage|staging)
            local env_file=".env.stage"
            local compose_file="docker-compose.stage.yml"
            ;;
        dev|development)
            local env_file=".env.dev"
            local compose_file="docker-compose.dev.yml"
            ;;
        all)
            deploy_to_gate prod
            deploy_to_gate stage
            deploy_to_gate dev
            return
            ;;
        *)
            print_msg "$RED" "❌ Invalid environment: $env"
            exit 1
            ;;
    esac

    if [ ! -f "$env_file" ]; then
        print_msg "$RED" "❌ $env_file not found"
        exit 1
    fi

    # Create deployment directory on server
    ssh ${GATE_USER}@${GATE_SERVER} "mkdir -p ${REMOTE_PATH}"

    # Copy files
    print_msg "$BLUE" "📤 Copying files to gate server..."
    scp $compose_file ${GATE_USER}@${GATE_SERVER}:${REMOTE_PATH}/
    scp $env_file ${GATE_USER}@${GATE_SERVER}:${REMOTE_PATH}/

    # Start containers on server
    print_msg "$BLUE" "🔄 Starting containers on gate server..."
    ssh ${GATE_USER}@${GATE_SERVER} << EOF
        cd ${REMOTE_PATH}
        docker compose -f $compose_file --env-file $env_file up -d
EOF

    print_msg "$GREEN" "✅ $env deployed to gate server"
}

# Clean environment data
clean_env() {
    local env=$1
    local compose_cmd=$(get_compose_cmd)

    print_msg "$RED" "⚠️  WARNING: This will delete all data for $env environment!"
    read -p "Are you sure? Type 'yes' to confirm: " confirm

    if [ "$confirm" != "yes" ]; then
        print_msg "$YELLOW" "Aborted"
        exit 0
    fi

    case $env in
        prod|production)
            $compose_cmd -f docker-compose.prod.yml --env-file .env.prod down -v
            ;;
        stage|staging)
            $compose_cmd -f docker-compose.stage.yml --env-file .env.stage down -v
            ;;
        dev|development)
            $compose_cmd -f docker-compose.dev.yml --env-file .env.dev down -v
            ;;
        *)
            print_msg "$RED" "❌ Invalid environment: $env"
            exit 1
            ;;
    esac

    print_msg "$GREEN" "✅ $env environment cleaned"
}

# Main script
check_docker

if [ $# -eq 0 ]; then
    usage
fi

COMMAND=$1
shift

case $COMMAND in
    start)
        if [ $# -eq 0 ]; then
            usage
        fi
        start_env "$1"
        ;;
    stop)
        if [ $# -eq 0 ]; then
            usage
        fi
        stop_env "$1"
        ;;
    restart)
        if [ $# -eq 0 ]; then
            usage
        fi
        restart_env "$1"
        ;;
    status)
        show_status
        ;;
    logs)
        if [ $# -eq 0 ]; then
            usage
        fi
        show_logs "$1"
        ;;
    deploy)
        if [ $# -eq 0 ]; then
            usage
        fi
        deploy_to_gate "$1"
        ;;
    build)
        build_images
        ;;
    gateway)
        if [ $# -eq 0 ]; then
            usage
        fi
        manage_gateway "$1"
        ;;
    health)
        check_health
        ;;
    clean)
        if [ $# -eq 0 ]; then
            usage
        fi
        clean_env "$1"
        ;;
    *)
        print_msg "$RED" "❌ Unknown command: $COMMAND"
        usage
        ;;
esac
