#!/bin/bash

# SecondLayer EULA Update - Deploy to Dev Environment
# Deploys to dev.legal.org.ua

set -e  # Exit on error

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Dev Environment Configuration
SERVER_HOST="gate"
DEPLOY_PATH="/home/vovkes/secondlayer-deployment"
DOCKER_COMPOSE_FILE="docker-compose.dev.yml"
BACKEND_CONTAINER="secondlayer-app-dev"
FRONTEND_CONTAINER="lexwebapp-dev"
DB_CONTAINER="secondlayer-postgres-dev"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

log_dev() {
    echo -e "${CYAN}[DEV]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_step "Checking prerequisites..."

    # Check SSH connection
    if ! ssh "${SERVER_HOST}" "echo 'SSH OK'" &> /dev/null; then
        log_error "Cannot connect to ${SERVER_HOST}"
        exit 1
    fi

    # Check EULA file exists
    if [ ! -f "${PROJECT_ROOT}/EULA_manual_license.txt" ]; then
        log_error "EULA_manual_license.txt not found"
        exit 1
    fi

    log_info "Prerequisites check passed ✓"
}

# Build backend locally
build_backend() {
    log_step "Building backend..."

    cd "${PROJECT_ROOT}/mcp_backend"

    log_info "Installing dependencies..."
    npm install

    log_info "Building TypeScript..."
    npm run build

    log_info "Backend build completed ✓"
}

# Build frontend locally
build_frontend() {
    log_step "Building frontend..."

    cd "${PROJECT_ROOT}/frontend"

    log_info "Installing dependencies (including react-markdown)..."
    npm install

    log_info "Building for development..."
    npm run build -- --mode development

    log_info "Frontend build completed ✓"
}

# Deploy backend to dev
deploy_backend_to_dev() {
    log_step "Deploying backend to dev..."

    # Create package
    log_info "Creating backend package..."
    cd "${PROJECT_ROOT}/mcp_backend"

    TEMP_DIR=$(mktemp -d)
    PACKAGE_DIR="${TEMP_DIR}/backend-update"
    mkdir -p "${PACKAGE_DIR}"

    # Copy built files
    cp -r dist "${PACKAGE_DIR}/"
    cp package.json package-lock.json "${PACKAGE_DIR}/"

    # Copy migrations
    mkdir -p "${PACKAGE_DIR}/src/migrations"
    cp src/migrations/*.sql "${PACKAGE_DIR}/src/migrations/"

    # Copy EULA file
    cp "${PROJECT_ROOT}/EULA_manual_license.txt" "${PACKAGE_DIR}/"

    # Create tarball
    tar -czf "${TEMP_DIR}/backend-update.tar.gz" -C "${TEMP_DIR}" "backend-update"

    # Upload to server
    log_info "Uploading to dev server..."
    scp "${TEMP_DIR}/backend-update.tar.gz" "${SERVER_HOST}:${DEPLOY_PATH}/"

    # Deploy on server
    log_info "Deploying on server..."
    ssh "${SERVER_HOST}" << ENDSSH
set -e
cd ${DEPLOY_PATH}

# Extract package
tar -xzf backend-update.tar.gz
cd backend-update

# Backup current backend
if [ -d "../backend-backup" ]; then
    rm -rf ../backend-backup
fi
docker exec ${BACKEND_CONTAINER} sh -c 'tar -czf /tmp/backend-backup.tar.gz -C /app .' 2>/dev/null || true

# Copy files into running container
echo "Copying files to container..."
docker cp dist/. ${BACKEND_CONTAINER}:/app/dist/
docker cp src/migrations/. ${BACKEND_CONTAINER}:/app/src/migrations/
docker cp EULA_manual_license.txt ${BACKEND_CONTAINER}:/app/
docker cp package.json ${BACKEND_CONTAINER}:/app/

# Install new dependencies in container
echo "Installing dependencies in container..."
docker exec ${BACKEND_CONTAINER} npm install --production

# Run migrations
echo "Running migrations..."
docker exec ${BACKEND_CONTAINER} sh -c 'cd /app && node dist/database/run-migrations.js' || \
docker exec ${BACKEND_CONTAINER} sh -c 'cd /app && npm run migrate' || \
echo "Warning: Migration might have failed, check logs"

# Restart container
echo "Restarting backend container..."
docker compose -f ${DOCKER_COMPOSE_FILE} restart app-dev

# Wait for container to be healthy
echo "Waiting for container to start..."
sleep 5

# Check health
if docker exec ${BACKEND_CONTAINER} curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "✓ Backend health check passed"
else
    echo "✗ Backend health check failed"
    exit 1
fi

# Cleanup
cd ${DEPLOY_PATH}
rm -rf backend-update backend-update.tar.gz

echo "Backend deployment completed!"
ENDSSH

    # Cleanup local temp
    rm -rf "${TEMP_DIR}"

    log_info "Backend deployment completed ✓"
}

# Deploy frontend to dev
deploy_frontend_to_dev() {
    log_step "Deploying frontend to dev..."

    cd "${PROJECT_ROOT}/frontend"

    # Create package
    log_info "Creating frontend package..."
    TEMP_DIR=$(mktemp -d)
    tar -czf "${TEMP_DIR}/frontend-update.tar.gz" -C dist .

    # Upload to server
    log_info "Uploading to dev server..."
    scp "${TEMP_DIR}/frontend-update.tar.gz" "${SERVER_HOST}:${DEPLOY_PATH}/"

    # Deploy on server
    log_info "Deploying on server..."
    ssh "${SERVER_HOST}" << ENDSSH
set -e
cd ${DEPLOY_PATH}

# Extract package
mkdir -p frontend-update
tar -xzf frontend-update.tar.gz -C frontend-update

# Backup current frontend
if [ -d "frontend-backup" ]; then
    rm -rf frontend-backup
fi
docker exec ${FRONTEND_CONTAINER} sh -c 'tar -czf /tmp/frontend-backup.tar.gz -C /usr/share/nginx/html .' 2>/dev/null || true

# Copy files into running container
echo "Copying files to container..."
docker cp frontend-update/. ${FRONTEND_CONTAINER}:/usr/share/nginx/html/

# Restart nginx in container
echo "Restarting nginx..."
docker exec ${FRONTEND_CONTAINER} nginx -s reload 2>/dev/null || \
docker compose -f ${DOCKER_COMPOSE_FILE} restart lexwebapp-dev

# Cleanup
cd ${DEPLOY_PATH}
rm -rf frontend-update frontend-update.tar.gz

echo "Frontend deployment completed!"
ENDSSH

    # Cleanup local temp
    rm -rf "${TEMP_DIR}"

    log_info "Frontend deployment completed ✓"
}

# Test deployment
test_deployment() {
    log_step "Testing deployment..."

    log_info "Testing backend health..."
    if curl -sf https://dev.legal.org.ua/health | grep -q "ok"; then
        log_info "✓ Backend health check passed"
    else
        log_error "✗ Backend health check failed"
    fi

    log_info "Testing EULA endpoint..."
    if curl -sf https://dev.legal.org.ua/api/eula | grep -q "version"; then
        log_info "✓ EULA endpoint working"
    else
        log_warn "✗ EULA endpoint check failed"
    fi

    log_info "Testing EULA documents endpoint..."
    if curl -sf https://dev.legal.org.ua/api/eula/documents | grep -q "eula"; then
        log_info "✓ EULA documents endpoint working"
    else
        log_warn "✗ EULA documents endpoint check failed"
    fi

    log_info "Testing frontend..."
    if curl -sf https://dev.legal.org.ua/ | grep -q "Legal.org.ua"; then
        log_info "✓ Frontend loading"
    else
        log_warn "✗ Frontend check failed"
    fi
}

# Show dev environment info
show_dev_info() {
    log_dev "Checking dev environment status..."

    ssh "${SERVER_HOST}" << 'ENDSSH'
echo ""
echo "=== Dev Environment Status ==="
echo ""
echo "Containers:"
docker ps --filter "name=dev" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "Backend logs (last 20 lines):"
docker logs --tail 20 secondlayer-app-dev 2>&1 | tail -20
echo ""
ENDSSH
}

# Main deployment
main() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║     SecondLayer EULA - Deploy to Dev Environment          ║"
    echo "║              https://dev.legal.org.ua                      ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""

    log_dev "Target: dev.legal.org.ua (gate server)"
    log_dev "Backend: ${BACKEND_CONTAINER}"
    log_dev "Frontend: ${FRONTEND_CONTAINER}"
    echo ""

    # Check prerequisites
    check_prerequisites

    # Show current status
    if [[ "${1}" != "--skip-status" ]]; then
        show_dev_info
    fi

    echo ""
    read -p "$(echo -e ${YELLOW}Continue with deployment?${NC}) [y/N]: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warn "Deployment cancelled"
        exit 0
    fi

    echo ""

    # Build locally
    build_backend
    echo ""
    build_frontend
    echo ""

    # Deploy backend
    read -p "$(echo -e ${YELLOW}Deploy backend?${NC}) [y/N]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        deploy_backend_to_dev
    else
        log_warn "Skipping backend deployment"
    fi

    echo ""

    # Deploy frontend
    read -p "$(echo -e ${YELLOW}Deploy frontend?${NC}) [y/N]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        deploy_frontend_to_dev
    else
        log_warn "Skipping frontend deployment"
    fi

    echo ""

    # Test deployment
    if command -v curl &> /dev/null; then
        test_deployment
    else
        log_warn "curl not available, skipping tests"
    fi

    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║            Deployment to Dev Completed! ✓                  ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    log_dev "Access dev environment at: https://dev.legal.org.ua"
    log_dev "Login and check EULA modal appears"
    log_dev "Navigate to Help & Documentation menu"
    echo ""
    log_info "View backend logs: ssh gate 'docker logs -f ${BACKEND_CONTAINER}'"
    log_info "View dev status: ssh gate 'docker ps --filter name=dev'"
    echo ""
}

# Run main
main "$@"
