#!/bin/bash

##############################################################################
# SecondLayer Multi-Environment Management Script
# Manages Staging, Development, and Local environments
##############################################################################

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
GATE_SERVER="gate.lexapp.co.ua"  # For dev environment
MAIL_SERVER="mail.lexapp.co.ua"  # For stage environment
DEPLOY_USER="vovkes"
REMOTE_PATH="/home/vovkes/SecondLayer/deployment"

# Source orchestrator libraries
source "$SCRIPT_DIR/lib/preflight.sh"
source "$SCRIPT_DIR/lib/backup.sh"
source "$SCRIPT_DIR/lib/smoke-test.sh"
source "$SCRIPT_DIR/lib/report.sh"

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
  start <env>       Start environment (stage|dev|local|all)
  stop <env>        Stop environment (stage|dev|local|all)
  restart <env>     Restart environment (stage|dev|local|all)
  status            Show status of all environments
  logs <env>        Show logs for environment (stage|dev|local|gateway)
  deploy <env>      Deploy environment (stage|dev|local|all)
  build             Build Docker images
  gateway           Manage nginx gateway
    - start         Start nginx gateway
    - stop          Stop nginx gateway
    - restart       Restart nginx gateway
    - test          Test nginx configuration
  health            Check health of all services
  clean <env>       Clean environment data (USE WITH CAUTION!)

Environments:
  stage             Staging (stage.legal.org.ua) → mail.lexapp.co.ua
  dev               Development (dev.legal.org.ua) → gate.lexapp.co.ua
  local             Local development (localdev.legal.org.ua) → localhost
  all               All remote environments (stage+dev)

Deployment Targets:
  - Dev: Deploys to gate.lexapp.co.ua
  - Stage: Deploys to mail.lexapp.co.ua
  - Local: Full rebuild on localhost (pull, rebuild --no-cache, migrate)

Examples:
  $0 start local             # Start local development environment
  $0 start stage             # Start staging environment
  $0 start all               # Start all gateway environments (not local)
  $0 stop dev                # Stop development environment
  $0 restart stage           # Restart staging environment
  $0 logs local              # Show local environment logs
  $0 deploy stage            # Deploy staging to mail server
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

            # Start nginx for local reverse proxy (localdev.legal.org.ua)
            if command -v nginx &> /dev/null; then
                print_msg "$BLUE" "🌐 Starting nginx (localdev proxy)..."
                if sudo nginx -t 2>/dev/null; then
                    sudo systemctl start nginx 2>/dev/null || sudo nginx 2>/dev/null
                    print_msg "$GREEN" "✅ Nginx started (ports 443/80)"
                else
                    print_msg "$YELLOW" "⚠️  Nginx config test failed, skipping"
                fi
            fi

            # Start Vite dev server for frontend
            if [ -f "$REPO_ROOT/lexwebapp/package.json" ]; then
                if ! ss -tlnp 2>/dev/null | grep -q ':5173'; then
                    print_msg "$BLUE" "📦 Installing frontend dependencies..."
                    cd "$REPO_ROOT/lexwebapp"
                    npm install --prefer-offline 2>&1 | tail -3
                    print_msg "$BLUE" "⚡ Starting Vite dev server..."
                    nohup npm run dev > /tmp/vite-localdev.log 2>&1 &
                    local vite_pid=$!
                    cd "$SCRIPT_DIR"
                    # Wait up to 15s for Vite to start
                    local wait_count=0
                    while [ $wait_count -lt 15 ] && ! ss -tlnp 2>/dev/null | grep -q ':5173'; do
                        sleep 1
                        wait_count=$((wait_count + 1))
                    done
                    if ss -tlnp 2>/dev/null | grep -q ':5173'; then
                        print_msg "$GREEN" "✅ Vite started (port 5173, pid $vite_pid, log: /tmp/vite-localdev.log)"
                    else
                        print_msg "$RED" "❌ Vite failed to start. Check /tmp/vite-localdev.log"
                        tail -10 /tmp/vite-localdev.log 2>/dev/null || true
                    fi
                else
                    print_msg "$GREEN" "✅ Vite already running on port 5173"
                fi
            fi
            # Open browser
            print_msg "$BLUE" "🌐 Opening https://localdev.legal.org.ua ..."
            if command -v xdg-open &> /dev/null; then
                xdg-open "https://localdev.legal.org.ua" 2>/dev/null &
            elif command -v open &> /dev/null; then
                open "https://localdev.legal.org.ua" 2>/dev/null &
            fi
            ;;
        all)
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
        stage|staging)
            $compose_cmd -f docker-compose.stage.yml --env-file .env.stage down
            ;;
        dev|development)
            $compose_cmd -f docker-compose.dev.yml --env-file .env.dev down
            ;;
        local)
            # Stop Vite dev server
            local vite_pid
            vite_pid=$(ss -tlnp 2>/dev/null | grep ':5173' | grep -oP 'pid=\K[0-9]+' | head -1)
            if [ -n "$vite_pid" ]; then
                print_msg "$BLUE" "⚡ Stopping Vite dev server (pid $vite_pid)..."
                kill "$vite_pid" 2>/dev/null || true
                print_msg "$GREEN" "✅ Vite stopped"
            fi

            # Stop nginx
            if systemctl is-active nginx &>/dev/null; then
                print_msg "$BLUE" "🌐 Stopping nginx..."
                sudo systemctl stop nginx 2>/dev/null || true
                print_msg "$GREEN" "✅ Nginx stopped"
            fi

            if [ -f ".env.local" ]; then
                $compose_cmd -f docker-compose.local.yml --env-file .env.local down
            else
                $compose_cmd -f docker-compose.local.yml down
            fi
            ;;
        all)
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
    systemctl is-active nginx &>/dev/null && print_msg "$GREEN" "✅ Nginx: running (443/80)" || print_msg "$RED" "❌ Nginx: stopped"
    ss -tlnp 2>/dev/null | grep -q ':5173' && print_msg "$GREEN" "✅ Vite: running (5173)" || print_msg "$RED" "❌ Vite: stopped"
    curl -skf https://localdev.legal.org.ua/ > /dev/null && print_msg "$GREEN" "✅ Frontend (localdev HTTPS): healthy" || print_msg "$RED" "❌ Frontend (localdev HTTPS): unhealthy"

    echo ""
}

# Deploy local environment (full rebuild without cache)
deploy_local() {
    local compose_cmd=$(get_compose_cmd)
    local env_file=".env.local"
    local compose_file="docker-compose.local.yml"
    local compose_args="-f $compose_file"
    if [ -f "$env_file" ]; then
        compose_args="$compose_args --env-file $env_file"
    fi

    local deploy_start
    deploy_start=$(date +%s)

    print_msg "$BLUE" "🚀 Deploying local environment (full rebuild)..."

    # Phase 1: Pre-flight checks
    if ! preflight_check "local" "localhost" "$env_file" "$compose_file" "$REPO_ROOT"; then
        generate_deploy_report "local" "failure" "" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 2: Backup current state
    local backup_id
    backup_id=$(create_backup "local" "localhost" "$REPO_ROOT")

    # Phase 3: Deploy
    (
        set -e

        # Step 1: Pull latest main
        print_msg "$BLUE" "📥 Pulling latest main branch..."
        git -C "$REPO_ROOT" fetch origin main && git -C "$REPO_ROOT" checkout main && git -C "$REPO_ROOT" pull origin main

        # Step 2: Stop existing containers
        print_msg "$BLUE" "🛑 Stopping existing containers..."
        stop_env local

        # Step 3: Cleanup exited/dead containers and dangling images
        print_msg "$BLUE" "🧹 Cleaning up stopped containers..."
        docker ps -a --filter "name=secondlayer-.*-local" --filter "status=exited" -q | xargs -r docker rm -f
        docker ps -a --filter "name=secondlayer-.*-local" --filter "status=dead" -q | xargs -r docker rm -f
        print_msg "$BLUE" "🗑️  Removing dangling images..."
        docker image prune -f

        # Step 4: Rebuild ALL images without cache (migrate services build the app images)
        print_msg "$BLUE" "🔨 Building all images without cache..."
        $compose_cmd $compose_args build --no-cache migrate-local rada-migrate-local migrate-openreyestr-local document-service-local

        # Step 5: Start infrastructure services only
        print_msg "$BLUE" "🚀 Starting infrastructure services..."
        $compose_cmd $compose_args up -d postgres-local redis-local qdrant-local postgres-openreyestr-local minio-local

        # Step 6: Wait for databases to be ready, then run init
        print_msg "$BLUE" "⏳ Waiting for databases..."
        sleep 15
        print_msg "$BLUE" "🔧 Running RADA DB init..."
        $compose_cmd $compose_args up rada-db-init-local

        # Step 7: Run migrations sequentially (using freshly built images)
        print_msg "$BLUE" "🔄 Running backend migrations..."
        $compose_cmd $compose_args up migrate-local
        print_msg "$BLUE" "🔄 Running RADA migrations..."
        $compose_cmd $compose_args up rada-migrate-local
        print_msg "$BLUE" "🔄 Running OpenReyestr migrations..."
        $compose_cmd $compose_args up migrate-openreyestr-local

        # Step 8: Start app services
        print_msg "$BLUE" "▶️  Starting application services..."
        $compose_cmd $compose_args up -d app-local rada-mcp-app-local app-openreyestr-local document-service-local
    )

    if [ $? -ne 0 ]; then
        print_msg "$RED" "Deploy failed, rolling back..."
        rollback_to_backup "local" "localhost" "$compose_file" "$env_file"
        generate_deploy_report "local" "rollback" "$backup_id" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 4: Smoke tests
    if ! run_smoke_tests "local" "localhost" "$compose_file" "$env_file"; then
        print_msg "$RED" "Smoke tests failed, rolling back..."
        rollback_to_backup "local" "localhost" "$compose_file" "$env_file"
        generate_deploy_report "local" "rollback" "$backup_id" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 5: Start nginx + Vite (stopped by stop_env)
    if command -v nginx &> /dev/null; then
        print_msg "$BLUE" "🌐 Starting nginx (localdev proxy)..."
        if sudo nginx -t 2>/dev/null; then
            sudo systemctl start nginx 2>/dev/null || sudo nginx 2>/dev/null
            print_msg "$GREEN" "✅ Nginx started (ports 443/80)"
        else
            print_msg "$YELLOW" "⚠️  Nginx config test failed, skipping"
        fi
    fi

    if [ -f "$REPO_ROOT/lexwebapp/package.json" ]; then
        if ! ss -tlnp 2>/dev/null | grep -q ':5173'; then
            print_msg "$BLUE" "📦 Installing frontend dependencies..."
            cd "$REPO_ROOT/lexwebapp"
            npm install --prefer-offline 2>&1 | tail -3
            print_msg "$BLUE" "⚡ Starting Vite dev server..."
            nohup npm run dev > /tmp/vite-localdev.log 2>&1 &
            local vite_pid=$!
            cd "$SCRIPT_DIR"
            # Wait up to 15s for Vite to start
            local wait_count=0
            while [ $wait_count -lt 15 ] && ! ss -tlnp 2>/dev/null | grep -q ':5173'; do
                sleep 1
                wait_count=$((wait_count + 1))
            done
            if ss -tlnp 2>/dev/null | grep -q ':5173'; then
                print_msg "$GREEN" "✅ Vite started (port 5173, pid $vite_pid, log: /tmp/vite-localdev.log)"
            else
                print_msg "$RED" "❌ Vite failed to start. Check /tmp/vite-localdev.log"
                tail -10 /tmp/vite-localdev.log 2>/dev/null || true
            fi
        else
            print_msg "$GREEN" "✅ Vite already running on port 5173"
        fi
    fi

    # Phase 6: Open browser
    print_msg "$BLUE" "🌐 Opening https://localdev.legal.org.ua ..."
    if command -v xdg-open &> /dev/null; then
        xdg-open "https://localdev.legal.org.ua" 2>/dev/null &
    elif command -v open &> /dev/null; then
        open "https://localdev.legal.org.ua" 2>/dev/null &
    fi

    # Phase 7: Report
    generate_deploy_report "local" "success" "$backup_id" "$deploy_start" "$REPO_ROOT"
    print_msg "$GREEN" "✅ Local deployment complete"
    $compose_cmd $compose_args ps
}

# Deploy to server (gate or mail based on environment)
deploy_to_gate() {
    local env=$1

    # Determine target server based on environment
    local target_server
    local server_name
    local env_file
    local compose_file
    case $env in
        stage|staging)
            target_server="${MAIL_SERVER}"
            server_name="mail server"
            env_file=".env.stage"
            compose_file="docker-compose.stage.yml"
            ;;
        dev|development)
            target_server="${GATE_SERVER}"
            server_name="gate server"
            env_file=".env.dev"
            compose_file="docker-compose.dev.yml"
            ;;
        local)
            deploy_local
            return
            ;;
        all)
            deploy_to_gate stage
            deploy_to_gate dev
            return
            ;;
        *)
            print_msg "$RED" "❌ Invalid environment: $env"
            exit 1
            ;;
    esac

    local deploy_start
    deploy_start=$(date +%s)

    print_msg "$BLUE" "🚀 Deploying $env to $server_name ($target_server)..."

    # Phase 1: Pre-flight checks
    if ! preflight_check "$env" "$target_server" "$env_file" "$compose_file" "$REPO_ROOT"; then
        generate_deploy_report "$env" "failure" "" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 2: Backup current state
    local backup_id
    backup_id=$(create_backup "$env" "$target_server" "$REPO_ROOT")

    # Repo root on the remote server
    local REMOTE_REPO="/home/${DEPLOY_USER}/SecondLayer"

    # Phase 3: Deploy
    local deploy_failed=false

    # Pull latest code on the server via git
    print_msg "$BLUE" "📥 Pulling latest code on $server_name..."
    if ! ssh ${DEPLOY_USER}@${target_server} "git -C ${REMOTE_REPO} fetch origin main && git -C ${REMOTE_REPO} reset --hard origin/main"; then
        print_msg "$RED" "Git sync failed, rolling back..."
        rollback_to_backup "$env" "$target_server" "$compose_file" "$env_file"
        generate_deploy_report "$env" "rollback" "$backup_id" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Copy env file (not tracked in git)
    print_msg "$BLUE" "📤 Copying env file to $server_name..."
    scp $env_file ${DEPLOY_USER}@${target_server}:${REMOTE_REPO}/deployment/

    # Stop and remove old containers, then start new ones
    print_msg "$BLUE" "🔄 Updating containers on $server_name..."

    # Pass environment to SSH session
    if ! ssh ${DEPLOY_USER}@${target_server} "export DEPLOY_ENV='$env' REMOTE_REPO='${REMOTE_REPO}'; bash -s" << 'EOF'
        set -e
        cd "$REMOTE_REPO/deployment"

        # Determine compose file and env file based on DEPLOY_ENV
        case "$DEPLOY_ENV" in
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
        echo "Stopping old containers..."
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE down

        # Remove any stopped containers for this environment
        echo "Cleaning up stopped containers..."
        docker ps -a --filter "name=secondlayer-.*-$ENV_SHORT" --filter "status=exited" -q | xargs -r docker rm -f
        docker ps -a --filter "name=secondlayer-.*-$ENV_SHORT" --filter "status=dead" -q | xargs -r docker rm -f

        # Remove old/dangling images to free space
        echo "Removing old images..."
        docker image prune -f

        # Start infrastructure services first
        echo "Starting infrastructure services..."
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d postgres-$ENV_SHORT redis-$ENV_SHORT qdrant-$ENV_SHORT postgres-openreyestr-$ENV_SHORT
        else
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d postgres-$ENV_SHORT redis-$ENV_SHORT qdrant-$ENV_SHORT
        fi

        # Wait for database to be ready
        echo "Waiting for database..."
        sleep 15

        # Run RADA DB init
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            echo "Running RADA DB init..."
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up rada-db-init-$ENV_SHORT
        fi

        # Run migrations
        echo "Running database migrations..."
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up migrate-$ENV_SHORT

        # Run RADA and OpenReyestr migrations
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            echo "Running RADA migrations..."
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up rada-migrate-$ENV_SHORT
            echo "Running OpenReyestr migrations..."
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up migrate-openreyestr-$ENV_SHORT
        fi

        # Pre-build shared and backend dist (needed by document-service Dockerfile)
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            echo "Building shared package and backend dist..."
            cd "$REMOTE_REPO"
            npm --prefix packages/shared install && npm --prefix packages/shared run build
            npm --prefix mcp_backend install && npm --prefix mcp_backend run build
            cd "$REMOTE_REPO/deployment"
        fi

        # Rebuild application services without cache
        echo "Building application images without cache..."
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE build --no-cache app-$ENV_SHORT lexwebapp-$ENV_SHORT rada-mcp-app-$ENV_SHORT app-openreyestr-$ENV_SHORT document-service-$ENV_SHORT
        else
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE build --no-cache app-$ENV_SHORT lexwebapp-$ENV_SHORT
        fi

        # Start application services
        echo "Starting application..."
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d app-$ENV_SHORT lexwebapp-$ENV_SHORT

        # Start RADA, OpenReyestr, and document-service
        if [ "$ENV_SHORT" = "dev" ] || [ "$ENV_SHORT" = "stage" ]; then
            echo "Starting RADA, OpenReyestr, and document service..."
            docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d rada-mcp-app-$ENV_SHORT app-openreyestr-$ENV_SHORT document-service-$ENV_SHORT
        fi

        echo "Container deployment complete"
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE ps
EOF
    then
        deploy_failed=true
    fi

    if [ "$deploy_failed" = true ]; then
        print_msg "$RED" "Remote deploy failed, rolling back..."
        rollback_to_backup "$env" "$target_server" "$compose_file" "$env_file"
        generate_deploy_report "$env" "rollback" "$backup_id" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 4: Smoke tests
    if ! run_smoke_tests "$env" "$target_server" "$compose_file" "$env_file"; then
        print_msg "$RED" "Smoke tests failed, rolling back..."
        rollback_to_backup "$env" "$target_server" "$compose_file" "$env_file"
        generate_deploy_report "$env" "rollback" "$backup_id" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 5: Report
    generate_deploy_report "$env" "success" "$backup_id" "$deploy_start" "$REPO_ROOT"
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
