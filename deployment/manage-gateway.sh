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
GATE_SERVER="gate.lexapp.co.ua"  # For dev environment
MAIL_SERVER="mail.lexapp.co.ua"  # For stage and prod environments
DEPLOY_USER="vovkes"
REMOTE_PATH="/home/vovkes/SecondLayer/deployment"

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
  deploy <env>      Deploy environment (prod|stage|dev|local|all)
  build             Build Docker images
  gateway           Manage nginx gateway
    - start         Start nginx gateway
    - stop          Stop nginx gateway
    - restart       Restart nginx gateway
    - test          Test nginx configuration
  health            Check health of all services
  clean <env>       Clean environment data (USE WITH CAUTION!)

Environments:
  prod              Production (legal.org.ua) → mail.lexapp.co.ua
  stage             Staging (stage.legal.org.ua) → mail.lexapp.co.ua
  dev               Development (dev.legal.org.ua) → gate.lexapp.co.ua
  local             Local development (localhost:3000) → localhost
  all               All remote environments (prod+stage+dev)

Deployment Targets:
  - Dev: Deploys to gate.lexapp.co.ua
  - Stage: Deploys to mail.lexapp.co.ua
  - Prod: Deploys to mail.lexapp.co.ua
  - Local: Full rebuild on localhost (pull, rebuild --no-cache, migrate)

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
                $compose_cmd -f docker-compose.local.yml up -d --build
            else
                $compose_cmd -f docker-compose.local.yml --env-file .env.local up -d --build
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

    # Build backend (from root context with mono Dockerfile)
    print_msg "$BLUE" "Building backend image..."
    docker build -f Dockerfile.mono-backend -t secondlayer-app:latest .

    # Build RADA MCP (from root context with mono Dockerfile)
    print_msg "$BLUE" "Building RADA MCP image..."
    docker build -f Dockerfile.mono-rada -t rada-mcp:latest .

    # Build OpenReyestr MCP (from root context with mono Dockerfile)
    print_msg "$BLUE" "Building OpenReyestr MCP image..."
    docker build -f Dockerfile.mono-openreyestr -t openreyestr-app:latest .

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

    # Production (mail server)
    print_msg "$YELLOW" "=== Production (mail.lexapp.co.ua) ==="
    curl -sf https://legal.org.ua/health > /dev/null && print_msg "$GREEN" "✅ Backend: healthy" || print_msg "$RED" "❌ Backend: unhealthy"
    curl -sf https://legal.org.ua > /dev/null && print_msg "$GREEN" "✅ Frontend: healthy" || print_msg "$RED" "❌ Frontend: unhealthy"

    # Staging (mail server)
    print_msg "$YELLOW" "\n=== Staging (mail.lexapp.co.ua) ==="
    curl -sf https://stage.legal.org.ua/health > /dev/null && print_msg "$GREEN" "✅ Backend: healthy" || print_msg "$RED" "❌ Backend: unhealthy"
    curl -sf https://stage.legal.org.ua > /dev/null && print_msg "$GREEN" "✅ Frontend: healthy" || print_msg "$RED" "❌ Frontend: unhealthy"

    # Development (gate server)
    print_msg "$YELLOW" "\n=== Development (gate.lexapp.co.ua) ==="
    curl -sf https://dev.legal.org.ua/health > /dev/null && print_msg "$GREEN" "✅ Backend: healthy" || print_msg "$RED" "❌ Backend: unhealthy"
    curl -sf https://dev.legal.org.ua > /dev/null && print_msg "$GREEN" "✅ Frontend: healthy" || print_msg "$RED" "❌ Frontend: unhealthy"
    curl -sf https://dev.legal.org.ua:3005/health > /dev/null && print_msg "$GREEN" "✅ OpenReyestr: healthy" || print_msg "$RED" "❌ OpenReyestr: unhealthy"

    # Local
    print_msg "$YELLOW" "\n=== Local (localhost) ==="
    curl -sf http://localhost:3000/health > /dev/null && print_msg "$GREEN" "✅ Backend: healthy" || print_msg "$RED" "❌ Backend: unhealthy"
    curl -sf http://localhost:8080 > /dev/null && print_msg "$GREEN" "✅ Frontend: healthy" || print_msg "$RED" "❌ Frontend: unhealthy"

    echo ""
}

# Deploy local environment (full rebuild without cache)
deploy_local() {
    local compose_cmd=$(get_compose_cmd)
    local compose_args="-f docker-compose.local.yml"
    if [ -f ".env.local" ]; then
        compose_args="$compose_args --env-file .env.local"
    fi

    print_msg "$BLUE" "🚀 Deploying local environment (full rebuild)..."

    # Step 1: Pull latest main
    print_msg "$BLUE" "📥 Pulling latest main branch..."
    git -C .. fetch origin main && git -C .. checkout main && git -C .. pull origin main

    # Step 2: Stop existing containers
    print_msg "$BLUE" "🛑 Stopping existing containers..."
    stop_env local

    # Step 3: Cleanup exited/dead containers and dangling images
    print_msg "$BLUE" "🧹 Cleaning up stopped containers..."
    docker ps -a --filter "name=secondlayer-.*-local" --filter "status=exited" -q | xargs -r docker rm -f
    docker ps -a --filter "name=secondlayer-.*-local" --filter "status=dead" -q | xargs -r docker rm -f
    print_msg "$BLUE" "🗑️  Removing dangling images..."
    docker image prune -f

    # Step 4: Start infrastructure services only
    print_msg "$BLUE" "🚀 Starting infrastructure services..."
    $compose_cmd $compose_args up -d postgres-local redis-local qdrant-local postgres-openreyestr-local

    # Step 5: Wait for databases to be ready, then run init
    print_msg "$BLUE" "⏳ Waiting for databases..."
    sleep 15
    print_msg "$BLUE" "🔧 Running RADA DB init..."
    $compose_cmd $compose_args up rada-db-init-local

    # Step 6: Run migrations sequentially
    print_msg "$BLUE" "🔄 Running backend migrations..."
    $compose_cmd $compose_args up migrate-local
    print_msg "$BLUE" "🔄 Running RADA migrations..."
    $compose_cmd $compose_args up rada-migrate-local
    print_msg "$BLUE" "🔄 Running OpenReyestr migrations..."
    $compose_cmd $compose_args up migrate-openreyestr-local

    # Step 7: Rebuild app images without cache
    print_msg "$BLUE" "🔨 Building application images without cache..."
    $compose_cmd $compose_args build --no-cache app-local rada-mcp-app-local app-openreyestr-local document-service-local

    # Step 8: Start app services
    print_msg "$BLUE" "▶️  Starting application services..."
    $compose_cmd $compose_args up -d app-local rada-mcp-app-local app-openreyestr-local document-service-local

    # Step 9: Show status
    print_msg "$GREEN" "✅ Local deployment complete"
    $compose_cmd $compose_args ps
}

# Deploy to server (gate or mail based on environment)
deploy_to_gate() {
    local env=$1

    # Determine target server based on environment
    local target_server
    local server_name
    case $env in
        prod|production)
            target_server="${MAIL_SERVER}"
            server_name="mail server"
            local env_file=".env.prod"
            local compose_file="docker-compose.prod.yml"
            ;;
        stage|staging)
            target_server="${MAIL_SERVER}"
            server_name="mail server"
            local env_file=".env.stage"
            local compose_file="docker-compose.stage.yml"
            ;;
        dev|development)
            target_server="${GATE_SERVER}"
            server_name="gate server"
            local env_file=".env.dev"
            local compose_file="docker-compose.dev.yml"
            ;;
        local)
            deploy_local
            return
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

    print_msg "$BLUE" "🚀 Deploying $env to $server_name ($target_server)..."

    if [ ! -f "$env_file" ]; then
        print_msg "$RED" "❌ $env_file not found"
        exit 1
    fi

    # Repo root on the remote server
    local REMOTE_REPO="/home/${DEPLOY_USER}/SecondLayer"

    # Pull latest code on the server via git
    print_msg "$BLUE" "📥 Pulling latest code on $server_name..."
    ssh ${DEPLOY_USER}@${target_server} "git -C ${REMOTE_REPO} fetch origin main && git -C ${REMOTE_REPO} reset --hard origin/main"

    # Copy env file (not tracked in git)
    print_msg "$BLUE" "📤 Copying env file to $server_name..."
    scp $env_file ${DEPLOY_USER}@${target_server}:${REMOTE_REPO}/deployment/

    # Stop and remove old containers, then start new ones
    print_msg "$BLUE" "🔄 Updating containers on $server_name..."

    # Pass environment to SSH session
    ssh ${DEPLOY_USER}@${target_server} "export DEPLOY_ENV='$env' REMOTE_REPO='${REMOTE_REPO}'; bash -s" << 'EOF'
        cd "$REMOTE_REPO/deployment"

        # Determine compose file and env file based on DEPLOY_ENV
        case "$DEPLOY_ENV" in
            prod|production)
                COMPOSE_FILE="docker-compose.prod.yml"
                ENV_FILE=".env.prod"
                ENV_SHORT="prod"
                ;;
            stage|staging)
                COMPOSE_FILE="docker-compose.stage.yml"
                ENV_FILE=".env.stage"
                ENV_SHORT="stage"
                ;;
            dev|development)
                COMPOSE_FILE="docker-compose.dev.yml"
                ENV_FILE=".env.dev"
                ENV_SHORT="dev"
                ;;
        esac

        # Stop and remove containers
        echo "🛑 Stopping old containers..."
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE down

        # Remove any stopped containers for this environment
        echo "🧹 Cleaning up stopped containers..."
        docker ps -a --filter "name=secondlayer-.*-$ENV_SHORT" --filter "status=exited" -q | xargs -r docker rm -f
        docker ps -a --filter "name=secondlayer-.*-$ENV_SHORT" --filter "status=dead" -q | xargs -r docker rm -f

        # Remove old/dangling images to free space
        echo "🗑️  Removing old images..."
        docker image prune -f

        # Start infrastructure services first
        echo "🚀 Starting infrastructure services..."
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d postgres-$ENV_SHORT redis-$ENV_SHORT qdrant-$ENV_SHORT postgres-openreyestr-$ENV_SHORT
        else
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d postgres-$ENV_SHORT redis-$ENV_SHORT qdrant-$ENV_SHORT
        fi

        # Wait for database to be ready
        echo "⏳ Waiting for database..."
        sleep 15

        # Run RADA DB init
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            echo "🔧 Running RADA DB init..."
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up rada-db-init-$ENV_SHORT
        fi

        # Run migrations
        echo "🔄 Running database migrations..."
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up migrate-$ENV_SHORT

        # Run RADA and OpenReyestr migrations
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            echo "🔄 Running RADA migrations..."
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up rada-migrate-$ENV_SHORT
            echo "🔄 Running OpenReyestr migrations..."
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up migrate-openreyestr-$ENV_SHORT
        fi

        # Rebuild application services without cache
        echo "🔨 Building application images without cache..."
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE build --no-cache app-$ENV_SHORT lexwebapp-$ENV_SHORT rada-mcp-app-$ENV_SHORT app-openreyestr-$ENV_SHORT document-service-$ENV_SHORT
        else
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE build --no-cache app-$ENV_SHORT lexwebapp-$ENV_SHORT
        fi

        # Start application services
        echo "▶️  Starting application..."
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d app-$ENV_SHORT lexwebapp-$ENV_SHORT

        # Start RADA, OpenReyestr, and document-service
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            echo "▶️  Starting RADA, OpenReyestr, and document service..."
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d rada-mcp-app-$ENV_SHORT app-openreyestr-$ENV_SHORT document-service-$ENV_SHORT
        fi

        echo "✅ Deployment complete"
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE ps
EOF

    print_msg "$GREEN" "✅ $env deployed to $server_name ($target_server)"
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
