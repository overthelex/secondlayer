#!/bin/bash

set -e

echo "=========================================="
echo "MCP Backend Local Deployment"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if .env file exists
if [ ! -f ".tmp/secondlayer-local.env" ]; then
    echo -e "${RED}Error: .tmp/secondlayer-local.env not found${NC}"
    exit 1
fi

echo -e "${YELLOW}Step 1: Building MCP Backend Docker image...${NC}"
cd mcp_backend
npm run build
cd ..
docker build -t secondlayer-mcp:latest -f mcp_backend/Dockerfile mcp_backend/
echo -e "${GREEN}✓ Build completed${NC}"
echo ""

echo -e "${YELLOW}Step 2: Stopping existing container...${NC}"
docker rm -f secondlayer-app-local 2>/dev/null || echo "No existing container"
echo -e "${GREEN}✓ Cleanup completed${NC}"
echo ""

echo -e "${YELLOW}Step 3: Creating Docker network...${NC}"
docker network create secondlayer-network 2>/dev/null || echo "Network already exists"
docker network connect secondlayer-network secondlayer-postgres-local 2>/dev/null || echo "Postgres already connected"
docker network connect secondlayer-network secondlayer-qdrant-local 2>/dev/null || echo "Qdrant already connected"
echo -e "${GREEN}✓ Network configured${NC}"
echo ""

echo -e "${YELLOW}Step 4: Starting MCP Backend container...${NC}"
docker run -d \
  --name secondlayer-app-local \
  --network secondlayer-network \
  -p 3000:3000 \
  --env-file .tmp/secondlayer-local.env \
  -e POSTGRES_HOST=secondlayer-postgres-local \
  -e POSTGRES_PORT=5432 \
  -e POSTGRES_DB=secondlayer_local \
  -e POSTGRES_USER=secondlayer \
  -e POSTGRES_PASSWORD=local_dev_password \
  -e QDRANT_URL=http://secondlayer-qdrant-local:6333 \
  -e NODE_ENV=development \
  secondlayer-mcp:latest \
  node --max-old-space-size=8192 dist/http-server.js

echo -e "${GREEN}✓ Container started${NC}"
echo ""

echo -e "${YELLOW}Step 5: Waiting for server to start...${NC}"
sleep 10

# Check if container is running
if docker ps | grep -q secondlayer-app-local; then
    echo -e "${GREEN}✓ Container is running${NC}"
else
    echo -e "${RED}✗ Container failed to start${NC}"
    echo ""
    echo "Logs:"
    docker logs secondlayer-app-local 2>&1 | tail -30
    exit 1
fi

# Check logs for errors
if docker logs secondlayer-app-local 2>&1 | grep -q "HTTP MCP Server started"; then
    echo -e "${GREEN}✓ Server started successfully${NC}"
else
    echo -e "${YELLOW}⚠ Server may not have started properly${NC}"
    echo ""
    echo "Recent logs:"
    docker logs secondlayer-app-local 2>&1 | tail -20
fi

echo ""
echo "=========================================="
echo -e "${GREEN}Deployment completed!${NC}"
echo "=========================================="
echo ""
echo "Server: http://localhost:3000"
echo "Health: http://localhost:3000/health"
echo ""
echo "View logs: docker logs -f secondlayer-app-local"
echo "Stop: docker stop secondlayer-app-local"
echo "Restart: docker restart secondlayer-app-local"
echo ""
