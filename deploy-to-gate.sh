#!/bin/bash

##############################################################################
# SecondLayer OAuth2 Deployment Script for gate-server (legal.org.ua)
##############################################################################

set -e  # Exit on error

echo "🚀 SecondLayer OAuth2 Deployment to gate-server"
echo "============================================"

# Configuration
GATE_SERVER="gate-server"
GATE_USER="root"  # Update this if needed
REMOTE_PATH="/root/SecondLayer"  # Update this based on server location
LOCAL_PATH="/Users/vovkes/ZOMCP/SecondLayer"

echo ""
echo "📋 Pre-deployment checks..."

# Check if we're in the right directory
if [ ! -f "mcp_backend/package.json" ]; then
    echo "❌ Error: Run this script from the SecondLayer root directory"
    exit 1
fi

# Check if frontend is built
if [ ! -d "frontend/dist" ]; then
    echo "❌ Error: Frontend not built. Run 'cd frontend && npm run build' first"
    exit 1
fi

# Check if backend is built
if [ ! -d "mcp_backend/dist" ]; then
    echo "❌ Error: Backend not built. Run 'cd mcp_backend && npm run build' first"
    exit 1
fi

echo "✓ Pre-deployment checks passed"

# Step 1: Create backup on gate server
echo ""
echo "📦 Step 1: Creating backup on gate server..."
ssh ${GATE_USER}@${GATE_SERVER} << 'ENDSSH'
    if [ -d /root/SecondLayer ]; then
        BACKUP_DIR="/root/SecondLayer_backup_$(date +%Y%m%d_%H%M%S)"
        echo "Creating backup at $BACKUP_DIR"
        cp -r /root/SecondLayer "$BACKUP_DIR"
        echo "✓ Backup created"
    else
        echo "⚠ No existing installation found, skipping backup"
    fi
ENDSSH

# Step 2: Deploy backend
echo ""
echo "📤 Step 2: Deploying backend..."
echo "Syncing backend files..."
rsync -avz --delete \
    --exclude='node_modules' \
    --exclude='.env' \
    --exclude='logs' \
    mcp_backend/ ${GATE_USER}@${GATE_SERVER}:${REMOTE_PATH}/mcp_backend/

echo "✓ Backend files synced"

# Step 3: Deploy frontend
echo ""
echo "📤 Step 3: Deploying frontend..."
echo "Syncing frontend build..."
rsync -avz --delete \
    frontend/dist/ ${GATE_USER}@${GATE_SERVER}:${REMOTE_PATH}/frontend/dist/

echo "✓ Frontend files synced"

# Step 4: Deploy nginx configuration
echo ""
echo "📤 Step 4: Deploying nginx configuration..."
scp mcp_backend/nginx-mcp.legal.org.ua.conf \
    ${GATE_USER}@${GATE_SERVER}:/etc/nginx/sites-available/legal.org.ua

echo "✓ Nginx config uploaded"

# Step 5: Run database migration and setup on gate server
echo ""
echo "🗄️  Step 5: Running database migration..."
ssh ${GATE_USER}@${GATE_SERVER} << 'ENDSSH'
    cd /root/SecondLayer/mcp_backend

    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        echo "Installing backend dependencies..."
        npm install --production
    fi

    # Run user table migration
    echo "Running users table migration..."
    PGPASSWORD=${POSTGRES_PASSWORD:-jyGJHGFJHgjgjhGVJHGJHg765} \
    psql -h localhost -U secondlayer -d secondlayer_db < src/migrations/006_add_users_table.sql \
    && echo "✓ Migration completed" || echo "⚠ Migration may have already been applied"
ENDSSH

# Step 6: Update environment variables on gate server
echo ""
echo "⚙️  Step 6: Updating environment variables..."
echo "⚠ MANUAL STEP REQUIRED:"
echo "  SSH to gate server and update ${REMOTE_PATH}/mcp_backend/.env with:"
echo "  - GOOGLE_CALLBACK_URL=https://legal.org.ua/auth/google/callback"
echo "  - FRONTEND_URL=https://legal.org.ua"
echo "  - ALLOWED_ORIGINS=https://legal.org.ua"
echo "  - JWT_SECRET=<generated-secret> (if not set)"
echo ""
read -p "Press Enter when .env is updated, or Ctrl+C to abort..."

# Step 7: Restart services
echo ""
echo "🔄 Step 7: Restarting services..."
ssh ${GATE_USER}@${GATE_SERVER} << 'ENDSSH'
    # Enable nginx site
    ln -sf /etc/nginx/sites-available/legal.org.ua /etc/nginx/sites-enabled/legal.org.ua

    # Test nginx config
    nginx -t && echo "✓ Nginx config valid" || exit 1

    # Reload nginx
    systemctl reload nginx && echo "✓ Nginx reloaded"

    # Restart backend (assuming PM2)
    cd /root/SecondLayer/mcp_backend

    # Check if PM2 process exists
    if pm2 list | grep -q secondlayer; then
        echo "Restarting existing PM2 process..."
        pm2 restart secondlayer
    else
        echo "Starting new PM2 process..."
        pm2 start dist/http-server.js --name secondlayer
        pm2 save
    fi

    echo "✓ Backend restarted"
ENDSSH

# Step 8: Verify deployment
echo ""
echo "✅ Step 8: Verifying deployment..."
echo "Testing health endpoint..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" https://legal.org.ua/health)

if [ "$HTTP_CODE" = "200" ]; then
    echo "✓ Health check passed (HTTP $HTTP_CODE)"
else
    echo "⚠ Health check returned HTTP $HTTP_CODE"
fi

echo ""
echo "============================================"
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "  1. Update Google Cloud Console OAuth redirect URIs:"
echo "     - https://legal.org.ua/auth/google/callback"
echo "  2. Test login at: https://legal.org.ua/"
echo "  3. Verify OAuth flow works"
echo "  4. Check backend logs: ssh ${GATE_USER}@${GATE_SERVER} 'pm2 logs secondlayer'"
echo ""
echo "🔍 Useful commands:"
echo "  - Check status: ssh ${GATE_USER}@${GATE_SERVER} 'pm2 status'"
echo "  - View logs: ssh ${GATE_USER}@${GATE_SERVER} 'pm2 logs secondlayer'"
echo "  - Restart: ssh ${GATE_USER}@${GATE_SERVER} 'pm2 restart secondlayer'"
echo "  - Nginx logs: ssh ${GATE_USER}@${GATE_SERVER} 'tail -f /var/log/nginx/legal.org.ua.*.log'"
echo ""
