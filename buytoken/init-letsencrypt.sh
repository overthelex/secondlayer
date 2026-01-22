#!/bin/bash

# SecondLayer Payment System - Let's Encrypt SSL Certificate Initialization
# This script obtains SSL certificates from Let's Encrypt for your domain

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load environment variables
if [ ! -f ".env" ]; then
    echo "❌ Error: .env file not found!"
    echo "Please copy .env.example to .env and configure DOMAIN_NAME and CERTBOT_EMAIL"
    exit 1
fi

source .env

# Validate required variables
if [ -z "$DOMAIN_NAME" ]; then
    echo "❌ Error: DOMAIN_NAME not set in .env file"
    exit 1
fi

if [ -z "$CERTBOT_EMAIL" ]; then
    echo "❌ Error: CERTBOT_EMAIL not set in .env file"
    exit 1
fi

echo "🔒 Initializing Let's Encrypt SSL certificates for: $DOMAIN_NAME"
echo "📧 Certificate notifications will be sent to: $CERTBOT_EMAIL"
echo ""

# Check if certificates already exist
if [ -d "./certbot/conf/live/$DOMAIN_NAME" ]; then
    echo "⚠️  Certificates already exist for $DOMAIN_NAME"
    read -p "Do you want to renew them? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cancelled."
        exit 0
    fi
    RENEW_FLAG="--force-renewal"
else
    RENEW_FLAG=""
fi

# Create necessary directories
echo "📁 Creating certificate directories..."
mkdir -p ./certbot/conf
mkdir -p ./certbot/www

# Step 1: Start nginx without SSL (HTTP only for ACME challenge)
echo ""
echo "🚀 Step 1: Starting nginx in HTTP-only mode for ACME challenge..."
docker-compose up -d payment-frontend

# Wait for nginx to be ready
echo "⏳ Waiting for nginx to start..."
sleep 5

# Check if nginx is responding
if ! curl -sf http://localhost/health > /dev/null 2>&1; then
    echo "❌ Error: Nginx is not responding on port 80"
    echo "Check logs with: docker-compose logs payment-frontend"
    exit 1
fi
echo "✅ Nginx is ready"

# Step 2: Request certificates from Let's Encrypt
echo ""
echo "🔐 Step 2: Requesting SSL certificate from Let's Encrypt..."
echo "This may take a minute..."

docker-compose run --rm certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "$CERTBOT_EMAIL" \
    --agree-tos \
    --no-eff-email \
    $RENEW_FLAG \
    -d "$DOMAIN_NAME"

if [ $? -ne 0 ]; then
    echo ""
    echo "❌ Certificate request failed!"
    echo ""
    echo "Common reasons:"
    echo "  1. Domain DNS not pointing to this server"
    echo "  2. Port 80 not accessible from internet"
    echo "  3. Firewall blocking HTTP traffic"
    echo "  4. Domain validation failed"
    echo ""
    echo "Troubleshooting:"
    echo "  - Check DNS: dig $DOMAIN_NAME"
    echo "  - Check port: curl http://$DOMAIN_NAME/.well-known/acme-challenge/test"
    echo "  - Check logs: docker-compose logs certbot"
    exit 1
fi

echo "✅ SSL certificate obtained successfully!"

# Step 3: Restart nginx with SSL configuration
echo ""
echo "🔄 Step 3: Restarting nginx with HTTPS enabled..."
docker-compose restart payment-frontend

# Wait for nginx to restart
sleep 5

# Test HTTPS
echo "🧪 Testing HTTPS connection..."
if curl -sfk https://localhost/health > /dev/null 2>&1; then
    echo "✅ HTTPS is working!"
else
    echo "⚠️  HTTPS test failed (might be expected if testing locally)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ SSL Certificate Setup Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🌐 Your site is now accessible at:"
echo "   https://$DOMAIN_NAME"
echo ""
echo "📜 Certificate details:"
docker-compose run --rm certbot certificates
echo ""
echo "🔄 To renew certificates, run:"
echo "   ./renew-certificates.sh"
echo ""
echo "📋 Certificate auto-renewal:"
echo "   Set up a cron job to run ./renew-certificates.sh daily"
echo "   Example: 0 3 * * * /path/to/buytoken/renew-certificates.sh"
echo ""
