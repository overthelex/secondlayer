#!/bin/bash

# Deployment script for Development environment
# Deploys dev environment to gate server with nginx routing

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DEPLOY_USER="${DEPLOY_USER:-vovkes}"
DEPLOY_HOST="${DEPLOY_HOST:-gate}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_PATH="${DEPLOY_PATH:-~/secondlayer-deployment}"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check SSH connection
    if ! ssh -p "$DEPLOY_PORT" -o ConnectTimeout=5 "${DEPLOY_USER}@${DEPLOY_HOST}" "echo 'SSH connection successful'" > /dev/null 2>&1; then
        log_error "Cannot connect to ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PORT}"
        exit 1
    fi

    log_success "Prerequisites check passed"
}

deploy_to_server() {
    log_info "Deploying to ${DEPLOY_HOST}..."

    # Copy deployment files
    log_info "Copying deployment files..."
    ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "mkdir -p ${DEPLOY_PATH}"

    scp -P "$DEPLOY_PORT" docker-compose.dev.yml "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/"
    scp -P "$DEPLOY_PORT" docker-compose.nginx-proxy.yml "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/"
    scp -P "$DEPLOY_PORT" nginx-proxy.conf "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/"
    scp -P "$DEPLOY_PORT" nginx-legal.org.ua-updated.conf "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/"

    # Copy .env file if it exists
    if [ -f "../.env" ]; then
        scp -P "$DEPLOY_PORT" ../.env "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/"
    fi

    log_success "Files copied to server"
}

start_development_environment() {
    log_info "Starting development environment..."

    ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" bash <<'EOF'
set -e
cd ~/secondlayer-deployment

echo "🛑 Stopping existing dev containers (if any)..."
sudo docker compose -f docker-compose.dev.yml down || true

echo "▶️  Starting database and services..."
sudo docker compose -f docker-compose.dev.yml up -d postgres-dev redis-dev qdrant-dev

echo "⏳ Waiting for database to be ready..."
sleep 15

echo "🔄 Running database migrations..."
sudo docker compose -f docker-compose.dev.yml up migrate-dev

echo "▶️  Starting application containers..."
sudo docker compose -f docker-compose.dev.yml up -d app-dev lexwebapp-dev

echo "⏳ Waiting for containers to start..."
sleep 10

echo "✅ Development container status:"
sudo docker compose -f docker-compose.dev.yml ps
EOF

    log_success "Development environment started"
}

start_nginx_proxy() {
    log_info "Starting nginx proxy container..."

    ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" bash <<'EOF'
set -e
cd ~/secondlayer-deployment

echo "🛑 Stopping existing nginx proxy (if any)..."
sudo docker compose -f docker-compose.nginx-proxy.yml down || true

echo "▶️  Starting nginx proxy..."
sudo docker compose -f docker-compose.nginx-proxy.yml up -d

echo "⏳ Waiting for nginx to start..."
sleep 5

echo "✅ Nginx proxy status:"
sudo docker compose -f docker-compose.nginx-proxy.yml ps
EOF

    log_success "Nginx proxy started"
}

update_system_nginx() {
    log_info "Updating system nginx configuration..."

    ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" bash <<'EOF'
set -e
cd ~/secondlayer-deployment

echo "📝 Backing up current nginx config..."
sudo cp /etc/nginx/sites-available/legal.org.ua /etc/nginx/sites-available/legal.org.ua.backup-$(date +%Y%m%d-%H%M%S)

echo "📋 Copying new nginx config..."
sudo cp nginx-legal.org.ua-updated.conf /etc/nginx/sites-available/legal.org.ua

echo "🔍 Testing nginx configuration..."
sudo nginx -t

echo "🔄 Reloading nginx..."
sudo systemctl reload nginx

echo "✅ Nginx configuration updated"
EOF

    log_success "System nginx updated"
}

show_status() {
    log_info "Checking deployment status..."

    ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" bash <<'EOF'
echo "========================================"
echo "Development Containers:"
echo "========================================"
cd ~/secondlayer-deployment
sudo docker compose -f docker-compose.dev.yml ps

echo ""
echo "========================================"
echo "Nginx Proxy:"
echo "========================================"
sudo docker compose -f docker-compose.nginx-proxy.yml ps

echo ""
echo "========================================"
echo "System Nginx Status:"
echo "========================================"
sudo systemctl status nginx --no-pager | head -10
EOF
}

stop_development() {
    log_info "Stopping development environment..."
    ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "cd ${DEPLOY_PATH} && sudo docker compose -f docker-compose.dev.yml down"
    log_success "Development environment stopped"
}

stop_nginx_proxy() {
    log_info "Stopping nginx proxy..."
    ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "cd ${DEPLOY_PATH} && sudo docker compose -f docker-compose.nginx-proxy.yml down"
    log_success "Nginx proxy stopped"
}

show_help() {
    cat << EOF
Deployment Script for Development Environment

Usage: ./deploy-environments.sh [COMMAND]

Commands:
  deploy       Deploy complete setup (dev env + nginx proxy + system nginx)
  start-dev    Start development environment only
  start-proxy  Start nginx proxy only
  update-nginx Update system nginx configuration only
  status       Show status of all containers
  stop-dev     Stop development environment
  stop-proxy   Stop nginx proxy
  help         Show this help message

Environment Variables:
  DEPLOY_USER  SSH user (default: vovkes)
  DEPLOY_HOST  Server hostname/IP (default: gate)
  DEPLOY_PORT  SSH port (default: 22)
  DEPLOY_PATH  Deployment path on server (default: ~/secondlayer-deployment)

URLs after deployment:
  Development: https://dev.legal.org.ua/

Example:
  ./deploy-environments.sh deploy
  ./deploy-environments.sh status

EOF
}

# Main script
main() {
    local command=${1:-deploy}

    case "$command" in
        deploy)
            check_prerequisites
            deploy_to_server
            start_development_environment
            start_nginx_proxy
            update_system_nginx
            log_success "🚀 Complete deployment finished!"
            log_info "Development: https://dev.legal.org.ua/"
            show_status
            ;;
        start-dev)
            check_prerequisites
            deploy_to_server
            start_development_environment
            ;;
        start-proxy)
            check_prerequisites
            deploy_to_server
            start_nginx_proxy
            ;;
        update-nginx)
            check_prerequisites
            deploy_to_server
            update_system_nginx
            ;;
        status)
            check_prerequisites
            show_status
            ;;
        stop-dev)
            check_prerequisites
            stop_development
            ;;
        stop-proxy)
            check_prerequisites
            stop_nginx_proxy
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "Unknown command: $command"
            show_help
            exit 1
            ;;
    esac
}

# Run main function
main "$@"
