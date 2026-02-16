#!/bin/bash

##############################################################################
# SecondLayer Environment Management Script
# Manages Staging and Local environments
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
STAGE_SERVER="gate.lexapp.co.ua"  # For stage environment
DEPLOY_USER="vovkes"
REMOTE_PATH="/home/vovkes/SecondLayer/deployment"
NO_CACHE=""  # Set to "--no-cache" via --no-cache flag

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
SecondLayer Environment Manager

Usage: $0 <command> [environment] [options]

Commands:
  start <env>       Start environment (stage|local)
  stop <env>        Stop environment (stage|local)
  restart <env>     Restart environment (stage|local)
  status            Show status of all environments
  logs <env>        Show logs for environment (stage|local|gateway)
  deploy <env>      Deploy environment (stage|local) [--no-cache]
  build             Build Docker images
  gateway           Manage nginx gateway
    - start         Start nginx gateway
    - stop          Stop nginx gateway
    - restart       Restart nginx gateway
    - test          Test nginx configuration
  health            Check health of all services
  clean <env>       Clean environment data (USE WITH CAUTION!)

Environments:
  stage             Staging -> gate.lexapp.co.ua (Cloudflare proxy)
                    Domains: stage.legal.org.ua, legal.org.ua, mcp.legal.org.ua
  local             Local development (localdev.legal.org.ua) -> localhost

Deployment Targets:
  - Stage: Deploys to gate.lexapp.co.ua, serves all 3 domains via nginx + Cloudflare
  - Local: Full rebuild on localhost (pull, rebuild --no-cache, migrate)

Examples:
  $0 start local             # Start local development environment
  $0 start stage             # Start staging environment
  $0 stop stage              # Stop staging environment
  $0 restart stage           # Restart staging environment
  $0 logs local              # Show local environment logs
  $0 deploy stage            # Deploy staging (cached build)
  $0 deploy stage --no-cache # Deploy staging (full rebuild)
  $0 deploy local            # Deploy local (cached build)
  $0 deploy local --no-cache # Deploy local (full rebuild)
  $0 gateway start           # Start nginx gateway
  $0 health                  # Check health of all services
  $0 status                  # Show status of all containers

EOF
    exit 1
}

# Check if docker-compose is available
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_msg "$RED" "Docker is not installed or not in PATH"
        exit 1
    fi

    if ! command -v docker compose &> /dev/null && ! command -v docker-compose &> /dev/null; then
        print_msg "$RED" "Docker Compose is not installed or not in PATH"
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

    print_msg "$BLUE" "Starting $env environment..."

    case $env in
        stage|staging)
            if [ ! -f ".env.stage" ]; then
                print_msg "$RED" ".env.stage not found. Copy .env.stage.example and configure it."
                exit 1
            fi
            $compose_cmd -f docker-compose.stage.yml --env-file .env.stage up -d
            ;;
        local)
            ensure_local_dns

            local local_compose_args="-f docker-compose.local.yml"
            if [ -f ".env.local" ]; then
                local_compose_args="$local_compose_args --env-file .env.local"
            else
                print_msg "$YELLOW" ".env.local not found. Using defaults from docker-compose.local.yml"
                print_msg "$YELLOW" "    Copy .env.local.example to .env.local for custom configuration"
            fi

            ensure_letsencrypt_certs "$local_compose_args"
            $compose_cmd $local_compose_args up -d --build

            # Open browser (nginx + Vite run inside Docker now)
            print_msg "$BLUE" "Opening https://localdev.legal.org.ua ..."
            if command -v xdg-open &> /dev/null; then
                xdg-open "https://localdev.legal.org.ua" 2>/dev/null &
            elif command -v open &> /dev/null; then
                open "https://localdev.legal.org.ua" 2>/dev/null &
            fi
            ;;
        *)
            print_msg "$RED" "Invalid environment: $env (use stage or local)"
            usage
            ;;
    esac

    print_msg "$GREEN" "$env environment started"
}

# Stop environment
stop_env() {
    local env=$1
    local compose_cmd=$(get_compose_cmd)

    print_msg "$BLUE" "Stopping $env environment..."

    case $env in
        stage|staging)
            $compose_cmd -f docker-compose.stage.yml --env-file .env.stage down
            ;;
        local)
            # Try compose down with env file first (matches how start works)
            if [ -f ".env.local" ]; then
                $compose_cmd -f docker-compose.local.yml --env-file .env.local down 2>/dev/null || true
            fi
            # Also try without env file (catches containers started without --env-file)
            $compose_cmd -f docker-compose.local.yml down 2>/dev/null || true

            # Clean up any orphaned local containers (Created/Dead/Exited state)
            local orphaned
            orphaned=$(docker ps -a --filter "name=-local" --format '{{.ID}} {{.Names}} {{.Status}}' 2>/dev/null | grep -v "^$" || true)
            if [ -n "$orphaned" ]; then
                print_msg "$YELLOW" "Cleaning up orphaned local containers..."
                docker ps -a --filter "name=-local" -q | xargs -r docker rm -f 2>/dev/null || true
            fi

            # Kill stale docker-proxy processes holding local ports
            local stale_proxies
            stale_proxies=$(ps aux 2>/dev/null | grep '[d]ocker-proxy' | grep -E '\-container-port (5432|6379|3000|3001|3002|3004|6333|6334|9000|9001|9090|9121|3100)' | awk '{print $2}' || true)
            if [ -n "$stale_proxies" ]; then
                for pid in $stale_proxies; do
                    print_msg "$YELLOW" "Killing stale docker-proxy (PID $pid)"
                    kill "$pid" 2>/dev/null || sudo kill "$pid" 2>/dev/null || true
                done
            fi
            ;;
        *)
            print_msg "$RED" "Invalid environment: $env (use stage or local)"
            usage
            ;;
    esac

    print_msg "$GREEN" "$env environment stopped"
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
    print_msg "$BLUE" "Environment Status\n"

    print_msg "$YELLOW" "=== Staging ==="
    docker ps --filter "name=-stage" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""

    print_msg "$YELLOW" "=== Local ==="
    docker ps --filter "name=-local" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
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
            print_msg "$RED" "Invalid environment: $env (use stage, local, or gateway)"
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
            print_msg "$BLUE" "Starting nginx gateway..."
            $compose_cmd -f docker-compose.gateway.yml up -d
            print_msg "$GREEN" "Nginx gateway started"
            ;;
        stop)
            print_msg "$BLUE" "Stopping nginx gateway..."
            $compose_cmd -f docker-compose.gateway.yml down
            print_msg "$GREEN" "Nginx gateway stopped"
            ;;
        restart)
            manage_gateway stop
            sleep 2
            manage_gateway start
            ;;
        test)
            print_msg "$BLUE" "Testing nginx configuration..."
            docker exec legal-nginx-gateway nginx -t
            print_msg "$GREEN" "Nginx configuration is valid"
            ;;
        *)
            print_msg "$RED" "Invalid gateway action: $action"
            echo "Valid actions: start, stop, restart, test"
            exit 1
            ;;
    esac
}

# Build Docker images
build_images() {
    print_msg "$BLUE" "Building Docker images..."

    cd ..

    # Build backend (from root context with mono Dockerfile)
    print_msg "$BLUE" "Building backend image..."
    docker build -f deployment/Dockerfile.mono-backend -t secondlayer-app:latest .

    # Build RADA MCP (from root context with mono Dockerfile)
    print_msg "$BLUE" "Building RADA MCP image..."
    docker build -f deployment/Dockerfile.mono-rada -t rada-mcp:latest .

    # Build OpenReyestr MCP (from root context with mono Dockerfile)
    print_msg "$BLUE" "Building OpenReyestr MCP image..."
    docker build -f deployment/Dockerfile.mono-openreyestr -t openreyestr-app:latest .

    # Build frontend (Dockerfile expects context=repo root)
    print_msg "$BLUE" "Building frontend image..."
    docker build -f lexwebapp/Dockerfile -t lexwebapp-lexwebapp:latest .

    cd deployment
    print_msg "$GREEN" "Images built successfully"
}

# Check health
check_health() {
    print_msg "$BLUE" "Checking health of all services...\n"

    # Staging (gate server) — all domains
    print_msg "$YELLOW" "\n=== Staging (gate.lexapp.co.ua) ==="
    for domain in stage.legal.org.ua legal.org.ua mcp.legal.org.ua; do
        curl -sf "https://${domain}/health" > /dev/null 2>&1 && print_msg "$GREEN" "Backend ($domain): healthy" || print_msg "$RED" "Backend ($domain): unhealthy"
        curl -skf "https://${domain}/" > /dev/null 2>&1 && print_msg "$GREEN" "Frontend ($domain): healthy" || print_msg "$RED" "Frontend ($domain): unhealthy"
    done

    # Local
    print_msg "$YELLOW" "\n=== Local (localhost) ==="
    curl -sf http://localhost:3000/health > /dev/null && print_msg "$GREEN" "Backend: healthy" || print_msg "$RED" "Backend: unhealthy"
    docker ps --filter "name=nginx-local" --format '{{.Status}}' 2>/dev/null | grep -qi "up" && print_msg "$GREEN" "Nginx: running (443/80)" || print_msg "$RED" "Nginx: stopped"
    docker ps --filter "name=lexwebapp-local" --format '{{.Status}}' 2>/dev/null | grep -qi "up" && print_msg "$GREEN" "Vite: running (Docker)" || print_msg "$RED" "Vite: stopped"
    curl -sf https://localdev.legal.org.ua/ > /dev/null && print_msg "$GREEN" "Frontend (localdev HTTPS): healthy" || print_msg "$RED" "Frontend (localdev HTTPS): unhealthy"
    curl -sf https://localdev.mcp.legal.org.ua/health > /dev/null && print_msg "$GREEN" "MCP SSE (localdev.mcp HTTPS): healthy" || print_msg "$RED" "MCP SSE (localdev.mcp HTTPS): unhealthy"

    echo ""
}

# Ensure /etc/hosts has entries for localdev domains
ensure_local_dns() {
    local domains=("localdev.legal.org.ua" "localdev.mcp.legal.org.ua")
    local resolved_ip
    resolved_ip=$(dig +short localdev.legal.org.ua @8.8.8.8 2>/dev/null | head -1)

    if [ -z "$resolved_ip" ]; then
        print_msg "$YELLOW" "Could not resolve localdev.legal.org.ua via Google DNS"
        return 0
    fi

    for domain in "${domains[@]}"; do
        if ! grep -q "$domain" /etc/hosts 2>/dev/null; then
            print_msg "$BLUE" "Adding $domain -> $resolved_ip to /etc/hosts"
            echo "$resolved_ip $domain" | sudo tee -a /etc/hosts > /dev/null
        fi
    done
}

# Manage Let's Encrypt certificates for local environment
ensure_letsencrypt_certs() {
    local certs_dir="$SCRIPT_DIR/nginx/certs"
    local le_dir="/etc/letsencrypt/live/localdev.legal.org.ua"
    local domains="-d localdev.legal.org.ua -d localdev.mcp.legal.org.ua"
    local compose_cmd=$(get_compose_cmd)
    local compose_args="$1"

    # Check if LE cert exists and is still valid (>7 days)
    if sudo test -f "$le_dir/fullchain.pem" && \
       sudo openssl x509 -in "$le_dir/fullchain.pem" -noout -checkend 604800 2>/dev/null; then
        print_msg "$GREEN" "Let's Encrypt certificate is valid"
        # Ensure latest certs are copied
        sudo cp "$le_dir/fullchain.pem" "$certs_dir/fullchain.pem"
        sudo cp "$le_dir/privkey.pem" "$certs_dir/privkey.pem"
        sudo chown $(id -u):$(id -g) "$certs_dir/fullchain.pem" "$certs_dir/privkey.pem"
        return 0
    fi

    print_msg "$BLUE" "Obtaining/renewing Let's Encrypt certificate..."

    # Ensure certbot is installed
    if ! command -v certbot &> /dev/null; then
        print_msg "$BLUE" "Installing certbot..."
        sudo apt-get install -y certbot > /dev/null 2>&1
    fi

    # Stop nginx if running (to free port 80 for standalone mode)
    $compose_cmd $compose_args stop nginx-local 2>/dev/null || true

    # Obtain/renew certificate
    if sudo certbot certonly --standalone $domains \
        --non-interactive --agree-tos --email admin@legal.org.ua 2>&1; then
        print_msg "$GREEN" "Certificate obtained successfully"
        sudo cp "$le_dir/fullchain.pem" "$certs_dir/fullchain.pem"
        sudo cp "$le_dir/privkey.pem" "$certs_dir/privkey.pem"
        sudo chown $(id -u):$(id -g) "$certs_dir/fullchain.pem" "$certs_dir/privkey.pem"
    else
        print_msg "$YELLOW" "Let's Encrypt failed -- falling back to existing certs"
    fi
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

    print_msg "$BLUE" "Deploying local environment (full rebuild)..."

    # Phase 0: Ensure DNS and TLS
    ensure_local_dns
    ensure_letsencrypt_certs "$compose_args"

    # Phase 1: Pre-flight checks
    if ! preflight_check "local" "localhost" "$env_file" "$compose_file" "$REPO_ROOT"; then
        generate_deploy_report "local" "failure" "" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 2: Backup current state
    local backup_id
    backup_id=$(create_backup "local" "localhost" "$REPO_ROOT")

    # Phase 3: Deploy
    local deploy_exit=0
    (
        set -e

        # Step 1: Pull latest main
        print_msg "$BLUE" "Pulling latest main branch..."
        git -C "$REPO_ROOT" fetch origin main && git -C "$REPO_ROOT" checkout main && git -C "$REPO_ROOT" pull origin main

        # Step 2: Stop app containers only (keep infrastructure: postgres, redis, qdrant, minio)
        print_msg "$BLUE" "Stopping app containers (keeping databases running)..."
        $compose_cmd $compose_args stop \
            app-local rada-mcp-app-local app-openreyestr-local \
            document-service-local nginx-local lexwebapp-local lexwebapp-deps-local \
            2>/dev/null || true
        $compose_cmd $compose_args rm -f \
            app-local rada-mcp-app-local app-openreyestr-local \
            document-service-local nginx-local lexwebapp-local lexwebapp-deps-local \
            migrate-local rada-migrate-local migrate-openreyestr-local \
            rada-db-init-local \
            2>/dev/null || true

        # Step 3: Cleanup exited/dead containers and dangling images
        print_msg "$BLUE" "Cleaning up stopped containers..."
        docker ps -a --filter "name=-local" --filter "status=exited" -q | xargs -r docker rm -f
        docker ps -a --filter "name=-local" --filter "status=dead" -q | xargs -r docker rm -f
        print_msg "$BLUE" "Removing dangling images..."
        docker image prune -f

        # Step 4: Rebuild images (use --no-cache flag for full rebuild)
        if [ -n "$NO_CACHE" ]; then
            print_msg "$BLUE" "Building all images without cache..."
        else
            print_msg "$BLUE" "Building all images (cached)..."
        fi
        $compose_cmd $compose_args build $NO_CACHE migrate-local rada-migrate-local migrate-openreyestr-local document-service-local

        # Step 5: Ensure infrastructure services are running
        print_msg "$BLUE" "Ensuring infrastructure services are running..."
        $compose_cmd $compose_args up -d postgres-local redis-local qdrant-local postgres-openreyestr-local minio-local

        # Step 6: Wait for databases to be healthy, then run init
        print_msg "$BLUE" "Waiting for databases..."
        sleep 5
        print_msg "$BLUE" "Running RADA DB init..."
        $compose_cmd $compose_args up rada-db-init-local

        # Step 7: Run migrations (backend first, then rada + openreyestr in parallel)
        print_msg "$BLUE" "Running backend migrations..."
        $compose_cmd $compose_args up migrate-local
        print_msg "$BLUE" "Running RADA + OpenReyestr migrations in parallel..."
        $compose_cmd $compose_args up rada-migrate-local migrate-openreyestr-local

        # Step 7b: Seed admin user
        print_msg "$BLUE" "Seeding admin user..."
        $compose_cmd $compose_args up seed-admin-local

        # Step 8: Start frontend deps + app services (including nginx + frontend in Docker)
        print_msg "$BLUE" "Installing frontend dependencies..."
        $compose_cmd $compose_args up lexwebapp-deps-local
        print_msg "$BLUE" "Starting application services..."
        $compose_cmd $compose_args up -d app-local rada-mcp-app-local app-openreyestr-local document-service-local lexwebapp-local nginx-local

        # Step 9: Start monitoring services
        print_msg "$BLUE" "Starting monitoring services..."
        $compose_cmd $compose_args up -d \
            prometheus-local \
            grafana-local \
            redis-exporter-local \
            2>/dev/null || echo "  (some monitoring services may not exist)"
    ) || deploy_exit=$?

    if [ $deploy_exit -ne 0 ]; then
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

    # Phase 5: Open browser (nginx + Vite run inside Docker now)
    print_msg "$BLUE" "Opening https://localdev.legal.org.ua ..."
    if command -v xdg-open &> /dev/null; then
        xdg-open "https://localdev.legal.org.ua" 2>/dev/null &
    elif command -v open &> /dev/null; then
        open "https://localdev.legal.org.ua" 2>/dev/null &
    fi

    # Phase 6: Report
    generate_deploy_report "local" "success" "$backup_id" "$deploy_start" "$REPO_ROOT"
    print_msg "$GREEN" "Local deployment complete"
    $compose_cmd $compose_args ps
}

# Deploy to stage server (gate.lexapp.co.ua)
deploy_to_server() {
    local env=$1

    case $env in
        stage|staging)
            ;;
        local)
            deploy_local
            return
            ;;
        *)
            print_msg "$RED" "Invalid environment: $env (use stage or local)"
            exit 1
            ;;
    esac

    local target_server="${STAGE_SERVER}"
    local server_name="gate server"
    local env_file=".env.stage"
    local compose_file="docker-compose.stage.yml"

    local deploy_start
    deploy_start=$(date +%s)

    print_msg "$BLUE" "Deploying stage to $server_name ($target_server)..."

    # Phase 1: Pre-flight checks
    if ! preflight_check "stage" "$target_server" "$env_file" "$compose_file" "$REPO_ROOT"; then
        generate_deploy_report "stage" "failure" "" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 2: Backup current state
    local backup_id
    backup_id=$(create_backup "stage" "$target_server" "$REPO_ROOT")

    # Repo root on the remote server
    local REMOTE_REPO="/home/${DEPLOY_USER}/SecondLayer"

    # Phase 3: Deploy
    local deploy_failed=false

    # Step 1: Pull latest code on the server via git
    print_msg "$BLUE" "Pulling latest code on $server_name..."
    if ! ssh ${DEPLOY_USER}@${target_server} "git -C ${REMOTE_REPO} fetch origin main && git -C ${REMOTE_REPO} reset --hard origin/main"; then
        print_msg "$RED" "Git sync failed, rolling back..."
        rollback_to_backup "stage" "$target_server" "$compose_file" "$env_file"
        generate_deploy_report "stage" "rollback" "$backup_id" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Step 2: Copy env file (not tracked in git)
    print_msg "$BLUE" "Copying env file to $server_name..."
    scp $env_file ${DEPLOY_USER}@${target_server}:${REMOTE_REPO}/deployment/

    # Step 3: Build, migrate, and start services
    print_msg "$BLUE" "Updating containers on $server_name..."

    if ! ssh ${DEPLOY_USER}@${target_server} "export REMOTE_REPO='${REMOTE_REPO}'; export NO_CACHE='${NO_CACHE}'; bash -s" << 'EOF'
        set -e
        cd "$REMOTE_REPO/deployment"

        COMPOSE_FILE="docker-compose.stage.yml"
        ENV_FILE=".env.stage"
        DC="docker compose -f $COMPOSE_FILE --env-file $ENV_FILE"

        # Step 1: Stop app containers only (keep infra: postgres, redis, qdrant, minio running)
        echo "Stopping app containers (keeping databases running)..."
        $DC stop \
            nginx-stage \
            app-stage rada-mcp-app-stage app-openreyestr-stage \
            document-service-stage lexwebapp-stage \
            prometheus-stage grafana-stage \
            postgres-exporter-backend postgres-exporter-openreyestr \
            redis-exporter node-exporter \
            2>/dev/null || true
        $DC rm -f \
            nginx-stage \
            app-stage rada-mcp-app-stage app-openreyestr-stage \
            document-service-stage lexwebapp-stage \
            migrate-stage rada-migrate-stage migrate-openreyestr-stage \
            rada-db-init-stage \
            prometheus-stage grafana-stage \
            postgres-exporter-backend postgres-exporter-openreyestr \
            redis-exporter node-exporter \
            2>/dev/null || true

        # Step 2: Cleanup exited/dead containers and dangling images
        echo "Cleaning up stopped containers..."
        docker ps -a --filter "name=-stage" --filter "status=exited" -q | xargs -r docker rm -f
        docker ps -a --filter "name=-stage" --filter "status=dead" -q | xargs -r docker rm -f
        echo "Removing dangling images..."
        docker image prune -f

        # Step 3: Pre-build shared + all service dists
        echo "Building shared package and all service dists..."
        cd "$REMOTE_REPO"
        npm --prefix packages/shared install && npm --prefix packages/shared run build
        npm --prefix mcp_backend install && npm --prefix mcp_backend run build
        npm --prefix mcp_rada install && npm --prefix mcp_rada run build
        npm --prefix mcp_openreyestr install && npm --prefix mcp_openreyestr run build
        cd "$REMOTE_REPO/deployment"

        # Step 4: Build images (use --no-cache flag for full rebuild)
        if [ -n "$NO_CACHE" ]; then
            echo "Building all images without cache..."
        else
            echo "Building all images (cached)..."
        fi
        $DC build $NO_CACHE \
            app-stage \
            rada-migrate-stage \
            migrate-openreyestr-stage \
            document-service-stage \
            lexwebapp-stage

        # Step 5: Ensure infrastructure services are running
        echo "Ensuring infrastructure services are running..."
        INFRA_FLAGS=""
        if [ -n "$NO_CACHE" ]; then
            INFRA_FLAGS="--force-recreate"
        fi
        $DC up -d $INFRA_FLAGS \
            postgres-stage \
            redis-stage \
            qdrant-stage \
            postgres-openreyestr-stage \
            minio-stage

        # Step 6: Wait for databases to be healthy, then run RADA DB init
        echo "Waiting for databases..."
        sleep 5
        echo "Running RADA DB init..."
        $DC up rada-db-init-stage

        # Step 7: Run migrations (backend first, then rada + openreyestr in parallel)
        echo "Running backend migrations..."
        $DC up migrate-stage
        echo "Running RADA + OpenReyestr migrations in parallel..."
        $DC up rada-migrate-stage migrate-openreyestr-stage

        # Step 7b: Seed admin user
        echo "Seeding admin user..."
        $DC up seed-admin-stage

        # Step 8: Start application services
        echo "Starting application services..."
        $DC up -d \
            app-stage \
            rada-mcp-app-stage \
            app-openreyestr-stage \
            document-service-stage \
            lexwebapp-stage

        # Step 8b: Start nginx reverse proxy (after app services are up)
        echo "Starting nginx reverse proxy..."
        $DC up -d nginx-stage

        # Step 9: Start monitoring services
        echo "Starting monitoring services..."
        $DC up -d \
            prometheus-stage \
            grafana-stage \
            postgres-exporter-backend \
            postgres-exporter-openreyestr \
            redis-exporter \
            node-exporter \
            2>/dev/null || echo "  (some monitoring services may not exist in this environment)"

        # Step 10: Verify all domains respond
        echo "Verifying domain health..."
        for domain in stage.legal.org.ua legal.org.ua mcp.legal.org.ua; do
            if curl -skf --max-time 10 "https://${domain}/health" > /dev/null 2>&1; then
                echo "  [OK] ${domain}"
            else
                echo "  [WARN] ${domain} not responding (may need DNS propagation)"
            fi
        done

        echo "Container deployment complete"
        $DC ps
EOF
    then
        deploy_failed=true
    fi

    if [ "$deploy_failed" = true ]; then
        print_msg "$RED" "Remote deploy failed, rolling back..."
        rollback_to_backup "stage" "$target_server" "$compose_file" "$env_file"
        generate_deploy_report "stage" "rollback" "$backup_id" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 4: Smoke tests
    if ! run_smoke_tests "stage" "$target_server" "$compose_file" "$env_file"; then
        print_msg "$RED" "Smoke tests failed, rolling back..."
        rollback_to_backup "stage" "$target_server" "$compose_file" "$env_file"
        generate_deploy_report "stage" "rollback" "$backup_id" "$deploy_start" "$REPO_ROOT"
        exit 1
    fi

    # Phase 5: Report
    generate_deploy_report "stage" "success" "$backup_id" "$deploy_start" "$REPO_ROOT"
    print_msg "$GREEN" "Stage deployed to $server_name ($target_server)"
}

# Clean environment data
clean_env() {
    local env=$1
    local compose_cmd=$(get_compose_cmd)

    print_msg "$RED" "WARNING: This will delete all data for $env environment!"
    read -p "Are you sure? Type 'yes' to confirm: " confirm

    if [ "$confirm" != "yes" ]; then
        print_msg "$YELLOW" "Aborted"
        exit 0
    fi

    case $env in
        stage|staging)
            $compose_cmd -f docker-compose.stage.yml --env-file .env.stage down -v
            ;;
        *)
            print_msg "$RED" "Invalid environment: $env (use stage)"
            exit 1
            ;;
    esac

    print_msg "$GREEN" "$env environment cleaned"
}

# Main script
check_docker

if [ $# -eq 0 ]; then
    usage
fi

COMMAND=$1
shift

# Parse global flags
for arg in "$@"; do
    case $arg in
        --no-cache)
            NO_CACHE="--no-cache"
            ;;
    esac
done

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
        deploy_to_server "$1"
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
        print_msg "$RED" "Unknown command: $COMMAND"
        usage
        ;;
esac
