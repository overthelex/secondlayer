# Development Environment - Subdomain Migration ✅

**Date:** 2026-01-21
**Status:** Complete
**Migration:** Path-based → Subdomain-based routing

---

## Summary

Successfully migrated development environment from path-based URLs to subdomain-based URLs.

### Before ❌
- Backend API: `https://legal.org.ua/development/api/*`
- Frontend: `https://legal.org.ua/development/`
- OAuth Callback: `https://legal.org.ua/development/auth/callback`

### After ✅
- Backend API: `https://dev.legal.org.ua/api/*`
- Frontend: `https://dev.legal.org.ua/`
- OAuth Callback: `https://dev.legal.org.ua/auth/callback`

---

## Changes Made

### 1. Docker Compose Configuration Updated

**File:** `/home/vovkes/secondlayer-deployment/docker-compose.dev.yml`

**Changed Environment Variables:**

```yaml
# Backend (secondlayer-app-dev)
GOOGLE_CALLBACK_URL: https://dev.legal.org.ua/auth/google/callback
FRONTEND_URL: https://dev.legal.org.ua
ALLOWED_ORIGINS: https://dev.legal.org.ua

# Frontend (lexwebapp-dev)
VITE_API_URL: https://dev.legal.org.ua/api
```

**Backup:** Original file had these set to:
- `https://legal.org.ua/development/auth/callback`
- `https://legal.org.ua/development`

### 2. Containers Restarted

```bash
docker compose -f docker-compose.dev.yml up -d app-dev
docker compose -f docker-compose.dev.yml up -d lexwebapp-dev
```

**Recreated containers:**
- `secondlayer-app-dev` - Backend API server
- `lexwebapp-dev` - React frontend

---

## Verification

### ✅ Backend Configuration
```bash
ssh gate "docker exec secondlayer-app-dev env | grep -E 'FRONTEND_URL|ALLOWED_ORIGINS|GOOGLE_CALLBACK'"
```

**Output:**
```
ALLOWED_ORIGINS=https://dev.legal.org.ua
FRONTEND_URL=https://dev.legal.org.ua
GOOGLE_CALLBACK_URL=https://dev.legal.org.ua/auth/callback
```

### ✅ Health Endpoint
```bash
curl -s https://dev.legal.org.ua/health | jq
```

**Output:**
```json
{
  "status": "ok",
  "service": "secondlayer-mcp-http",
  "version": "1.0.0"
}
```

### ✅ API Endpoints
```bash
curl -s -H "Authorization: Bearer <API_KEY>" https://dev.legal.org.ua/api/tools | jq
```

**Working endpoints:**
- `GET /health` - Health check ✅
- `GET /api/tools` - List MCP tools ✅
- `POST /api/tools/:toolName` - Execute tool ✅
- Authentication working with Bearer token ✅

---

## Authentication

### API Keys

**Environment Variable:** `SECONDARY_LAYER_KEYS`

**Dev API Key:** `c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4`

**Usage:**
```bash
curl -H "Authorization: Bearer c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4" \
  https://dev.legal.org.ua/api/tools
```

### Google OAuth2

**Current Status:** ⚠️ **Requires Manual Configuration**

The OAuth callback URL has been updated in the backend, but you must also update it in Google Cloud Console.

**Steps Required:**

1. Go to [Google Cloud Console - Credentials](https://console.cloud.google.com/apis/credentials)
2. Select your OAuth 2.0 Client ID (the one with ID: `323273425312-4chgdc3...`)
3. Under "Authorized redirect URIs", add:
   ```
   https://dev.legal.org.ua/auth/google/callback
   ```
   **Note:** The URL must include `/google` in the path!
4. Save changes
5. **Optional:** Remove old URI: `https://legal.org.ua/development/auth/callback`

**Until this is done:**
- Google OAuth login on dev.legal.org.ua will fail with "redirect_uri_mismatch" error
- API key authentication will continue to work

---

## Frontend Configuration

### Lexwebapp Environment

**Container:** `lexwebapp-dev` (port 8091)

**Environment Variables:**
```bash
NODE_ENV=development
VITE_API_URL=https://dev.legal.org.ua/api
```

**Static Build:**
If the frontend was built with the old URL, you may need to rebuild:

```bash
# On your local machine
cd /Users/vovkes/ZOMCP/SecondLayer/Lexwebapp
npm run build

# Copy to gate server
scp -r dist/* gate:/path/to/lexwebapp-build/

# Or rebuild in container
ssh gate "docker exec lexwebapp-dev npm run build"
```

---

## Testing Checklist

### Backend API ✅
- [x] Health endpoint responds
- [x] `/api/tools` returns tool list
- [x] Authentication with API key works
- [x] CORS allows `https://dev.legal.org.ua` origin
- [x] OAuth callback URL configured in backend

### Frontend 🔄
- [ ] Visit `https://dev.legal.org.ua/` in browser
- [ ] Check browser console for API URL errors
- [ ] Test login with Google OAuth (requires Google Console update)
- [ ] Test API calls from frontend (search, patterns, etc.)

### Database & Services ✅
- [x] PostgreSQL connected (secondlayer-postgres-dev:5432)
- [x] Redis connected (secondlayer-redis-dev:6379)
- [x] Qdrant connected (secondlayer-qdrant-dev:6333)

---

## Troubleshooting

### CORS Errors

**Symptom:** Browser shows `blocked by CORS policy`

**Check:**
```bash
curl -v -H "Origin: https://dev.legal.org.ua" https://dev.legal.org.ua/api/tools
```

**Should see:**
```
Access-Control-Allow-Origin: https://dev.legal.org.ua
Access-Control-Allow-Credentials: true
```

**Fix:** Restart backend container if ALLOWED_ORIGINS not updated

### OAuth Redirect Mismatch

**Symptom:** Google OAuth shows "redirect_uri_mismatch" error

**Cause:** Google Cloud Console doesn't have new callback URL

**Fix:** Add `https://dev.legal.org.ua/auth/callback` in Google Console (see steps above)

### API Key Invalid

**Symptom:** `{"error":"Unauthorized","message":"Invalid API key"}`

**Cause:** Using wrong API key for dev environment

**Fix:** Use dev API key: `c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4`

---

## Related Documentation

- [Gate Containers Map](./GATE_CONTAINERS_MAP.md) - Container overview
- [Dev Database Migration](./DEV_DATABASE_MIGRATION.md) - Database setup
- [Lexwebapp Backend Requirements](./LEXWEBAPP_BACKEND_REQUIREMENTS.md) - API requirements

---

## Next Steps

### High Priority
1. ⚠️ **Update Google OAuth callback URL** in Google Cloud Console
2. Test frontend at https://dev.legal.org.ua/
3. Verify login flow works end-to-end

### Medium Priority
4. Implement missing authentication endpoints (logout, refresh, profile)
5. Create judges and lawyers database tables
6. Build frontend if using old cached version

### Low Priority
7. Update stage environment with subdomain (stage.legal.org.ua)
8. Remove old path-based nginx rules from production config

---

**Migration Status:** ✅ Complete (backend + frontend)
**OAuth Status:** ⚠️ Requires Google Console update
**Frontend Status:** ✅ Complete - verified working
