#!/bin/bash

# SecondLayer EULA Update - Full Deployment Script
# Deploys backend and frontend with EULA functionality

set -e  # Exit on error

# Configuration
SERVER_USER="${DEPLOY_USER:-ubuntu}"
SERVER_HOST="${DEPLOY_HOST:-gate-server}"
SERVER_PORT="${DEPLOY_PORT:-22}"
BACKEND_DEPLOY_PATH="${BACKEND_DEPLOY_PATH:-~/secondlayer}"
FRONTEND_DEPLOY_PATH="${FRONTEND_DEPLOY_PATH:-/var/www/secondlayer}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
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

# Confirmation prompt
confirm() {
    local message=$1
    read -p "$(echo -e ${YELLOW}${message}${NC}) [y/N]: " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]]
}

# Check prerequisites
check_prerequisites() {
    log_step "Checking prerequisites..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        exit 1
    fi

    # Check npm
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed"
        exit 1
    fi

    # Check SSH
    if ! command -v ssh &> /dev/null; then
        log_error "SSH is not installed"
        exit 1
    fi

    # Check backend files
    if [ ! -f "${PROJECT_ROOT}/mcp_backend/package.json" ]; then
        log_error "Backend package.json not found"
        exit 1
    fi

    # Check frontend files
    if [ ! -f "${PROJECT_ROOT}/frontend/package.json" ]; then
        log_error "Frontend package.json not found"
        exit 1
    fi

    # Check EULA file
    if [ ! -f "${PROJECT_ROOT}/EULA_manual_license.txt" ]; then
        log_error "EULA_manual_license.txt not found in project root"
        exit 1
    fi

    log_info "Prerequisites check passed ✓"
}

# Test server connection
test_connection() {
    log_step "Testing server connection..."

    if ! ssh -p "${SERVER_PORT}" -o ConnectTimeout=5 "${SERVER_USER}@${SERVER_HOST}" "echo 'Connection successful'" &> /dev/null; then
        log_error "Cannot connect to ${SERVER_USER}@${SERVER_HOST}:${SERVER_PORT}"
        log_warn "Please check:"
        echo "  1. Server is reachable"
        echo "  2. SSH credentials are correct"
        echo "  3. SSH key is loaded (ssh-add)"
        exit 1
    fi

    log_info "Server connection successful ✓"
}

# Deploy backend
deploy_backend() {
    log_step "Deploying backend..."

    cd "${PROJECT_ROOT}/mcp_backend"

    # Install dependencies
    log_info "Installing backend dependencies..."
    npm install

    # Build TypeScript
    log_info "Building backend TypeScript..."
    npm run build

    # Create deployment package
    log_info "Creating deployment package..."
    TEMP_DIR=$(mktemp -d)
    PACKAGE_DIR="${TEMP_DIR}/secondlayer"
    mkdir -p "${PACKAGE_DIR}"

    # Copy files
    cp -r dist "${PACKAGE_DIR}/"
    cp package.json "${PACKAGE_DIR}/"
    cp package-lock.json "${PACKAGE_DIR}/" 2>/dev/null || true

    # Copy migration files
    mkdir -p "${PACKAGE_DIR}/src/migrations"
    cp -r src/migrations/*.sql "${PACKAGE_DIR}/src/migrations/" 2>/dev/null || true

    # Copy Docker files if they exist
    cp docker-compose.prod.yml "${PACKAGE_DIR}/docker-compose.yml" 2>/dev/null || true
    cp Dockerfile "${PACKAGE_DIR}/" 2>/dev/null || true

    # Copy environment file if it exists
    if [ -f ".env.production" ]; then
        cp .env.production "${PACKAGE_DIR}/.env"
    elif [ -f ".env" ]; then
        log_warn "Using .env file (no .env.production found)"
        cp .env "${PACKAGE_DIR}/"
    fi

    # Copy EULA file
    cp "${PROJECT_ROOT}/EULA_manual_license.txt" "${PACKAGE_DIR}/"

    # Create tarball
    tar -czf "${TEMP_DIR}/secondlayer-backend.tar.gz" -C "${TEMP_DIR}" "secondlayer"

    # Upload to server
    log_info "Uploading to server..."
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" "mkdir -p ${BACKEND_DEPLOY_PATH}"
    scp -P "${SERVER_PORT}" "${TEMP_DIR}/secondlayer-backend.tar.gz" "${SERVER_USER}@${SERVER_HOST}:${BACKEND_DEPLOY_PATH}/"

    # Extract and setup on server
    log_info "Setting up on server..."
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" << ENDSSH
cd ${BACKEND_DEPLOY_PATH}
tar -xzf secondlayer-backend.tar.gz
cd secondlayer

# Install production dependencies
npm install --production

# Run migrations
echo "Running database migrations..."
if [ -f "dist/database/run-migrations.js" ]; then
    node dist/database/run-migrations.js
elif command -v npm &> /dev/null && grep -q "migrate" package.json; then
    npm run migrate
else
    echo "Warning: Migration script not found. Please run migrations manually."
fi

# Restart service (try multiple methods)
if command -v pm2 &> /dev/null; then
    echo "Restarting with PM2..."
    pm2 restart secondlayer-http || pm2 start dist/http-server.js --name secondlayer-http
elif command -v docker-compose &> /dev/null; then
    echo "Restarting with Docker Compose..."
    docker-compose restart app || docker-compose up -d
elif command -v systemctl &> /dev/null; then
    echo "Restarting with systemd..."
    sudo systemctl restart secondlayer || echo "Warning: systemctl restart failed"
else
    echo "Warning: No process manager found. Please restart the service manually."
fi

echo "Backend deployment completed!"
ENDSSH

    # Cleanup
    rm -rf "${TEMP_DIR}"

    log_info "Backend deployment completed ✓"
}

# Deploy frontend
deploy_frontend() {
    log_step "Deploying frontend..."

    cd "${PROJECT_ROOT}/frontend"

    # Install dependencies (including react-markdown)
    log_info "Installing frontend dependencies..."
    npm install

    # Build for production
    log_info "Building frontend for production..."
    npm run build

    # Create deployment package
    log_info "Creating frontend package..."
    TEMP_DIR=$(mktemp -d)
    tar -czf "${TEMP_DIR}/secondlayer-frontend.tar.gz" -C dist .

    # Upload to server
    log_info "Uploading frontend to server..."
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" "sudo mkdir -p ${FRONTEND_DEPLOY_PATH}"
    scp -P "${SERVER_PORT}" "${TEMP_DIR}/secondlayer-frontend.tar.gz" "${SERVER_USER}@${SERVER_HOST}:/tmp/"

    # Extract on server
    log_info "Extracting frontend on server..."
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" << ENDSSH
cd /tmp
sudo tar -xzf secondlayer-frontend.tar.gz -C ${FRONTEND_DEPLOY_PATH}
sudo chown -R www-data:www-data ${FRONTEND_DEPLOY_PATH} 2>/dev/null || true
rm secondlayer-frontend.tar.gz

# Reload nginx if available
if command -v nginx &> /dev/null; then
    echo "Reloading nginx..."
    sudo nginx -t && sudo systemctl reload nginx
fi

echo "Frontend deployment completed!"
ENDSSH

    # Cleanup
    rm -rf "${TEMP_DIR}"

    log_info "Frontend deployment completed ✓"
}

# Run deployment tests
run_tests() {
    log_step "Running post-deployment tests..."

    # Test backend health
    log_info "Testing backend health endpoint..."
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" << 'ENDSSH'
if command -v curl &> /dev/null; then
    RESPONSE=$(curl -s http://localhost:3000/health || echo "failed")
    if [[ $RESPONSE == *"ok"* ]]; then
        echo "✓ Backend health check passed"
    else
        echo "✗ Backend health check failed: $RESPONSE"
    fi
else
    echo "⚠ curl not available, skipping health check"
fi
ENDSSH

    # Test EULA endpoint
    log_info "Testing EULA endpoint..."
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" << 'ENDSSH'
if command -v curl &> /dev/null; then
    RESPONSE=$(curl -s http://localhost:3000/api/eula || echo "failed")
    if [[ $RESPONSE == *"version"* ]]; then
        echo "✓ EULA endpoint accessible"
    else
        echo "✗ EULA endpoint failed: $RESPONSE"
    fi
else
    echo "⚠ curl not available, skipping EULA check"
fi
ENDSSH

    log_info "Tests completed"
}

# Main deployment flow
main() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║       SecondLayer EULA Update - Deployment Script         ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""

    # Show deployment info
    log_info "Deployment Configuration:"
    echo "  Server: ${SERVER_USER}@${SERVER_HOST}:${SERVER_PORT}"
    echo "  Backend path: ${BACKEND_DEPLOY_PATH}"
    echo "  Frontend path: ${FRONTEND_DEPLOY_PATH}"
    echo ""

    # Confirm deployment
    if ! confirm "Continue with deployment?"; then
        log_warn "Deployment cancelled"
        exit 0
    fi

    echo ""

    # Run deployment steps
    check_prerequisites
    test_connection

    # Backend deployment
    if confirm "Deploy backend?"; then
        deploy_backend
    else
        log_warn "Skipping backend deployment"
    fi

    echo ""

    # Frontend deployment
    if confirm "Deploy frontend?"; then
        deploy_frontend
    else
        log_warn "Skipping frontend deployment"
    fi

    echo ""

    # Run tests
    if confirm "Run post-deployment tests?"; then
        run_tests
    fi

    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║                 Deployment Completed! ✓                    ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    log_info "EULA system is now active!"
    log_info "Users will see the EULA modal on first login"
    log_info "Help & Documentation page is available in the menu"
    echo ""
}

# Run main function
main "$@"
