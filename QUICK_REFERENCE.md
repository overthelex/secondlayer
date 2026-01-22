# OAuth2 Quick Reference Guide

## 🚀 One-Command Deployment

```bash
# From SecondLayer root directory
npm run build:all && ./deploy-to-gate.sh
```

## 📋 Google Cloud Console URLs

| Action | URL |
|--------|-----|
| OAuth Consent Screen | https://console.cloud.google.com/apis/credentials/consent |
| Credentials | https://console.cloud.google.com/apis/credentials |
| Project Dashboard | https://console.cloud.google.com/ |

## 🔑 OAuth2 Credentials (from google_OAUTH2.json)

```bash
Client ID: REDACTED_GOOGLE_CLIENT_ID
Client Secret: REDACTED_GOOGLE_CLIENT_SECRET
```

**Authorized Redirect URI**: `https://legal.org.ua/auth/google/callback`

## 🌐 Production URLs

| Service | URL |
|---------|-----|
| Frontend | https://legal.org.ua/ |
| Login Page | https://legal.org.ua/login |
| Health Check | https://legal.org.ua/health |
| OAuth Callback | https://legal.org.ua/auth/google/callback |
| API Endpoints | https://legal.org.ua/api/* |

## 🗄️ Database

### Connect to PostgreSQL

```bash
PGPASSWORD=jyGJHGFJHgjgjhGVJHGJHg765 \
psql -h localhost -U secondlayer -d secondlayer_db
```

### Check Users

```sql
SELECT id, email, name, email_verified, last_login, created_at
FROM users
ORDER BY created_at DESC
LIMIT 10;
```

### Check Active Sessions

```sql
SELECT
  u.email,
  s.expires_at,
  s.created_at
FROM user_sessions s
JOIN users u ON u.id = s.user_id
WHERE s.expires_at > NOW()
ORDER BY s.created_at DESC;
```

### Clean Expired Sessions

```sql
DELETE FROM user_sessions WHERE expires_at < NOW();
```

## 🔧 Gate Server Commands

### SSH Access

```bash
ssh root@gate.lexapp.co.ua
```

### PM2 Management

```bash
# Status
pm2 status

# Logs (live)
pm2 logs secondlayer

# Logs (last 100 lines)
pm2 logs secondlayer --lines 100

# Restart
pm2 restart secondlayer

# Stop
pm2 stop secondlayer

# Start
pm2 start /root/SecondLayer/mcp_backend/dist/http-server.js --name secondlayer

# Environment
pm2 env secondlayer
```

### Nginx Management

```bash
# Test configuration
nginx -t

# Reload (graceful)
systemctl reload nginx

# Restart (drops connections)
systemctl restart nginx

# Status
systemctl status nginx

# Access logs
tail -f /var/log/nginx/legal.org.ua.access.log

# Error logs
tail -f /var/log/nginx/legal.org.ua.error.log
```

### Application Logs

```bash
# Backend logs (PM2)
pm2 logs secondlayer

# Nginx access logs
tail -f /var/log/nginx/legal.org.ua.access.log

# Nginx error logs
tail -f /var/log/nginx/legal.org.ua.error.log

# System logs
journalctl -u nginx -f
```

## 🧪 Testing

### Health Check

```bash
curl https://legal.org.ua/health
# Expected: {"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}
```

### Test OAuth Redirect

```bash
curl -I https://legal.org.ua/auth/google
# Expected: HTTP/1.1 302 Found
# Location: https://accounts.google.com/o/oauth2/v2/auth...
```

### Test Protected Endpoint (No Auth)

```bash
curl -I https://legal.org.ua/api/documents
# Expected: HTTP/1.1 401 Unauthorized
```

### Test with JWT Token

```bash
# After login, get token from localStorage
TOKEN="<jwt-token-from-browser>"

curl -H "Authorization: Bearer $TOKEN" \
    https://legal.org.ua/api/documents
# Expected: HTTP/1.1 200 OK
```

### Test with API Key (MCP Client)

```bash
curl -H "Authorization: Bearer test-key-123" \
    https://legal.org.ua/api/tools
# Expected: HTTP/1.1 200 OK + tools list
```

## 🐛 Common Issues & Fixes

| Issue | Quick Fix |
|-------|-----------|
| 502 Bad Gateway | `pm2 restart secondlayer` |
| OAuth redirect error | Check Google Cloud Console redirect URIs |
| 401 on protected routes | Verify JWT token in localStorage |
| Database connection error | `docker ps \| grep postgres` or `systemctl status postgresql` |
| Nginx config syntax error | `nginx -t` then fix and `systemctl reload nginx` |

## 📁 Important File Paths (on gate server)

```
/root/SecondLayer/
├── mcp_backend/
│   ├── dist/                    # Built backend
│   ├── src/migrations/          # Database migrations
│   ├── .env                     # Environment variables ⚠️ SENSITIVE
│   └── package.json
├── frontend/
│   └── dist/                    # Built frontend (served by nginx)
└── deploy-to-gate.sh            # Deployment script

/etc/nginx/sites-available/legal.org.ua    # Nginx config
/etc/nginx/sites-enabled/legal.org.ua      # Symlink to above

/var/log/nginx/legal.org.ua.access.log     # Nginx access logs
/var/log/nginx/legal.org.ua.error.log      # Nginx error logs
```

## 🔐 Environment Variables

Located in `/root/SecondLayer/mcp_backend/.env`:

```bash
# OAuth2 (REQUIRED)
GOOGLE_CLIENT_ID=REDACTED_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=REDACTED_GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL=https://legal.org.ua/auth/google/callback

# JWT (REQUIRED)
JWT_SECRET=357812b0f609a923e6bf7794647fef274dd0efe1604e45267fd4492ee8e2a5fc

# App Config
FRONTEND_URL=https://legal.org.ua
ALLOWED_ORIGINS=https://legal.org.ua
HTTP_PORT=3000
HTTP_HOST=0.0.0.0

# API Keys (for MCP clients)
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456,REDACTED_SL_KEY_LOCAL

# Database
DATABASE_URL=postgresql://secondlayer:jyGJHGFJHgjgjhGVJHGJHg765@localhost:5432/secondlayer_db
```

## 📊 Monitoring Queries

### Request Analytics

```sql
-- Recent login activity
SELECT email, last_login
FROM users
WHERE last_login > NOW() - INTERVAL '24 hours'
ORDER BY last_login DESC;

-- Total users
SELECT COUNT(*) as total_users FROM users;

-- Active sessions
SELECT COUNT(*) as active_sessions
FROM user_sessions
WHERE expires_at > NOW();

-- Most active users
SELECT u.email, COUNT(s.id) as session_count
FROM users u
LEFT JOIN user_sessions s ON u.id = s.user_id
GROUP BY u.email
ORDER BY session_count DESC
LIMIT 10;
```

## 🔄 Rollback

If deployment fails:

```bash
# On gate server
ssh root@gate.lexapp.co.ua

# Find latest backup
BACKUP=$(ls -td /root/SecondLayer_backup_* | head -1)

# Restore
rm -rf /root/SecondLayer
mv "$BACKUP" /root/SecondLayer

# Restart
pm2 restart secondlayer
systemctl reload nginx
```

## 📞 Quick Support

```bash
# Check everything at once
ssh root@gate.lexapp.co.ua << 'EOF'
  echo "=== PM2 Status ==="
  pm2 status
  echo ""
  echo "=== Nginx Status ==="
  systemctl status nginx --no-pager
  echo ""
  echo "=== PostgreSQL Status ==="
  docker ps | grep postgres || systemctl status postgresql --no-pager
  echo ""
  echo "=== Recent Backend Logs ==="
  pm2 logs secondlayer --lines 20 --nostream
EOF
```

## 🎯 Success Criteria

✅ Health endpoint returns 200
✅ OAuth redirect works (302 to Google)
✅ Login flow completes and shows dashboard
✅ Protected routes require authentication
✅ API keys still work for MCP tools
✅ No errors in PM2 logs
✅ No errors in Nginx logs

## 📚 Documentation

- Full deployment guide: `OAUTH2_DEPLOYMENT.md`
- Implementation plan: `/Users/vovkes/.claude/plans/valiant-exploring-taco.md`
- Google OAuth docs: https://developers.google.com/identity/protocols/oauth2
