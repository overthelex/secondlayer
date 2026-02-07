#!/bin/bash
# Deployment script for modular nginx configuration
# Usage: ./deploy.sh [local|remote]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_USER="${SERVER_USER:-vovkes}"
SERVER_HOST="${SERVER_HOST:-178.162.234.145}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Function: Deploy locally (for testing in Docker)
deploy_local() {
    log_info "Deploying nginx configuration locally..."

    # Check if running as root
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run with sudo for local deployment"
        exit 1
    fi

    # Create includes directory
    mkdir -p /etc/nginx/includes

    # Copy include files
    log_info "Copying include files..."
    cp "$SCRIPT_DIR/includes/"*.conf /etc/nginx/includes/

    # Copy main config
    log_info "Copying main configuration..."
    cp "$SCRIPT_DIR/stage.legal.org.ua.conf" /etc/nginx/sites-available/

    # Create symlink
    log_info "Creating symlink..."
    ln -sf /etc/nginx/sites-available/stage.legal.org.ua /etc/nginx/sites-enabled/

    # Test configuration
    log_info "Testing nginx configuration..."
    if nginx -t; then
        log_info "✓ Configuration test passed"

        # Reload nginx
        log_info "Reloading nginx..."
        systemctl reload nginx

        log_info "✓ Deployment successful!"
        log_info ""
        log_info "Next steps:"
        log_info "  1. Test OAuth: curl -s https://stage.legal.org.ua/.well-known/oauth-authorization-server | jq"
        log_info "  2. Test MCP: curl -s https://stage.legal.org.ua/mcp | jq"
        log_info "  3. Test health: curl -s https://stage.legal.org.ua/health"
    else
        log_error "✗ Configuration test failed"
        exit 1
    fi
}

# Function: Deploy to remote server
deploy_remote() {
    log_info "Deploying nginx configuration to $SERVER_HOST..."

    # Check if SSH connection works
    log_info "Testing SSH connection..."
    if ! ssh -q "$SERVER_USER@$SERVER_HOST" exit; then
        log_error "Cannot connect to $SERVER_HOST"
        log_error "Please check SSH configuration"
        exit 1
    fi

    log_info "✓ SSH connection successful"

    # Copy files to server
    log_info "Copying files to server..."
    scp -r "$SCRIPT_DIR" "$SERVER_USER@$SERVER_HOST:/tmp/nginx-deploy"

    # Execute deployment on server
    log_info "Executing deployment on server..."
    ssh "$SERVER_USER@$SERVER_HOST" << 'ENDSSH'
        set -e

        # Create backup
        echo "[INFO] Creating backup..."
        if [ -f /etc/nginx/sites-available/stage.legal.org.ua ]; then
            sudo cp /etc/nginx/sites-available/stage.legal.org.ua \
                    /etc/nginx/sites-available/stage.legal.org.ua.backup.$(date +%Y%m%d-%H%M%S)
        fi

        if [ -d /etc/nginx/includes ]; then
            sudo tar -czf /tmp/nginx-includes-backup-$(date +%Y%m%d-%H%M%S).tar.gz /etc/nginx/includes/
        fi

        # Create includes directory
        echo "[INFO] Creating includes directory..."
        sudo mkdir -p /etc/nginx/includes

        # Copy include files
        echo "[INFO] Copying include files..."
        sudo cp /tmp/nginx-deploy/includes/*.conf /etc/nginx/includes/

        # Copy main config
        echo "[INFO] Copying main configuration..."
        sudo cp /tmp/nginx-deploy/stage.legal.org.ua.conf /etc/nginx/sites-available/

        # Create symlink
        echo "[INFO] Creating symlink..."
        sudo ln -sf /etc/nginx/sites-available/stage.legal.org.ua /etc/nginx/sites-enabled/

        # Test configuration
        echo "[INFO] Testing nginx configuration..."
        if sudo nginx -t; then
            echo "[INFO] ✓ Configuration test passed"

            # Reload nginx
            echo "[INFO] Reloading nginx..."
            sudo systemctl reload nginx

            echo "[INFO] ✓ Deployment successful!"
        else
            echo "[ERROR] ✗ Configuration test failed"

            # Restore backup
            echo "[INFO] Restoring backup..."
            BACKUP=$(ls -t /etc/nginx/sites-available/stage.legal.org.ua.backup.* 2>/dev/null | head -1)
            if [ -n "$BACKUP" ]; then
                sudo cp "$BACKUP" /etc/nginx/sites-available/stage.legal.org.ua
                sudo systemctl reload nginx
                echo "[INFO] Backup restored"
            fi

            exit 1
        fi

        # Cleanup
        rm -rf /tmp/nginx-deploy
ENDSSH

    if [ $? -eq 0 ]; then
        log_info "✓ Remote deployment successful!"
        log_info ""
        log_info "Verification commands:"
        log_info "  ssh $SERVER_USER@$SERVER_HOST 'curl -s https://stage.legal.org.ua/.well-known/oauth-authorization-server | jq'"
        log_info "  ssh $SERVER_USER@$SERVER_HOST 'curl -s https://stage.legal.org.ua/mcp | jq'"
        log_info "  ssh $SERVER_USER@$SERVER_HOST 'curl -s https://stage.legal.org.ua/health'"
    else
        log_error "✗ Remote deployment failed"
        exit 1
    fi
}

# Function: Show verification steps
verify() {
    log_info "Running verification tests..."

    # Test OAuth discovery
    log_info "Testing OAuth discovery..."
    if curl -sf https://stage.legal.org.ua/.well-known/oauth-authorization-server > /dev/null; then
        log_info "✓ OAuth discovery working"
    else
        log_warn "✗ OAuth discovery failed"
    fi

    # Test MCP discovery
    log_info "Testing MCP discovery..."
    if curl -sf https://stage.legal.org.ua/mcp > /dev/null; then
        log_info "✓ MCP discovery working"
    else
        log_warn "✗ MCP discovery failed"
    fi

    # Test health check
    log_info "Testing health check..."
    if curl -sf https://stage.legal.org.ua/health > /dev/null; then
        log_info "✓ Health check working"
    else
        log_warn "✗ Health check failed"
    fi

    log_info ""
    log_info "Verification complete!"
}

# Main script
main() {
    case "${1:-}" in
        local)
            deploy_local
            ;;
        remote)
            deploy_remote
            ;;
        verify)
            verify
            ;;
        *)
            echo "Usage: $0 {local|remote|verify}"
            echo ""
            echo "Commands:"
            echo "  local   - Deploy to local nginx (requires sudo)"
            echo "  remote  - Deploy to remote server via SSH"
            echo "  verify  - Verify deployment is working"
            echo ""
            echo "Environment variables:"
            echo "  SERVER_USER - SSH username (default: vovkes)"
            echo "  SERVER_HOST - Server hostname (default: 178.162.234.145)"
            echo ""
            echo "Examples:"
            echo "  sudo $0 local"
            echo "  $0 remote"
            echo "  SERVER_USER=admin SERVER_HOST=192.168.1.1 $0 remote"
            echo "  $0 verify"
            exit 1
            ;;
    esac
}

main "$@"
