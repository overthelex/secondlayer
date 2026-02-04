#!/bin/bash

# Script to update staging backend on mail server with latest code
# This will build a fresh image with MCP SSE support

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

MAIL_SERVER="mail"
REPO_PATH="/home/vovkes/SecondLayer"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Update Stage Backend on Mail Server${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Step 1: Check connection
echo -e "${YELLOW}Step 1: Checking connection to mail server...${NC}"
if ssh ${MAIL_SERVER} "echo 'Connected'" >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Connected to mail server${NC}"
else
    echo -e "${RED}✗ Cannot connect to mail server${NC}"
    exit 1
fi
echo ""

# Step 2: Check if repo exists on mail server
echo -e "${YELLOW}Step 2: Checking repository on mail server...${NC}"
REPO_EXISTS=$(ssh ${MAIL_SERVER} "[ -d ${REPO_PATH} ] && echo 'yes' || echo 'no'")

if [ "$REPO_EXISTS" = "yes" ]; then
    echo -e "${GREEN}✓ Repository found at ${REPO_PATH}${NC}"

    # Pull latest changes
    echo "Pulling latest changes..."
    ssh ${MAIL_SERVER} "cd ${REPO_PATH} && git pull"
else
    echo -e "${YELLOW}⚠ Repository not found at ${REPO_PATH}${NC}"
    echo "Please specify the correct path or clone the repository first:"
    echo "  ssh ${MAIL_SERVER}"
    echo "  git clone <repo-url> ${REPO_PATH}"
    exit 1
fi
echo ""

# Step 3: Stop staging container
echo -e "${YELLOW}Step 3: Stopping staging container...${NC}"
ssh ${MAIL_SERVER} "docker stop secondlayer-app-stage || true"
echo -e "${GREEN}✓ Container stopped${NC}"
echo ""

# Step 4: Rebuild image with latest code
echo -e "${YELLOW}Step 4: Rebuilding backend image (this may take 5-10 minutes)...${NC}"
ssh ${MAIL_SERVER} << 'EOF'
cd /home/vovkes/SecondLayer/deployment
docker compose -f docker-compose.stage.yml --env-file .env.stage build --no-cache app-stage
EOF

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Image rebuilt successfully${NC}"
else
    echo -e "${RED}✗ Failed to rebuild image${NC}"
    echo "Restarting old container..."
    ssh ${MAIL_SERVER} "docker start secondlayer-app-stage"
    exit 1
fi
echo ""

# Step 5: Start updated container
echo -e "${YELLOW}Step 5: Starting updated container...${NC}"
ssh ${MAIL_SERVER} << 'EOF'
cd /home/vovkes/SecondLayer/deployment
docker compose -f docker-compose.stage.yml --env-file .env.stage up -d app-stage
EOF
echo -e "${GREEN}✓ Container started${NC}"
echo ""

# Step 6: Wait for container to be healthy
echo -e "${YELLOW}Step 6: Waiting for container to be healthy...${NC}"
for i in {1..30}; do
    HEALTH=$(ssh ${MAIL_SERVER} "docker inspect --format='{{.State.Health.Status}}' secondlayer-app-stage 2>/dev/null || echo 'unknown'")

    if [ "$HEALTH" = "healthy" ]; then
        echo -e "${GREEN}✓ Container is healthy${NC}"
        break
    elif [ "$HEALTH" = "unhealthy" ]; then
        echo -e "${RED}✗ Container is unhealthy${NC}"
        echo "Checking logs:"
        ssh ${MAIL_SERVER} "docker logs --tail 50 secondlayer-app-stage"
        exit 1
    else
        echo "Waiting... ($i/30) Status: $HEALTH"
        sleep 2
    fi
done
echo ""

# Step 7: Check logs for MCP endpoints
echo -e "${YELLOW}Step 7: Checking startup logs for MCP endpoints...${NC}"
ssh ${MAIL_SERVER} "docker logs --tail 50 secondlayer-app-stage" | grep -E "GET.*\/mcp|POST.*\/sse|MCP" || echo "No MCP endpoint logs found yet"
echo ""

# Step 8: Test MCP endpoints
echo -e "${YELLOW}Step 8: Testing MCP endpoints...${NC}"

echo "Testing /health..."
HEALTH_RESPONSE=$(ssh ${MAIL_SERVER} "curl -s http://localhost:3004/health")
echo "$HEALTH_RESPONSE"

echo ""
echo "Testing /mcp..."
MCP_RESPONSE=$(ssh ${MAIL_SERVER} "curl -s -H 'Authorization: Bearer test-key-123' http://localhost:3004/mcp")
if echo "$MCP_RESPONSE" | grep -q "error"; then
    echo -e "${RED}✗ /mcp endpoint not working${NC}"
    echo "$MCP_RESPONSE"
else
    echo -e "${GREEN}✓ /mcp endpoint working${NC}"
    echo "$MCP_RESPONSE" | head -c 200
    echo "..."
fi

echo ""
echo "Testing /sse..."
SSE_RESPONSE=$(ssh ${MAIL_SERVER} "curl -s -X POST -H 'Authorization: Bearer test-key-123' -H 'Content-Type: application/json' -H 'Accept: text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}' http://localhost:3004/sse" | head -c 500)

if echo "$SSE_RESPONSE" | grep -q "error"; then
    echo -e "${RED}✗ /sse endpoint not working${NC}"
    echo "$SSE_RESPONSE"
else
    echo -e "${GREEN}✓ /sse endpoint working${NC}"
    echo "$SSE_RESPONSE" | head -c 200
    echo "..."
fi
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Update Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${GREEN}✓ Backend updated on mail server${NC}"
echo -e "${GREEN}✓ Container restarted successfully${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Install nginx configuration:"
echo "   ./deploy-stage-mcp-to-mail.sh"
echo ""
echo "2. Or manually:"
echo "   scp deployment/nginx-stage-mcp.conf mail:/tmp/"
echo "   ssh mail 'sudo mv /tmp/nginx-stage-mcp.conf /etc/nginx/sites-available/stage.mcp.legal.org.ua'"
echo "   ssh mail 'sudo ln -s /etc/nginx/sites-available/stage.mcp.legal.org.ua /etc/nginx/sites-enabled/'"
echo "   ssh mail 'sudo certbot --nginx -d stage.mcp.legal.org.ua'"
echo "   ssh mail 'sudo systemctl reload nginx'"
echo ""
echo "3. Test the HTTPS endpoint:"
echo "   ./test-stage-mcp-connection.sh"
echo ""
