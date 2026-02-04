#!/bin/bash

# Build frontend for specific environment
# Usage: ./build-frontend.sh [local|dev|stage|prod]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LEXWEBAPP_DIR="$PROJECT_ROOT/lexwebapp"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_msg() {
    echo -e "${1}${2}${NC}"
}

# Get environment from argument or default to production
ENV=${1:-production}

case "$ENV" in
    local)
        BUILD_ENV="local"
        IMAGE_TAG="lexwebapp-lexwebapp:local"
        ;;
    dev|development)
        BUILD_ENV="development"
        IMAGE_TAG="lexwebapp-lexwebapp:dev"
        ;;
    stage|staging)
        BUILD_ENV="staging"
        IMAGE_TAG="lexwebapp-lexwebapp:stage"
        ;;
    prod|production)
        BUILD_ENV="production"
        IMAGE_TAG="lexwebapp-lexwebapp:latest"
        ;;
    *)
        print_msg "$RED" "❌ Invalid environment: $ENV"
        echo "Usage: $0 [local|dev|stage|prod]"
        exit 1
        ;;
esac

print_msg "$BLUE" "🔨 Building frontend for environment: $BUILD_ENV"
print_msg "$BLUE" "📦 Image tag: $IMAGE_TAG"

# Check if .env file exists for this environment
if [ ! -f "$LEXWEBAPP_DIR/.env.$BUILD_ENV" ]; then
    print_msg "$RED" "❌ Environment file not found: .env.$BUILD_ENV"
    exit 1
fi

print_msg "$BLUE" "📋 Using environment file: .env.$BUILD_ENV"
cat "$LEXWEBAPP_DIR/.env.$BUILD_ENV"

# Build the image
cd "$LEXWEBAPP_DIR"
print_msg "$BLUE" "🏗️  Building Docker image..."

docker build \
    --build-arg BUILD_ENV="$BUILD_ENV" \
    -t "$IMAGE_TAG" \
    .

# Also tag as :latest for compatibility with current docker-compose files
if [ "$BUILD_ENV" != "production" ]; then
    docker tag "$IMAGE_TAG" lexwebapp-lexwebapp:latest
    print_msg "$YELLOW" "ℹ️  Also tagged as lexwebapp-lexwebapp:latest for compatibility"
fi

print_msg "$GREEN" "✅ Frontend image built successfully: $IMAGE_TAG"

# Show image info
print_msg "$BLUE" "\n📊 Image details:"
docker images | grep -E "REPOSITORY|lexwebapp-lexwebapp" | head -5
