#!/bin/bash

##############################################################################
# SecondLayer Development Environment Deployment
# Deploys to gate.lexapp.co.ua using Docker Compose
##############################################################################

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOYMENT_DIR="$(cd "$SCRIPT_DIR/../../deployment" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_msg() {
    local color=$1
    shift
    echo -e "${color}$@${NC}"
}

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║    SecondLayer Development Deployment                      ║"
echo "║    Target: gate.lexapp.co.ua (dev.legal.org.ua)           ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Verify we're in the right location
if [ ! -f "$DEPLOYMENT_DIR/docker-compose.dev.yml" ]; then
    print_msg "$RED" "❌ Error: docker-compose.dev.yml not found"
    exit 1
fi

if [ ! -f "$DEPLOYMENT_DIR/.env.dev" ]; then
    print_msg "$RED" "❌ Error: .env.dev not found"
    print_msg "$YELLOW" "Copy .env.dev.example and configure it first"
    exit 1
fi

# Show what will be deployed
print_msg "$BLUE" "📋 Deployment Configuration:"
echo "  Environment: development"
echo "  Target Server: gate.lexapp.co.ua"
echo "  Compose File: docker-compose.dev.yml"
echo "  Env File: .env.dev"
echo "  Public URL: https://dev.legal.org.ua"
echo ""

# Confirm deployment
read -p "$(echo -e ${YELLOW}Continue with deployment?${NC}) [y/N]: " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_msg "$YELLOW" "Deployment cancelled"
    exit 0
fi

# Run deployment using manage-gateway.sh
print_msg "$BLUE" "🚀 Starting deployment..."
echo ""

cd "$DEPLOYMENT_DIR"
./manage-gateway.sh deploy dev

print_msg "$GREEN" "✅ Deployment complete!"
echo ""
print_msg "$BLUE" "📋 Next steps:"
echo "  1. Check status: cd deployment && ./manage-gateway.sh status"
echo "  2. View logs: cd deployment && ./manage-gateway.sh logs dev"
echo "  3. Test endpoints:"
echo "     - Backend health: https://dev.legal.org.ua/health"
echo "     - Frontend: https://dev.legal.org.ua/"
echo "     - OpenReyestr: https://dev.legal.org.ua:3005/health"
echo ""
