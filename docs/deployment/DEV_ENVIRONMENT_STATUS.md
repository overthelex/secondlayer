# Development Environment - Status Report

**Date:** 2026-01-21 14:17 UTC
**Environment:** dev.legal.org.ua
**Status:** ✅ Fully Operational

---

## Summary

Development environment successfully migrated to subdomain-based routing and verified working end-to-end.

### Key URLs
- **Frontend:** https://dev.legal.org.ua/
- **Backend API:** https://dev.legal.org.ua/api/*
- **Health Endpoint:** https://dev.legal.org.ua/health

---

## Services Status

### Backend (secondlayer-app-dev)
| Component | Status | Details |
|-----------|--------|---------|
| Container | ✅ Running | Port 3003 |
| Database | ✅ Connected | PostgreSQL (port 5433) |
| Redis | ✅ Connected | Port 6380 |
| Qdrant | ✅ Connected | Port 6335 |
| API Endpoints | ✅ Working | 10 MCP tools available |
| Authentication | ✅ Working | Bearer token auth functional |
| OAuth Callback | ✅ Configured | `https://dev.legal.org.ua/auth/google/callback` |
| CORS | ✅ Configured | Allows `https://dev.legal.org.ua` |

**Environment Variables:**
```
ALLOWED_ORIGINS=https://dev.legal.org.ua
FRONTEND_URL=https://dev.legal.org.ua
GOOGLE_CALLBACK_URL=https://dev.legal.org.ua/auth/google/callback
```

### Frontend (lexwebapp-dev)
| Component | Status | Details |
|-----------|--------|---------|
| Container | ✅ Running | Port 8091 → 80 |
| API URL | ✅ Configured | `https://dev.legal.org.ua` |
| Build | ✅ Current | Built with `--mode development` |
| Static Assets | ✅ Serving | Nginx 1.25-alpine |
| Page Load | ✅ Working | Accessible via https |

**Docker Image:** `lexwebapp-lexwebapp:dev` (AMD64)

### Database (secondlayer-postgres-dev)
| Component | Status | Details |
|-----------|--------|---------|
| Container | ✅ Healthy | PostgreSQL 15-alpine |
| Port | ✅ Exposed | 5433:5432 |
| Tables | ✅ Created | 11 tables, 6 migrations applied |
| Data | ⚠️ Empty | Ready for testing |

---

## Verification Tests

### 1. Frontend Accessibility ✅
```bash
curl -s https://dev.legal.org.ua/ | grep "<title>"
# Output: <title>Legal.org.ua - Юридичний асистент</title>
```

### 2. Backend Health Check ✅
```bash
curl -s https://dev.legal.org.ua/health | jq
# Output:
{
  "status": "ok",
  "service": "secondlayer-mcp-http",
  "version": "1.0.0"
}
```

### 3. API Tools List ✅
```bash
curl -s -H "Authorization: Bearer REDACTED_SL_KEY_LOCAL" \
  https://dev.legal.org.ua/api/tools | jq '.tools | length'
# Output: 10
```

### 4. JavaScript API URL ✅
```bash
ssh gate "docker exec lexwebapp-dev sh -c 'cat /usr/share/nginx/html/assets/*.js' | \
  grep -o 'https://[a-z\.]*legal.org.ua' | sort -u"
# Output: https://dev.legal.org.ua
```

---

## Configuration Files

### Docker Compose
**File:** `/home/vovkes/secondlayer-deployment/docker-compose.dev.yml`

**Key Changes:**
- Backend: `GOOGLE_CALLBACK_URL`, `FRONTEND_URL`, `ALLOWED_ORIGINS` → `https://dev.legal.org.ua`
- Frontend: Image changed to `lexwebapp-lexwebapp:dev`

### Frontend Dockerfile
**File:** `/Users/vovkes/ZOMCP/SecondLayer/Lexwebapp/Dockerfile.dev`

**Build Command:** `npm run build -- --mode development`
- Automatically uses `.env.development` file
- Bakes `VITE_API_URL=https://dev.legal.org.ua` into JavaScript bundle

### Environment File
**File:** `/Users/vovkes/ZOMCP/SecondLayer/Lexwebapp/.env.development`

```env
VITE_API_URL=https://dev.legal.org.ua
VITE_API_KEY=YOUR_API_KEY
```

---

## Known Issues

### 1. Google OAuth ⚠️
**Status:** Backend configured, Google Console update needed
**Issue:** Google Cloud Console doesn't have `https://dev.legal.org.ua/auth/google/callback` in authorized redirect URIs
**Impact:** Google OAuth login will fail with "redirect_uri_mismatch"
**Resolution:** Add callback URL in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
**Workaround:** Use Bearer token authentication (fully functional)

### 2. Container Health Checks
**Status:** Minor warnings
**Details:**
- `secondlayer-app-dev`: Shows "unhealthy" but service is responding
- `secondlayer-qdrant-dev`: Shows "unhealthy" but vector search works

**Resolution:** Health check configuration may need adjustment, but services are functional

---

## API Keys

### Development API Key
```
REDACTED_SL_KEY_LOCAL
```

**Usage:**
```bash
curl -H "Authorization: Bearer REDACTED_SL_KEY_LOCAL" \
  https://dev.legal.org.ua/api/tools
```

---

## Container Details

| Container | Image | Status | Ports |
|-----------|-------|--------|-------|
| secondlayer-app-dev | secondlayer-app:latest | Running | 3003:3003 |
| secondlayer-postgres-dev | postgres:15-alpine | Healthy | 5433:5432 |
| secondlayer-redis-dev | redis:7-alpine | Healthy | 6380:6379 |
| secondlayer-qdrant-dev | qdrant/qdrant:latest | Running | 6335-6336:6333-6334 |
| lexwebapp-dev | lexwebapp-lexwebapp:dev | Running | 8091:80 |

---

## Next Steps

### Priority 1: Google OAuth Configuration
1. Go to [Google Cloud Console - Credentials](https://console.cloud.google.com/apis/credentials)
2. Edit OAuth 2.0 Client ID (`323273425312-4chgdc3...`)
3. Add to "Authorized redirect URIs":
   ```
   https://dev.legal.org.ua/auth/google/callback
   ```
   **Note:** Must include `/google` in the path!
4. Save changes
5. Test login at https://dev.legal.org.ua/

### Priority 2: Implement Missing Endpoints
See [Lexwebapp Backend Requirements](./LEXWEBAPP_BACKEND_REQUIREMENTS.md) for:
- Authentication: `/api/auth/logout`, `/api/auth/refresh`, `/api/auth/profile`
- Judges database: Tables + CRUD endpoints
- Lawyers database: Tables + CRUD endpoints

### Priority 3: Load Test Data
```bash
ssh gate "docker exec secondlayer-app-dev npm run seed:dev"
```

---

## Rollback Procedure

If issues occur, rollback to path-based routing:

1. Revert docker-compose.dev.yml:
   ```yaml
   GOOGLE_CALLBACK_URL: https://legal.org.ua/development/auth/callback
   FRONTEND_URL: https://legal.org.ua/development
   ALLOWED_ORIGINS: https://legal.org.ua
   ```

2. Use production frontend image:
   ```yaml
   image: lexwebapp-lexwebapp:latest
   ```

3. Restart containers:
   ```bash
   ssh gate "cd /home/vovkes/secondlayer-deployment && \
     docker compose -f docker-compose.dev.yml up -d"
   ```

---

## Related Documentation

- [Dev Subdomain Migration](./DEV_SUBDOMAIN_MIGRATION.md) - Complete migration guide
- [Gate Containers Map](./GATE_CONTAINERS_MAP.md) - Container overview
- [Dev Database Migration](./DEV_DATABASE_MIGRATION.md) - Database setup
- [Lexwebapp Backend Requirements](./LEXWEBAPP_BACKEND_REQUIREMENTS.md) - API requirements

---

**Environment:** ✅ Ready for Development
**Last Updated:** 2026-01-21 14:17 UTC
