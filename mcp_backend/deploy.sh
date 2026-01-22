#!/bin/bash

# SecondLayer MCP Backend - Deployment Script
# Deploys Docker containers to gate server

set -e  # Exit on error

# Configuration
SERVER_USER="${DEPLOY_USER:-ubuntu}"
SERVER_HOST="${DEPLOY_HOST:-gate-server}"
SERVER_PORT="${DEPLOY_PORT:-22}"
DEPLOY_PATH="${DEPLOY_PATH:-~/secondlayer}"
PROJECT_NAME="secondlayer"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed locally"
        log_warn "Docker is only needed on the server, continuing..."
    fi

    if ! command -v ssh &> /dev/null; then
        log_error "SSH is not installed"
        exit 1
    fi

    if [ ! -f ".env.production" ]; then
        log_error ".env.production file not found. Please create it from .env.production.template"
        exit 1
    fi

    log_info "Prerequisites check passed"
}

# Create deployment package
create_package() {
    log_info "Creating deployment package..."

    # Create temp directory
    TEMP_DIR=$(mktemp -d)
    PACKAGE_DIR="${TEMP_DIR}/${PROJECT_NAME}"
    mkdir -p "${PACKAGE_DIR}"

    # Copy necessary files
    cp docker-compose.prod.yml "${PACKAGE_DIR}/docker-compose.yml"
    cp Dockerfile "${PACKAGE_DIR}/"
    cp package.json "${PACKAGE_DIR}/"
    cp package-lock.json "${PACKAGE_DIR}/" 2>/dev/null || true
    cp .env.production "${PACKAGE_DIR}/.env"
    cp -r src "${PACKAGE_DIR}/"
    cp tsconfig.json "${PACKAGE_DIR}/"
    cp jest.config.js "${PACKAGE_DIR}/" 2>/dev/null || true
    cp jest.setup.js "${PACKAGE_DIR}/" 2>/dev/null || true

    # Create tarball
    tar -czf "${TEMP_DIR}/${PROJECT_NAME}.tar.gz" -C "${TEMP_DIR}" "${PROJECT_NAME}"

    echo "${TEMP_DIR}/${PROJECT_NAME}.tar.gz"
}

# Deploy to server
deploy_to_server() {
    local package_path=$1

    log_info "Deploying to ${SERVER_USER}@${SERVER_HOST}:${DEPLOY_PATH}..."

    # Create remote directory
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" "mkdir -p ${DEPLOY_PATH}"

    # Copy package
    log_info "Copying files to server..."
    scp -P "${SERVER_PORT}" "${package_path}" "${SERVER_USER}@${SERVER_HOST}:${DEPLOY_PATH}/"

    # Extract and setup on server
    log_info "Setting up on server..."
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" "bash -s" << ENDSSH
cd ${DEPLOY_PATH}
tar -xzf ${PROJECT_NAME}.tar.gz
cd ${PROJECT_NAME}

# Stop existing containers
if [ -f docker-compose.yml ]; then
    echo "Stopping existing containers..."
    docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true
fi

# Pull latest images
echo "Pulling Docker images..."
docker compose pull || docker-compose pull

# Build application image
echo "Building application..."
docker compose build || docker-compose build

# Start services
echo "Starting services..."
docker compose up -d || docker-compose up -d

# Wait for services to be healthy
echo "Waiting for services to start..."
sleep 10

# Check service health
docker compose ps || docker-compose ps

echo "Deployment complete!"
ENDSSH

    log_info "Deployment successful!"
}

# Show status on remote server
show_status() {
    log_info "Checking service status on ${SERVER_HOST}..."
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" "cd ${DEPLOY_PATH}/${PROJECT_NAME} && (docker compose ps || docker-compose ps)"
}

# Show logs from remote server
show_logs() {
    log_info "Showing logs from ${SERVER_HOST}..."
    ssh -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}" "cd ${DEPLOY_PATH}/${PROJECT_NAME} && (docker compose logs -f || docker-compose logs -f)"
}

# Cleanup
cleanup() {
    if [ -n "${TEMP_DIR}" ] && [ -d "${TEMP_DIR}" ]; then
        rm -rf "${TEMP_DIR}"
    fi
}

# Main deployment process
main() {
    # Check for command
    case "${1:-deploy}" in
        deploy)
            log_info "Starting deployment of SecondLayer MCP Backend"

            # Trap cleanup on exit
            trap cleanup EXIT

            # Check prerequisites
            check_prerequisites

            # Create deployment package
            PACKAGE_PATH=$(create_package)
            log_info "Package created: ${PACKAGE_PATH}"

            # Deploy to server
            deploy_to_server "${PACKAGE_PATH}"

            log_info "Deployment completed successfully!"
            log_info ""
            log_info "Next steps:"
            log_info "  - Check status: ./deploy.sh status"
            log_info "  - View logs: ./deploy.sh logs"
            log_info "  - Access API: http://${SERVER_HOST}:3000"
            ;;
        status)
            show_status
            ;;
        logs)
            show_logs
            ;;
        *)
            echo "Usage: $0 {deploy|status|logs}"
            echo ""
            echo "Commands:"
            echo "  deploy  - Deploy application to gate server (default)"
            echo "  status  - Check service status on gate server"
            echo "  logs    - View application logs on gate server"
            exit 1
            ;;
    esac
}

# Run main function
main "$@"
