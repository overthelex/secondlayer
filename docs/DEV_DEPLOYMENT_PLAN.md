# Dev Environment Deployment Plan

**Date:** 2026-02-06  
**Branch:** main  
**Commits to deploy:**
- 8c5b080 - Add comprehensive MCP client integration guide
- 9a3f7cb - Enforce mandatory authentication and add rate limiting

## Pre-Deployment Analysis

### Current manage-gateway.sh Script

**Status:** ✅ Script is well-structured and safe

**What deploy script does:**
1. **Sync code** - rsync source to gate server (excludes node_modules, dist, .git)
2. **SSH to server** and execute deployment:
   - Stop all dev containers
   - Remove exited/dead containers  
   - Prune old Docker images
   - Start infrastructure (postgres, redis, qdrant)
   - Wait 15 seconds for DB readiness
   - Run migrations (migrate-dev, migrate-openreyestr-dev)
   - Rebuild app images WITHOUT CACHE (--no-cache)
   - Start application (app-dev, lexwebapp-dev, app-openreyestr-dev)

**Services in dev environment:**

| Service | Container | Port | Status |
|---------|-----------|------|--------|
| PostgreSQL (backend) | secondlayer-postgres-dev | 5433 | Infrastructure |
| PostgreSQL (openreyestr) | openreyestr-postgres-dev | 5437 | Infrastructure |
| Redis | secondlayer-redis-dev | 6380 | Infrastructure |
| Qdrant | secondlayer-qdrant-dev | 6335-6336 | Infrastructure |
| Backend API | secondlayer-app-dev | 3003 | Application |
| Frontend | lexwebapp-dev | 8091 | Application |
| OpenReyestr | app-openreyestr-dev | 3005 | Application |

**NOT included in dev:** mcp_rada server (uses external URL)

## Changes Being Deployed

### 1. mcp_backend (app-dev container)
**Files changed:**
- `src/http-server.ts` - Required auth on SSE, rate limiting
- `src/middleware/rate-limit.ts` - NEW Redis-based rate limiter

**Impact:**
- 🔴 BREAKING: `/sse` and `/v1/sse` now require auth
- ✅ Rate limiting on `/health` (60/min), `/mcp` (30/min), webhooks (10/min)
- ✅ Better security and usage tracking

### 2. mcp_openreyestr (app-openreyestr-dev container)
**Files changed:**
- `src/http-server.ts` - Rate limiting on /health
- `src/middleware/rate-limit.ts` - NEW rate limiter

**Impact:**
- ✅ Rate limiting on `/health` (60/min)
- ✅ All tool endpoints already protected

### 3. mcp_rada (NOT in dev environment)
**Files changed:**
- `src/http-server.ts` - Rate limiting on /health  
- `src/middleware/rate-limit.ts` - NEW rate limiter

**Impact:** No impact on dev (uses external rada service)

## Deployment Steps

### Step 1: Pre-deployment Checks

```bash
cd /home/vovkes/SecondLayer/deployment

# Check .env.dev exists
ls -la .env.dev

# Verify gate server connectivity
ssh vovkes@gate.lexapp.co.ua "echo 'Connection OK'"

# Check current status on gate server
ssh vovkes@gate.lexapp.co.ua "cd /home/vovkes/secondlayer/deployment && docker ps --filter 'name=.*-dev'"
```

### Step 2: Deploy to Dev Environment

```bash
cd /home/vovkes/SecondLayer/deployment

# Deploy dev environment
./manage-gateway.sh deploy dev
```

**What happens:**
1. ✅ Code synced to gate server
2. ✅ Old containers stopped and removed
3. ✅ Old images pruned
4. ✅ Infrastructure started (postgres, redis, qdrant)
5. ✅ Migrations run
6. ✅ New images built with latest code (--no-cache)
7. ✅ Applications started

### Step 3: Verify Deployment

```bash
# Check container status
ssh vovkes@gate.lexapp.co.ua "cd /home/vovkes/secondlayer/deployment && docker compose -f docker-compose.dev.yml ps"

# Check logs
./manage-gateway.sh logs dev

# Health checks
curl https://dev.legal.org.ua/health
curl https://dev.legal.org.ua/mcp

# Test rate limiting (should return 429 after 60 requests)
for i in {1..65}; do
  curl -s https://dev.legal.org.ua/health | jq -r '.status' || echo "Request $i: Rate limited"
done
```

### Step 4: Test Authentication

```bash
# SSE endpoint without auth (should return 401)
curl -X POST https://dev.legal.org.ua/sse
# Expected: {"error":"Unauthorized","message":"Authorization header with Bearer token is required","code":"MISSING_AUTH"}

# SSE endpoint with auth (should work)
curl -X POST https://dev.legal.org.ua/sse \
  -H "Authorization: Bearer YOUR_DEV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Step 5: Smoke Tests

```bash
# Test main API endpoint
curl -X POST https://dev.legal.org.ua/api/tools/search_court_cases \
  -H "Authorization: Bearer YOUR_DEV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"contract","limit":3}'

# Test OpenReyestr
curl -X POST https://dev.legal.org.ua:3005/api/tools/search_by_edrpou \
  -H "Authorization: Bearer YOUR_DEV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"edrpou":"00000000"}'
```

## Rollback Plan

If issues occur:

### Option 1: Quick Rollback (Restart Previous Containers)

```bash
ssh vovkes@gate.lexapp.co.ua "cd /home/vovkes/secondlayer/deployment && \
  docker compose -f docker-compose.dev.yml down && \
  docker compose -f docker-compose.dev.yml up -d"
```

### Option 2: Git Revert

```bash
# On local machine
cd /home/vovkes/SecondLayer
git revert 9a3f7cb
git push origin main

# Then redeploy
cd deployment
./manage-gateway.sh deploy dev
```

### Option 3: Manual Container Management

```bash
ssh vovkes@gate.lexapp.co.ua

cd /home/vovkes/secondlayer/deployment

# Stop problematic containers
docker compose -f docker-compose.dev.yml stop app-dev

# Check logs
docker compose -f docker-compose.dev.yml logs app-dev

# Restart
docker compose -f docker-compose.dev.yml start app-dev
```

## Expected Downtime

- **Estimated:** 3-5 minutes
- **Services affected:** Dev environment only (dev.legal.org.ua)
- **Data loss:** None (volumes preserved)
- **Database:** Migrations run automatically

## Post-Deployment Monitoring

### Check Logs

```bash
# Live logs
./manage-gateway.sh logs dev

# Or SSH directly
ssh vovkes@gate.lexapp.co.ua "cd /home/vovkes/secondlayer/deployment && \
  docker compose -f docker-compose.dev.yml logs -f --tail=100 app-dev"
```

### Monitor Rate Limiting

```bash
# SSH to gate server
ssh vovkes@gate.lexapp.co.ua

# Connect to Redis
docker exec -it secondlayer-redis-dev redis-cli

# Check rate limit keys
KEYS ratelimit:*

# Check specific IP
GET ratelimit:health:1.2.3.4
TTL ratelimit:health:1.2.3.4
```

### Monitor Authentication

```bash
# Check for auth failures in logs
ssh vovkes@gate.lexapp.co.ua "cd /home/vovkes/secondlayer/deployment && \
  docker compose -f docker-compose.dev.yml logs app-dev | grep -i 'authentication failed'"
```

## Breaking Changes - Client Updates Needed

### LibreChat (if using dev environment)

Update `librechat.yaml`:
```yaml
mcpServers:
  secondlayer-dev:
    transport: sse
    endpoint: https://dev.legal.org.ua/v1/sse
    headers:
      Authorization: "Bearer ${SECONDLAYER_DEV_KEY}"  # NOW REQUIRED
```

### Custom Scripts

Add Authorization header:
```javascript
fetch('https://dev.legal.org.ua/sse', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.SECONDLAYER_DEV_KEY}`  // REQUIRED
  }
})
```

## Success Criteria

- ✅ All containers running (docker ps shows healthy)
- ✅ Health endpoints responding (200 OK)
- ✅ Rate limiting working (429 after limit)
- ✅ Authentication required on SSE (401 without token)
- ✅ Authentication working (200 with valid token)
- ✅ Main API tools functioning
- ✅ No errors in logs

## Timeline

1. **T+0min:** Start deployment (`./manage-gateway.sh deploy dev`)
2. **T+2min:** Containers stopped, images rebuilt
3. **T+3min:** Migrations complete
4. **T+4min:** Applications started
5. **T+5min:** Health checks passing
6. **T+10min:** Smoke tests complete
7. **T+30min:** Monitor for issues

## Notes

- Dev environment is isolated from production
- No impact on prod or stage
- Database volumes preserved (no data loss)
- Redis cache will be empty after restart (expected)
- Qdrant vectors preserved in volume

---

**Ready to deploy:** ✅  
**Risk level:** Low (dev environment only)  
**Approval needed:** No (dev environment)
