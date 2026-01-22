#!/bin/bash

# SecondLayer EULA Update - Local Development Deployment
# Builds and runs locally for testing before production deployment

set -e  # Exit on error

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Deploy backend locally
deploy_backend_local() {
    log_step "Setting up backend..."

    cd "${PROJECT_ROOT}/mcp_backend"

    # Install dependencies
    log_info "Installing backend dependencies..."
    npm install

    # Run migrations
    log_info "Running database migrations..."
    npm run db:setup 2>/dev/null || npm run migrate || {
        log_info "Creating database and running migrations..."
        npm run db:create
        npm run migrate
    }

    # Build TypeScript
    log_info "Building backend TypeScript..."
    npm run build

    log_info "Backend ready ✓"
    echo "  To start: cd mcp_backend && npm run dev:http"
}

# Deploy frontend locally
deploy_frontend_local() {
    log_step "Setting up frontend..."

    cd "${PROJECT_ROOT}/frontend"

    # Install dependencies (including react-markdown)
    log_info "Installing frontend dependencies..."
    npm install

    log_info "Frontend ready ✓"
    echo "  To start: cd frontend && npm run dev"
}

# Start services
start_services() {
    log_step "Starting services..."

    # Check if tmux is available
    if command -v tmux &> /dev/null; then
        log_info "Starting services in tmux session 'secondlayer'..."

        # Kill existing session if it exists
        tmux kill-session -t secondlayer 2>/dev/null || true

        # Create new session with backend
        tmux new-session -d -s secondlayer -n backend "cd ${PROJECT_ROOT}/mcp_backend && npm run dev:http"

        # Create window for frontend
        tmux new-window -t secondlayer -n frontend "cd ${PROJECT_ROOT}/frontend && npm run dev"

        log_info "Services started in tmux session 'secondlayer' ✓"
        echo ""
        echo "  To view: tmux attach -t secondlayer"
        echo "  To detach: Ctrl+B, then D"
        echo "  To switch windows: Ctrl+B, then N (next) or P (previous)"
        echo "  To kill session: tmux kill-session -t secondlayer"
        echo ""
        echo "Services:"
        echo "  Backend:  http://localhost:3000"
        echo "  Frontend: http://localhost:5173"

    else
        log_info "tmux not available. Please start services manually:"
        echo ""
        echo "Terminal 1 - Backend:"
        echo "  cd ${PROJECT_ROOT}/mcp_backend"
        echo "  npm run dev:http"
        echo ""
        echo "Terminal 2 - Frontend:"
        echo "  cd ${PROJECT_ROOT}/frontend"
        echo "  npm run dev"
    fi
}

# Test endpoints
test_endpoints() {
    log_step "Testing endpoints (waiting for services to start)..."

    sleep 3

    # Test backend health
    log_info "Testing backend health..."
    if curl -s http://localhost:3000/health | grep -q "ok"; then
        log_info "✓ Backend health check passed"
    else
        log_error "✗ Backend not responding"
    fi

    # Test EULA endpoint
    log_info "Testing EULA endpoint..."
    if curl -s http://localhost:3000/api/eula | grep -q "version"; then
        log_info "✓ EULA endpoint working"
    else
        log_error "✗ EULA endpoint not responding"
    fi

    # Test EULA documents endpoint
    log_info "Testing EULA documents endpoint..."
    if curl -s http://localhost:3000/api/eula/documents | grep -q "eula"; then
        log_info "✓ EULA documents endpoint working"
    else
        log_error "✗ EULA documents endpoint not responding"
    fi
}

main() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║      SecondLayer EULA - Local Development Setup           ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""

    # Check EULA file
    if [ ! -f "${PROJECT_ROOT}/EULA_manual_license.txt" ]; then
        log_error "EULA_manual_license.txt not found in project root"
        exit 1
    fi

    deploy_backend_local
    echo ""
    deploy_frontend_local
    echo ""

    # Ask if user wants to start services
    read -p "$(echo -e ${YELLOW}Start services now?${NC}) [y/N]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        start_services

        if command -v curl &> /dev/null; then
            echo ""
            read -p "$(echo -e ${YELLOW}Run endpoint tests?${NC}) [y/N]: " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                test_endpoints
            fi
        fi
    fi

    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║                  Setup Completed! ✓                        ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    log_info "Next steps:"
    echo "  1. Start backend:  cd mcp_backend && npm run dev:http"
    echo "  2. Start frontend: cd frontend && npm run dev"
    echo "  3. Open browser:   http://localhost:5173"
    echo "  4. Login and test EULA modal"
    echo ""
    log_info "When ready for production:"
    echo "  ./deploy-eula-update.sh"
    echo ""
}

main "$@"
