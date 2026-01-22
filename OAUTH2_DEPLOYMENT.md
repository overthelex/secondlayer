***REMOVED***2 Deployment Guide for legal.org.ua

## Overview

This guide covers the deployment of Google OAuth2 authentication for the SecondLayer admin panel at https://legal.org.ua/.

## Pre-Deployment Checklist

### 1. Google Cloud Console Setup

1. **Navigate to Google Cloud Console**: https://console.cloud.google.com/
2. **Select your project** or create a new one
3. **Enable Google+ API**:
   - Go to "APIs & Services" → "Library"
   - Search for "Google+ API"
   - Click "Enable"

4. **Configure OAuth Consent Screen**:
   - Go to "APIs & Services" → "OAuth consent screen"
   - User Type: External (or Internal for workspace)
   - App name: "SecondLayer Legal Analysis"
   - User support email: your-email@domain.com
   - Developer contact: your-email@domain.com
   - Scopes: email, profile, openid (default)
   - Test users: Add your email for testing

5. **Create OAuth2 Credentials**:
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "OAuth client ID"
   - Application type: Web application
   - Name: "SecondLayer Production"

   **Authorized JavaScript origins**:
   ```
   https://legal.org.ua
   ```

   **Authorized redirect URIs**:
   ```
   https://legal.org.ua/auth/google/callback
   ```

   - Click "Create"
   - **SAVE** your Client ID and Client Secret

### 2. Environment Variables

The following credentials from `google_OAUTH2.json` should be configured on the gate server:

```bash
# From google_OAUTH2.json
GOOGLE_CLIENT_ID=REDACTED_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=REDACTED_GOOGLE_CLIENT_SECRET

# Production URLs
GOOGLE_CALLBACK_URL=https://legal.org.ua/auth/google/callback
FRONTEND_URL=https://legal.org.ua
ALLOWED_ORIGINS=https://legal.org.ua

# Generate this with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=357812b0f609a923e6bf7794647fef274dd0efe1604e45267fd4492ee8e2a5fc

# Keep existing API keys for MCP clients
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456,REDACTED_SL_KEY_LOCAL
```

## Deployment Steps

### Option 1: Automated Deployment (Recommended)

1. **Build both frontend and backend locally**:
   ```bash
   # From SecondLayer root directory
   cd mcp_backend && npm run build && cd ..
   cd frontend && npm run build && cd ..
   ```

2. **Run the deployment script**:
   ```bash
   ./deploy-to-gate.sh
   ```

3. **Follow the prompts** to complete deployment

### Option 2: Manual Deployment

#### Step 1: Build Locally

```bash
cd /Users/vovkes/ZOMCP/SecondLayer

# Build backend
cd mcp_backend
npm install
npm run build

# Build frontend
cd ../frontend
npm install
npm run build
cd ..
```

#### Step 2: Deploy to Gate Server

```bash
GATE_SERVER="gate.lexapp.co.ua"
REMOTE_PATH="/root/SecondLayer"

# Sync backend
rsync -avz --delete \
    --exclude='node_modules' \
    --exclude='.env' \
    --exclude='logs' \
    mcp_backend/ root@${GATE_SERVER}:${REMOTE_PATH}/mcp_backend/

# Sync frontend
rsync -avz --delete \
    frontend/dist/ root@${GATE_SERVER}:${REMOTE_PATH}/frontend/dist/

# Deploy nginx config
scp mcp_backend/nginx-mcp.legal.org.ua.conf \
    root@${GATE_SERVER}:/etc/nginx/sites-available/legal.org.ua
```

#### Step 3: Configure on Gate Server

```bash
ssh root@gate.lexapp.co.ua
```

**3a. Install backend dependencies**:
```bash
cd /root/SecondLayer/mcp_backend
npm install --production
```

**3b. Update .env file**:
```bash
nano /root/SecondLayer/mcp_backend/.env
```

Add/update these lines:
```bash
GOOGLE_CLIENT_ID=REDACTED_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=REDACTED_GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL=https://legal.org.ua/auth/google/callback
FRONTEND_URL=https://legal.org.ua
ALLOWED_ORIGINS=https://legal.org.ua
JWT_SECRET=357812b0f609a923e6bf7794647fef274dd0efe1604e45267fd4492ee8e2a5fc
```

**3c. Run database migration**:
```bash
cd /root/SecondLayer/mcp_backend

PGPASSWORD=jyGJHGFJHgjgjhGVJHGJHg765 \
psql -h localhost -U secondlayer -d secondlayer_db \
< src/migrations/006_add_users_table.sql
```

Expected output:
```
CREATE TABLE
CREATE INDEX
CREATE INDEX
CREATE TABLE
...
```

**3d. Configure nginx**:
```bash
# Create symlink
ln -sf /etc/nginx/sites-available/legal.org.ua /etc/nginx/sites-enabled/legal.org.ua

# Test configuration
nginx -t

# Reload nginx
systemctl reload nginx
```

**3e. Restart backend**:
```bash
cd /root/SecondLayer/mcp_backend

# If using PM2
pm2 restart secondlayer
# OR start new process if not exists
pm2 start dist/http-server.js --name secondlayer
pm2 save
```

#### Step 4: Verify Deployment

```bash
# Test health endpoint
curl https://legal.org.ua/health

# Expected response:
# {"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}

# Check OAuth routes exist
curl -I https://legal.org.ua/auth/google
# Should redirect to Google (HTTP 302)

# Check backend logs
pm2 logs secondlayer
```

## Post-Deployment Verification

### 1. Test OAuth Flow

1. **Open browser**: https://legal.org.ua/
2. **Should redirect to**: https://legal.org.ua/login
3. **Click "Sign in with Google"**
4. **Google login page** should appear
5. **After successful login**: Should redirect back to dashboard
6. **Verify**: User info appears in header

### 2. Test Protected Routes

```bash
# Without token - should return 401
curl -I https://legal.org.ua/api/documents

# With token - should return 200
curl -H "Authorization: Bearer <jwt-token>" \
    https://legal.org.ua/api/documents
```

### 3. Test API Key (MCP Clients)

```bash
# API keys should still work
curl -H "Authorization: Bearer test-key-123" \
    https://legal.org.ua/api/tools
```

## Troubleshooting

### OAuth Redirect Error

**Symptom**: "Error 400: redirect_uri_mismatch"

**Solution**:
1. Check Google Cloud Console redirect URIs
2. Ensure `https://legal.org.ua/auth/google/callback` is added
3. No trailing slash
4. Exact match required

### Token Expired on Login

**Symptom**: "Token expired" immediately after login

**Solution**:
1. Check server time: `date` on gate server
2. Sync time if needed: `ntpdate pool.ntp.org`
3. Verify JWT_SECRET is set correctly

### 401 Unauthorized on Protected Routes

**Symptom**: Cannot access /api/documents after login

**Solution**:
1. Check browser localStorage for `secondlayer_auth_token`
2. Verify token is being sent in Authorization header
3. Check backend logs for authentication errors

### Database Connection Error

**Symptom**: "Connection refused" to PostgreSQL

**Solution**:
```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# Or systemctl
systemctl status postgresql

# Verify connection
PGPASSWORD=jyGJHGFJHgjgjhGVJHGJHg765 \
psql -h localhost -U secondlayer -d secondlayer_db -c "SELECT version();"
```

### Nginx 502 Bad Gateway

**Symptom**: Nginx returns 502 error

**Solution**:
```bash
# Check if backend is running
pm2 status

# Check backend health directly
curl http://localhost:3000/health

# View backend logs
pm2 logs secondlayer --lines 50

# Restart backend
pm2 restart secondlayer
```

## Rollback Procedure

If deployment fails, rollback to previous version:

```bash
ssh root@gate.lexapp.co.ua

# Restore from backup
BACKUP_DIR=$(ls -td /root/SecondLayer_backup_* | head -1)
rm -rf /root/SecondLayer
mv "$BACKUP_DIR" /root/SecondLayer

# Restart services
pm2 restart secondlayer
systemctl reload nginx
```

## Monitoring

### Check Logs

```bash
# Backend logs
pm2 logs secondlayer

# Nginx access logs
tail -f /var/log/nginx/legal.org.ua.access.log

# Nginx error logs
tail -f /var/log/nginx/legal.org.ua.error.log
```

### Database

```bash
# Check users table
PGPASSWORD=jyGJHGFJHgjgjhGVJHGJHg765 \
psql -h localhost -U secondlayer -d secondlayer_db \
-c "SELECT id, email, name, last_login FROM users;"

# Check sessions
PGPASSWORD=jyGJHGFJHgjgjhGVJHGJHg765 \
psql -h localhost -U secondlayer -d secondlayer_db \
-c "SELECT user_id, expires_at, created_at FROM user_sessions WHERE expires_at > NOW();"
```

## Security Considerations

1. **JWT_SECRET**: Never commit to git, use strong random value
2. **HTTPS Only**: OAuth2 requires HTTPS in production
3. **CORS**: Restrict to production domain only
4. **API Keys**: Keep separate from JWT authentication
5. **Session Cleanup**: Consider cron job to delete expired sessions:

```bash
# Add to crontab
0 2 * * * PGPASSWORD=jyGJHGFJHgjgjhGVJHGJHg765 psql -h localhost -U secondlayer -d secondlayer_db -c "DELETE FROM user_sessions WHERE expires_at < NOW();"
```

## Support

For issues or questions:
- Check logs: `pm2 logs secondlayer`
- Verify environment: `pm2 env secondlayer`
- Database status: `docker ps | grep postgres` or `systemctl status postgresql`
- Google OAuth setup: https://console.cloud.google.com/

## Files Created/Modified

### Backend (mcp_backend/)
- ✅ `src/migrations/006_add_users_table.sql` - Database schema
- ✅ `src/services/user-service.ts` - User management
- ✅ `src/config/passport.ts` - OAuth2 strategy
- ✅ `src/controllers/auth.ts` - Auth handlers
- ✅ `src/routes/auth.ts` - Auth endpoints
- ✅ `src/middleware/dual-auth.ts` - JWT + API key auth
- ✅ `src/http-server.ts` - Server configuration
- ✅ `.env` - Environment variables
- ✅ `nginx-mcp.legal.org.ua.conf` - Nginx config

### Frontend (frontend/)
- ✅ `src/utils/token-storage.ts` - Token management
- ✅ `src/contexts/AuthContext.tsx` - Auth state
- ✅ `src/pages/auth/Login.tsx` - Login page
- ✅ `src/providers/auth-provider.ts` - Refine integration
- ✅ `src/providers/data-provider.ts` - API client
- ✅ `src/App.tsx` - App configuration
- ✅ `.env` - Frontend config

### Root
- ✅ `deploy-to-gate.sh` - Deployment script
- ✅ `OAUTH2_DEPLOYMENT.md` - This guide
