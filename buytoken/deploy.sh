#!/bin/bash

# SecondLayer Payment System - Deployment Script
# Usage: ./deploy.sh [gate|local]

set -e

ENVIRONMENT=${1:-local}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🚀 Deploying SecondLayer Payment System to: $ENVIRONMENT"

if [ "$ENVIRONMENT" = "gate" ]; then
    # Deploy to gate server
    GATE_SERVER="gate"  # Update with your server hostname or IP
    DEPLOY_PATH="/opt/secondlayer/buytoken"

    echo "📦 Building Docker images locally..."
    docker compose build

    echo "💾 Saving Docker images..."
    docker save buytoken-payment-server:latest | gzip > payment-server.tar.gz
    docker save buytoken-payment-frontend:latest | gzip > payment-frontend.tar.gz

    echo "📤 Transferring files to gate server..."
    ssh $GATE_SERVER "sudo mkdir -p $DEPLOY_PATH && sudo chown -R \$USER:\$USER $DEPLOY_PATH"

    # Copy docker images
    scp payment-server.tar.gz payment-frontend.tar.gz $GATE_SERVER:$DEPLOY_PATH/

    # Copy configuration files
    scp docker-compose.yml $GATE_SERVER:$DEPLOY_PATH/
    scp .env $GATE_SERVER:$DEPLOY_PATH/  # Make sure .env exists!

    echo "🔧 Loading images and starting services on gate server..."
    ssh $GATE_SERVER "cd $DEPLOY_PATH && \
        docker load < payment-server.tar.gz && \
        docker load < payment-frontend.tar.gz && \
        docker compose down && \
        docker compose up -d && \
        echo '📊 Waiting for containers to start...' && \
        sleep 10 && \
        docker compose ps && \
        echo '📋 Recent logs:' && \
        docker compose logs --tail=50"

    # Cleanup local files
    rm payment-server.tar.gz payment-frontend.tar.gz

    echo "✅ Deployment to gate server complete!"
    echo "🌐 Access the application at: http://$GATE_SERVER:8080"

elif [ "$ENVIRONMENT" = "local" ]; then
    # Local deployment
    echo "🏗️  Building and starting services locally..."

    # Check if .env exists
    if [ ! -f "$SCRIPT_DIR/.env" ]; then
        echo "⚠️  Warning: .env file not found. Copying from .env.example..."
        cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
        echo "📝 Please edit .env file and add your credentials before running again."
        exit 1
    fi

    # Build and start services
    docker compose down
    docker compose build
    docker compose up -d

    echo "✅ Local deployment complete!"
    echo "🌐 Frontend: http://localhost:8080"
    echo "🔌 Backend API: http://localhost:3001"
    echo ""
    echo "📊 View logs with: docker compose logs -f"
    echo "🛑 Stop services with: docker compose down"

else
    echo "❌ Invalid environment: $ENVIRONMENT"
    echo "Usage: ./deploy.sh [gate|local]"
    exit 1
fi
