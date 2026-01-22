#!/bin/bash

# Setup Nginx on gate.lexapp.co.ua for SecondLayer MCP
# This script should be run ON the gate server

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

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
    echo -e "${BLUE}==>${NC} $1"
}

# Check if running as root or with sudo
check_sudo() {
    if [ "$EUID" -ne 0 ]; then
        log_error "This script needs sudo privileges"
        log_info "Please run with: sudo bash $0"
        exit 1
    fi
}

# Step 1: Check prerequisites
check_prerequisites() {
    log_step "Checking prerequisites..."

    if ! command -v nginx &> /dev/null; then
        log_error "Nginx is not installed"
        log_info "Install with: sudo apt update && sudo apt install nginx"
        exit 1
    fi

    if ! command -v certbot &> /dev/null; then
        log_warn "Certbot is not installed (needed for SSL)"
        log_info "Install with: sudo apt install certbot python3-certbot-nginx"
    fi

    log_info "Prerequisites OK"
}

# Step 2: Create nginx config
setup_nginx_config() {
    log_step "Setting up nginx configuration..."

    NGINX_SITE="/etc/nginx/sites-available/mcp.legal.org.ua"

    cat > "$NGINX_SITE" << 'EOFNGINX'
# SecondLayer MCP Server - SSE Transport
upstream secondlayer_mcp {
    server localhost:3000;
    keepalive 64;
}

# HTTP - redirect to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name mcp.legal.org.ua;

    # ACME challenge for certbot
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Redirect all other traffic to HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS - Will be configured by certbot
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name mcp.legal.org.ua;

    # SSL Configuration (certbot will fill these in)
    ssl_certificate /etc/letsencrypt/live/mcp.legal.org.ua/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.legal.org.ua/privkey.pem;

    # SSL Settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;

    # Security Headers
    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Logging
    access_log /var/log/nginx/mcp.legal.org.ua.access.log;
    error_log /var/log/nginx/mcp.legal.org.ua.error.log;

    # Health check endpoint
    location /health {
        proxy_pass http://secondlayer_mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # MCP SSE endpoint - CRITICAL CONFIGURATION
    location /v1/sse {
        proxy_pass http://secondlayer_mcp;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # CRITICAL: Disable buffering for SSE
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        chunked_transfer_encoding on;
        tcp_nodelay on;
        tcp_nopush off;

        proxy_set_header Connection "keep-alive";
        keepalive_timeout 86400s;
        proxy_set_header Accept-Encoding "";
    }

    location / {
        return 404;
    }
}
EOFNGINX

    log_info "Nginx config created at: $NGINX_SITE"

    # Create symlink
    if [ ! -L "/etc/nginx/sites-enabled/mcp.legal.org.ua" ]; then
        ln -s "$NGINX_SITE" /etc/nginx/sites-enabled/
        log_info "Enabled site: mcp.legal.org.ua"
    else
        log_warn "Site already enabled"
    fi
}

# Step 3: Test nginx config
test_nginx() {
    log_step "Testing nginx configuration..."

    if nginx -t; then
        log_info "Nginx configuration is valid"
    else
        log_error "Nginx configuration has errors"
        exit 1
    fi
}

# Step 4: Reload nginx
reload_nginx() {
    log_step "Reloading nginx..."
    systemctl reload nginx
    log_info "Nginx reloaded"
}

# Step 5: Setup SSL certificate
setup_ssl() {
    log_step "Setting up SSL certificate..."

    log_warn "About to run certbot for mcp.legal.org.ua"
    log_info "Make sure DNS is pointing to this server!"

    read -p "Continue with certbot? (y/n) " -n 1 -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        certbot --nginx -d mcp.legal.org.ua
        log_info "SSL certificate obtained"
    else
        log_warn "Skipping SSL setup. Run manually: sudo certbot --nginx -d mcp.legal.org.ua"
    fi
}

# Step 6: Check Docker services
check_docker() {
    log_step "Checking Docker services..."

    if command -v docker &> /dev/null; then
        if docker ps | grep -q secondlayer-app; then
            log_info "SecondLayer MCP container is running"
            docker ps | grep secondlayer
        else
            log_warn "SecondLayer MCP container is NOT running"
            log_info "Start it with: cd ~/secondlayer/secondlayer && docker compose up -d"
        fi
    else
        log_warn "Docker is not installed or not in PATH"
    fi
}

# Main function
main() {
    echo ""
    log_info "SecondLayer MCP - Nginx Setup Script"
    log_info "====================================="
    echo ""

    check_sudo
    check_prerequisites
    setup_nginx_config
    test_nginx
    reload_nginx
    setup_ssl
    check_docker

    echo ""
    log_info "Setup complete!"
    echo ""
    log_info "Next steps:"
    log_info "  1. Ensure Docker containers are running"
    log_info "  2. Test health endpoint: curl https://mcp.legal.org.ua/health"
    log_info "  3. Configure your MCP client:"
    echo ""
    echo '  {
    "SecondLayerMCP": {
      "url": "https://mcp.legal.org.ua/v1/sse",
      "headers": {}
    }
  }'
    echo ""
}

main "$@"
