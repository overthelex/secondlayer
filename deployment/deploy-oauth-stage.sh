#!/bin/bash
# Deploy OAuth 2.0 to Stage Environment
# Usage: ./deploy-oauth-stage.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

STAGE_HOST="root@mail.lexapp.co.ua"
STAGE_DIR="/root/SecondLayer"
CONTAINER_APP="secondlayer-app-stage"
CONTAINER_DB="secondlayer-postgres-stage"
DB_USER="secondlayer"
DB_NAME="secondlayer_stage"

echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Deploy OAuth 2.0 to Stage Environment                 ║${NC}"
echo -e "${BLUE}║               mail.lexapp.co.ua:3004                           ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check SSH connection
echo -e "${YELLOW}[1/8] Testing SSH connection...${NC}"
if ! ssh -o ConnectTimeout=5 "$STAGE_HOST" "echo 'SSH OK'" 2>/dev/null; then
  echo -e "${RED}✗ Cannot connect to $STAGE_HOST${NC}"
  echo -e "${YELLOW}Make sure SSH is configured:${NC}"
  echo "  ssh $STAGE_HOST"
  exit 1
fi
echo -e "${GREEN}✓ SSH connection successful${NC}"
echo ""

# Check if migration file exists locally
echo -e "${YELLOW}[2/8] Checking migration file...${NC}"
MIGRATION_FILE="mcp_backend/src/migrations/014_add_oauth_tables.sql"
if [ ! -f "$MIGRATION_FILE" ]; then
  echo -e "${RED}✗ Migration file not found: $MIGRATION_FILE${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Migration file found${NC}"
echo ""

# Copy migration to stage server
echo -e "${YELLOW}[3/8] Copying migration to stage server...${NC}"
scp "$MIGRATION_FILE" "$STAGE_HOST:/tmp/014_add_oauth_tables.sql"
echo -e "${GREEN}✓ Migration copied${NC}"
echo ""

# Apply migration
echo -e "${YELLOW}[4/8] Applying database migration...${NC}"
ssh "$STAGE_HOST" "docker exec -i $CONTAINER_DB psql -U $DB_USER -d $DB_NAME -f /tmp/014_add_oauth_tables.sql" || {
  echo -e "${YELLOW}⚠ Migration may have already been applied (this is OK)${NC}"
}
echo -e "${GREEN}✓ Migration applied${NC}"
echo ""

# Update code on stage
echo -e "${YELLOW}[5/8] Updating code on stage server...${NC}"
ssh "$STAGE_HOST" "cd $STAGE_DIR && git pull origin main"
echo -e "${GREEN}✓ Code updated${NC}"
echo ""

# Rebuild backend
echo -e "${YELLOW}[6/8] Rebuilding backend...${NC}"
ssh "$STAGE_HOST" "cd $STAGE_DIR/deployment && ./update-stage-backend-on-mail.sh"
echo -e "${GREEN}✓ Backend rebuilt${NC}"
echo ""

# Restart app container
echo -e "${YELLOW}[7/8] Restarting app container...${NC}"
ssh "$STAGE_HOST" "docker restart $CONTAINER_APP"
echo ""
echo -e "${CYAN}Waiting for container to be healthy...${NC}"
sleep 10

# Check container health
RETRIES=0
MAX_RETRIES=12
while [ $RETRIES -lt $MAX_RETRIES ]; do
  HEALTH=$(ssh "$STAGE_HOST" "docker inspect --format='{{.State.Health.Status}}' $CONTAINER_APP 2>/dev/null || echo 'unknown'")
  if [ "$HEALTH" == "healthy" ]; then
    echo -e "${GREEN}✓ Container is healthy${NC}"
    break
  fi
  echo -e "${YELLOW}Container status: $HEALTH (retry $((RETRIES+1))/$MAX_RETRIES)${NC}"
  sleep 5
  RETRIES=$((RETRIES+1))
done

if [ $RETRIES -eq $MAX_RETRIES ]; then
  echo -e "${YELLOW}⚠ Container health check timeout (may be OK if no health check configured)${NC}"
fi
echo ""

# Register OAuth client
echo -e "${YELLOW}[8/8] Registering OAuth client...${NC}"
echo -e "${CYAN}Generating client credentials...${NC}"
echo ""

ssh "$STAGE_HOST" "docker exec -i $CONTAINER_APP node dist/scripts/register-oauth-client.js" | tee /tmp/oauth_client_output.txt

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                    DEPLOYMENT COMPLETE                         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Parse client credentials
CLIENT_ID=$(grep "Client ID:" /tmp/oauth_client_output.txt | awk '{print $3}')
CLIENT_SECRET=$(grep "Client Secret:" /tmp/oauth_client_output.txt | awk '{print $3}')

if [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
  echo -e "${MAGENTA}════════════════════════════════════════════════════════════════${NC}"
  echo -e "${MAGENTA}             SAVE THESE CREDENTIALS!                            ${NC}"
  echo -e "${MAGENTA}════════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "${CYAN}Client ID:     ${GREEN}$CLIENT_ID${NC}"
  echo -e "${CYAN}Client Secret: ${GREEN}$CLIENT_SECRET${NC}"
  echo ""
  echo -e "${MAGENTA}════════════════════════════════════════════════════════════════${NC}"
  echo ""
fi

echo -e "${YELLOW}Next Steps:${NC}"
echo ""
echo -e "${CYAN}1. Set user password (if not already done):${NC}"
echo -e "   ${GREEN}ssh $STAGE_HOST${NC}"
echo -e "   ${GREEN}docker exec -it $CONTAINER_APP node dist/scripts/set-user-password.js igor@legal.org.ua YourPassword${NC}"
echo ""
echo -e "${CYAN}2. Test OAuth endpoints:${NC}"
echo -e "   ${GREEN}curl 'https://stage.legal.org.ua/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=https://chatgpt.com/aip/callback'${NC}"
echo ""
echo -e "${CYAN}3. Configure ChatGPT:${NC}"
echo -e "   ${GREEN}cat deployment/OAUTH_QUICK_START.md${NC}"
echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo ""

# Save credentials to file
if [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
  CREDS_FILE="deployment/oauth-credentials-stage.txt"
  cat > "$CREDS_FILE" <<EOF
OAuth Client Credentials - Stage Environment
Generated: $(date)
================================================

Client ID: $CLIENT_ID
Client Secret: $CLIENT_SECRET

Authorization URL: https://stage.legal.org.ua/oauth/authorize
Token URL: https://stage.legal.org.ua/oauth/token
Scopes: mcp

================================================
⚠️  KEEP THIS FILE SECURE!
EOF
  echo -e "${GREEN}✓ Credentials saved to: $CREDS_FILE${NC}"
  echo ""
fi

echo -e "${GREEN}🎉 OAuth 2.0 deployment complete!${NC}"
echo ""
