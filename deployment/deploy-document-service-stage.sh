#!/bin/bash

# Deploy document-service to staging environment
# This script:
# 1. Builds the document-service image (if needed)
# 2. Deploys to stage environment
# 3. Verifies health check

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "Document Service - STAGE Deployment"
echo "=========================================="
echo ""

# Check if we're on the remote server
if [ -f "/home/ubuntu/.ssh/authorized_keys" ]; then
    IS_REMOTE=true
    echo "✓ Running on remote server (mail.lexapp.co.ua)"
else
    IS_REMOTE=false
    echo "✓ Running on local machine"
fi

# Step 1: Build image
echo ""
echo "Step 1: Building document-service image..."
echo "-------------------------------------------"

cd "$PROJECT_ROOT"

docker compose -f deployment/docker-compose.local.yml build document-service-local

if [ $? -eq 0 ]; then
    echo "✓ Image built successfully"
else
    echo "✗ Image build failed"
    exit 1
fi

# Step 2: Deploy to stage
echo ""
echo "Step 2: Deploying to staging environment..."
echo "-------------------------------------------"

docker compose -f deployment/docker-compose.stage.yml up -d document-service-stage

if [ $? -eq 0 ]; then
    echo "✓ Deployed successfully"
else
    echo "✗ Deployment failed"
    exit 1
fi

# Step 3: Wait for health check
echo ""
echo "Step 3: Waiting for service to become healthy..."
echo "-------------------------------------------"

for i in {1..30}; do
    if docker inspect document-service-stage | grep -q '"Status": "healthy"'; then
        echo "✓ Service is healthy!"
        break
    elif [ $i -eq 30 ]; then
        echo "✗ Service did not become healthy after 30 seconds"
        echo ""
        echo "Logs:"
        docker logs --tail=20 document-service-stage
        exit 1
    else
        echo "  Waiting... ($i/30)"
        sleep 1
    fi
done

# Step 4: Verify service
echo ""
echo "Step 4: Verifying service..."
echo "-------------------------------------------"

# Check if running locally or remotely
if [ "$IS_REMOTE" = true ]; then
    HEALTH_URL="http://localhost:3005/health"
else
    HEALTH_URL="http://localhost:3005/health"
fi

HEALTH_CHECK=$(curl -s "$HEALTH_URL" 2>&1)

if echo "$HEALTH_CHECK" | grep -q '"status":"healthy"'; then
    echo "✓ Service is responding correctly"
    echo ""
    echo "Response:"
    echo "$HEALTH_CHECK" | jq .
else
    echo "✗ Service is not responding correctly"
    echo "Response: $HEALTH_CHECK"
    exit 1
fi

# Step 5: Show deployment info
echo ""
echo "=========================================="
echo "Deployment Summary"
echo "=========================================="
echo "Service: document-service-stage"
echo "Container: $(docker ps --filter name=document-service-stage --format '{{.Names}}')"
echo "Status: $(docker ps --filter name=document-service-stage --format '{{.Status}}')"
echo "Port: 3005 (external) → 3002 (internal)"
echo "Health endpoint: $HEALTH_URL"
echo ""
echo "Test document parsing:"
echo "curl -X POST http://localhost:3005/api/parse-document \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"fileBase64\": \"...\", \"mimeType\": \"application/pdf\", \"filename\": \"test.pdf\"}'"
echo ""
echo "✓ Deployment complete!"
