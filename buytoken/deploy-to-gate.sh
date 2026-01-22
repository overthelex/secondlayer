#!/bin/bash
# Deployment script for SecondLayer Console on gate.lexapp.co.ua

set -e  # Exit on error

# Configuration
GATE_SERVER="gate.lexapp.co.ua"
GATE_USER="vovkes"
REMOTE_DIR="/opt/secondlayer-console"
NGINX_CONFIG_NAME="legal.org.ua-console"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== SecondLayer Console Deployment ===${NC}"
echo "Target server: ${GATE_SERVER}"
echo ""

# Step 1: Build Docker images locally (optional)
echo -e "${YELLOW}Step 1: Building Docker images locally...${NC}"
read -p "Do you want to build images locally? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    docker-compose -f docker-compose.gate-server.yml build
    echo -e "${GREEN}✓ Images built${NC}"
fi

# Step 2: Copy files to gate server
echo -e "${YELLOW}Step 2: Copying files to gate server...${NC}"

# Create remote directory
ssh ${GATE_USER}@${GATE_SERVER} "mkdir -p ${REMOTE_DIR}"

# Copy application files
rsync -avz --exclude 'node_modules' --exclude '.git' \
  . ${GATE_USER}@${GATE_SERVER}:${REMOTE_DIR}/

echo -e "${GREEN}✓ Files copied${NC}"

# Step 3: Deploy nginx configuration
echo -e "${YELLOW}Step 3: Deploying nginx configuration...${NC}"

# Copy nginx config to temp location first, then move with sudo
scp nginx-gate-server.conf ${GATE_USER}@${GATE_SERVER}:/tmp/${NGINX_CONFIG_NAME}

# Enable site and test nginx
ssh ${GATE_USER}@${GATE_SERVER} << ENDSSH
set -e

# Move config to nginx directory with sudo
sudo mv /tmp/${NGINX_CONFIG_NAME} /etc/nginx/sites-available/${NGINX_CONFIG_NAME}

# Create symlink if doesn't exist
if [ ! -L /etc/nginx/sites-enabled/${NGINX_CONFIG_NAME} ]; then
    sudo ln -s /etc/nginx/sites-available/${NGINX_CONFIG_NAME} /etc/nginx/sites-enabled/
    echo "✓ Nginx site enabled"
fi

# Test nginx configuration
sudo nginx -t
ENDSSH

echo -e "${GREEN}✓ Nginx configured${NC}"

# Step 4: Check .env file
echo -e "${YELLOW}Step 4: Checking environment configuration...${NC}"

ssh ${GATE_USER}@${GATE_SERVER} << ENDSSH
cd ${REMOTE_DIR}

if [ ! -f .env ]; then
    echo -e "${RED}WARNING: .env file not found!${NC}"
    echo "Please create .env file with required variables:"
    echo "  - JWT_SECRET"
    echo "  - GOOGLE_CLIENT_ID"
    echo "  - GOOGLE_CLIENT_SECRET"
    echo "  - SMTP_USER"
    echo "  - SMTP_PASS"
    exit 1
else
    echo "✓ .env file exists"
fi
ENDSSH

# Step 5: Start Docker containers
echo -e "${YELLOW}Step 5: Starting Docker containers...${NC}"

ssh ${GATE_USER}@${GATE_SERVER} << ENDSSH
cd ${REMOTE_DIR}

# Pull latest images (if using registry)
# docker-compose -f docker-compose.gate-server.yml pull

# Build and start containers
docker-compose -f docker-compose.gate-server.yml up -d --build

# Wait for services to be healthy
echo "Waiting for services to start..."
sleep 10

# Check container status
docker-compose -f docker-compose.gate-server.yml ps
ENDSSH

echo -e "${GREEN}✓ Containers started${NC}"

# Step 6: Reload nginx
echo -e "${YELLOW}Step 6: Reloading nginx...${NC}"

ssh ${GATE_USER}@${GATE_SERVER} "sudo systemctl reload nginx"

echo -e "${GREEN}✓ Nginx reloaded${NC}"

# Step 7: Verify deployment
echo -e "${YELLOW}Step 7: Verifying deployment...${NC}"

# Test health endpoint
sleep 5
if curl -f -s http://localhost:8080/health > /dev/null; then
    echo -e "${GREEN}✓ Service health check passed${NC}"
else
    echo -e "${RED}✗ Service health check failed${NC}"
fi

echo ""
echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo "Service should be available at: https://legal.org.ua/console"
echo ""
echo "Useful commands:"
echo "  - View logs: ssh ${GATE_USER}@${GATE_SERVER} 'cd ${REMOTE_DIR} && docker-compose -f docker-compose.gate-server.yml logs -f'"
echo "  - Stop service: ssh ${GATE_USER}@${GATE_SERVER} 'cd ${REMOTE_DIR} && docker-compose -f docker-compose.gate-server.yml down'"
echo "  - Restart service: ssh ${GATE_USER}@${GATE_SERVER} 'cd ${REMOTE_DIR} && docker-compose -f docker-compose.gate-server.yml restart'"
echo ""
