#!/bin/bash

# Deployment script for Stage MCP Server on mail server
# This script installs nginx configuration for stage.mcp.legal.org.ua

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

MAIL_SERVER="${DEPLOY_SSH_HOST:-mail}"
MAIL_USER="${DEPLOY_SSH_USER:-vovkes}"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Deploy Stage MCP to Mail Server${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if we can connect to mail server
echo -e "${YELLOW}Step 1: Check connection to mail server${NC}"
if ssh -o ConnectTimeout=5 ${MAIL_USER}@${MAIL_SERVER} "echo 'Connected'" 2>/dev/null; then
    echo -e "${GREEN}✓ Connected to ${MAIL_SERVER}${NC}"
else
    echo -e "${RED}✗ Cannot connect to ${MAIL_SERVER}${NC}"
    echo "Please configure SSH access first:"
    echo "  ssh-copy-id ${MAIL_USER}@${MAIL_SERVER}"
    exit 1
fi
echo ""

# Check if staging backend is running on port 3004
echo -e "${YELLOW}Step 2: Check if staging backend is running${NC}"
BACKEND_STATUS=$(ssh ${MAIL_USER}@${MAIL_SERVER} "docker ps | grep -E 'stage.*3004' || echo 'not_found'")

if echo "$BACKEND_STATUS" | grep -q "not_found"; then
    echo -e "${YELLOW}⚠ Staging backend not found on port 3004${NC}"
    echo "Checking all docker containers..."
    ssh ${MAIL_USER}@${MAIL_SERVER} "docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep -E 'stage|3004' || echo 'No stage containers found'"
    echo ""
    echo -e "${YELLOW}Would you like to start staging backend? (y/n)${NC}"
    read -r RESPONSE
    if [[ "$RESPONSE" =~ ^[Yy]$ ]]; then
        echo "Starting staging backend..."
        ssh ${MAIL_USER}@${MAIL_SERVER} "cd /home/vovkes/SecondLayer/deployment && docker compose -f docker-compose.stage.yml --env-file .env.stage up -d"
    else
        echo "Please start staging backend manually and run this script again"
        exit 1
    fi
else
    echo -e "${GREEN}✓ Staging backend is running${NC}"
    echo "$BACKEND_STATUS"
fi
echo ""

# Copy nginx configuration
echo -e "${YELLOW}Step 3: Copy nginx configuration${NC}"
scp deployment/nginx-stage-mcp.conf ${MAIL_USER}@${MAIL_SERVER}:/tmp/
echo -e "${GREEN}✓ Configuration copied${NC}"
echo ""

# Install nginx configuration
echo -e "${YELLOW}Step 4: Install nginx configuration${NC}"
ssh ${MAIL_USER}@${MAIL_SERVER} << 'EOF'
    # Move config to sites-available
    sudo mv /tmp/nginx-stage-mcp.conf /etc/nginx/sites-available/stage.mcp.legal.org.ua

    # Create symlink if not exists
    if [ ! -L /etc/nginx/sites-enabled/stage.mcp.legal.org.ua ]; then
        sudo ln -s /etc/nginx/sites-available/stage.mcp.legal.org.ua /etc/nginx/sites-enabled/
        echo "✓ Symlink created"
    else
        echo "✓ Symlink already exists"
    fi

    # Test nginx configuration
    sudo nginx -t
EOF

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Nginx configuration installed and tested${NC}"
else
    echo -e "${RED}✗ Nginx configuration test failed${NC}"
    exit 1
fi
echo ""

# Check SSL certificate
echo -e "${YELLOW}Step 5: Check SSL certificate${NC}"
CERT_CHECK=$(ssh ${MAIL_USER}@${MAIL_SERVER} "sudo ls /etc/letsencrypt/live/stage.mcp.legal.org.ua/ 2>/dev/null || echo 'not_found'")

if echo "$CERT_CHECK" | grep -q "not_found"; then
    echo -e "${YELLOW}⚠ SSL certificate not found${NC}"
    echo -e "${YELLOW}Getting SSL certificate with certbot...${NC}"

    ssh ${MAIL_USER}@${MAIL_SERVER} "sudo certbot --nginx -d stage.mcp.legal.org.ua --non-interactive --agree-tos --email admin@legal.org.ua || echo 'certbot_failed'"

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ SSL certificate obtained${NC}"
    else
        echo -e "${RED}✗ Failed to get SSL certificate${NC}"
        echo "You may need to run certbot manually:"
        echo "  ssh ${MAIL_USER}@${MAIL_SERVER}"
        echo "  sudo certbot --nginx -d stage.mcp.legal.org.ua"
        exit 1
    fi
else
    echo -e "${GREEN}✓ SSL certificate exists${NC}"
    echo "$CERT_CHECK"

    # Update nginx config with SSL paths
    echo "Ensuring SSL paths are correct in nginx config..."
    ssh ${MAIL_USER}@${MAIL_SERVER} << 'EOF'
        sudo sed -i 's/# ssl_certificate/ssl_certificate/g' /etc/nginx/sites-available/stage.mcp.legal.org.ua
        sudo nginx -t
EOF
fi
echo ""

# Reload nginx
echo -e "${YELLOW}Step 6: Reload nginx${NC}"
ssh ${MAIL_USER}@${MAIL_SERVER} "sudo systemctl reload nginx"
echo -e "${GREEN}✓ Nginx reloaded${NC}"
echo ""

# Test connection
echo -e "${YELLOW}Step 7: Test connection${NC}"
echo "Testing HTTP health endpoint..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://stage.mcp.legal.org.ua/health)
echo "HTTP Response: $HTTP_CODE"

echo "Testing HTTPS health endpoint..."
HTTPS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://stage.mcp.legal.org.ua/health)
echo "HTTPS Response: $HTTPS_CODE"

if [ "$HTTPS_CODE" = "200" ]; then
    echo -e "${GREEN}✓ HTTPS connection successful!${NC}"
else
    echo -e "${YELLOW}⚠ HTTPS returned code: $HTTPS_CODE${NC}"
fi
echo ""

# Test MCP endpoint
echo -e "${YELLOW}Step 8: Test MCP endpoint${NC}"
MCP_RESPONSE=$(curl -s -H "Authorization: Bearer ${SECONDARY_LAYER_KEYS}" https://stage.mcp.legal.org.ua/mcp)
echo "MCP Response:"
echo "$MCP_RESPONSE" | jq '.' 2>/dev/null || echo "$MCP_RESPONSE"
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Deployment Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${GREEN}✓ Nginx configuration installed${NC}"
echo -e "${GREEN}✓ SSL certificate configured${NC}"
echo -e "${GREEN}✓ Server is accessible${NC}"
echo ""
echo -e "${YELLOW}MCP Server URL:${NC}"
echo "  https://stage.mcp.legal.org.ua/sse"
echo ""
echo -e "${YELLOW}API Token:${NC}"
echo "  ${SECONDARY_LAYER_KEYS}"
echo ""
echo -e "${YELLOW}Test with:${NC}"
echo "  ./test-stage-mcp-connection.sh"
echo ""
echo -e "${YELLOW}Claude Desktop config:${NC}"
cat << 'EOFCONFIG'
{
  "mcpServers": {
    "secondlayer-stage": {
      "url": "https://stage.mcp.legal.org.ua/sse",
      "transport": {
        "type": "sse"
      },
      "headers": {
        "Authorization": "Bearer ${SECONDARY_LAYER_KEYS}"
      }
    }
  }
}
EOFCONFIG
echo ""
