#!/bin/bash

# Deploy Lexwebapp to DEV environment on gate server
set -e

echo "🚀 Deploying Lexwebapp to DEV environment..."

# Configuration
REMOTE_HOST="gate"
REMOTE_DIR="~/lexwebapp"
COMPOSE_FILE="docker-compose.dev.yml"

# 1. Copy files to gate server
echo "📦 Copying files to gate server..."
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'dist' \
  ./ ${REMOTE_HOST}:${REMOTE_DIR}/

# 2. Build and deploy on gate server
echo "🔨 Building and deploying on gate server..."
ssh ${REMOTE_HOST} << 'EOF'
cd ~/lexwebapp

# Stop and remove old container
echo "🛑 Stopping old container..."
docker compose -f docker-compose.dev.yml down || true
docker rm -f lexwebapp-dev 2>/dev/null || true

# Build new image
echo "🔨 Building new image..."
docker compose -f docker-compose.dev.yml build --no-cache

# Start new container
echo "🚀 Starting new container..."
docker compose -f docker-compose.dev.yml up -d

# Check status
echo "✅ Checking container status..."
sleep 3
docker ps | grep lexwebapp-dev

echo "✅ Dev deployment complete!"
echo "🌐 Available at: https://dev.legal.org.ua"
EOF

echo "✅ Deployment finished!"
