# Security Update: Mandatory Authentication Enforcement

**Date:** 2026-02-05  
**Status:** Implemented  
**Impact:** BREAKING CHANGE - All MCP endpoints now require authentication

## Summary

Implemented mandatory authentication for all MCP server endpoints to enable proper usage tracking and billing. Previously, SSE endpoints allowed anonymous fallback access, which made it impossible to attribute usage to specific users.

## Changes Applied

### 1. mcp_backend (Main Legal Analysis Server)

#### A. SSE Endpoints - REQUIRED Auth (Breaking Change)

**`POST /sse`** - ChatGPT MCP integration endpoint
- **Before:** Optional authentication with anonymous fallback
- **After:** REQUIRED authentication (JWT or API key)
- **Returns:** 401 Unauthorized if no valid auth

**`ALL /v1/sse`** - Standard MCP SSE endpoint  
- **Before:** Optional authentication with anonymous fallback
- **After:** REQUIRED authentication (JWT or API key)
- **Returns:** 401 Unauthorized if no valid auth

**Error Codes:**
- `MISSING_AUTH` - No Authorization header provided
- `INVALID_API_KEY` - API key validation failed
- `AUTH_FAILED` - JWT verification failed
- `RATE_LIMIT_EXCEEDED` - Rate limit reached

#### B. Rate Limiting Added

**New Middleware:** `src/middleware/rate-limit.ts`
- Uses Redis for distributed rate limiting
- Fails open if Redis unavailable (logs error, allows request)
- Returns proper rate limit headers

**Protected Endpoints:**

1. **`GET /health`** - Health check endpoint
   - Rate limit: 60 requests/minute per IP
   - Status: Public (no auth)
   - Middleware: `healthCheckRateLimit`

2. **`GET /mcp`** - MCP discovery endpoint
   - Rate limit: 30 requests/minute per IP
   - Status: Public (no auth)
   - Middleware: `mcpDiscoveryRateLimit`
   - Returns: Server capabilities, available tools list

3. **`POST /webhooks/stripe`** - Stripe payment webhook
   - Rate limit: 10 requests/minute per IP
   - Status: Public (signature verified by service)
   - Middleware: `webhookRateLimit`

4. **`POST /webhooks/fondy`** - Fondy payment webhook
   - Rate limit: 10 requests/minute per IP
   - Status: Public (signature verified by service)
   - Middleware: `webhookRateLimit`

**Rate Limit Headers:**
```http
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 27
X-RateLimit-Reset: 1738789234567
```

#### C. Already Protected Endpoints (No Change)

✅ `GET /api/tools` - dualAuth (JWT or API key)  
✅ `POST /api/tools/:toolName` - dualAuth + balance check  
✅ `POST /api/tools/:toolName/stream` - dualAuth + balance check  
✅ `POST /api/tools/batch` - dualAuth + balance check  
✅ All `/api/billing/*` - requireJWT  
✅ All `/api/admin/*` - requireJWT  
✅ All `/api/auth/*` - requireJWT

### 2. mcp_rada (Parliament Data Server)

#### Changes:
1. **Added:** `src/middleware/rate-limit.ts` (copied from mcp_backend)
2. **Updated:** `GET /health` - Added rate limiting (60 req/min)

**Already Protected:**
- ✅ `GET /api/tools` - requireAPIKey
- ✅ `POST /api/tools/:toolName` - requireAPIKey
- ✅ `POST /api/tools/:toolName/stream` - requireAPIKey

**No SSE endpoints** (uses inline SSE in tool execution)

### 3. mcp_openreyestr (State Register Server)

#### Changes:
1. **Added:** `src/middleware/rate-limit.ts` (copied from mcp_backend)
2. **Updated:** `GET /health` - Added rate limiting (60 req/min)

**Already Protected:**
- ✅ `GET /api/tools` - requireAPIKey
- ✅ `POST /api/tools/:toolName` - requireAPIKey
- ✅ `POST /api/tools/:toolName/stream` - requireAPIKey

**No SSE endpoints** (uses inline SSE in tool execution)

## Files Modified

### mcp_backend
- `src/http-server.ts` - Updated SSE auth logic, added rate limiting
- `src/middleware/rate-limit.ts` - **NEW** - Redis-based rate limiter

### mcp_rada
- `src/http-server.ts` - Added rate limiting to /health
- `src/middleware/rate-limit.ts` - **NEW** - Redis-based rate limiter

### mcp_openreyestr
- `src/http-server.ts` - Added rate limiting to /health
- `src/middleware/rate-limit.ts` - **NEW** - Redis-based rate limiter

## Breaking Changes

### For SSE Clients

**Before (worked):**
```bash
curl -X POST https://legal.org.ua/sse
# Anonymous access allowed
```

**After (returns 401):**
```bash
curl -X POST https://legal.org.ua/sse
# 401 Unauthorized
```

**Required Now:**
```bash
curl -X POST https://legal.org.ua/sse \
  -H "Authorization: Bearer your-api-key-here"
```

### Migration Guide for Clients

#### 1. Update LibreChat Configuration

```yaml
mcpServers:
  secondlayer-backend:
    transport: sse
    endpoint: https://legal.org.ua/v1/sse
    headers:
      Authorization: "Bearer ${SECONDLAYER_API_KEY}"  # NOW REQUIRED
```

#### 2. Update ChatGPT Custom GPT Actions

Add authentication to OpenAPI schema:

```yaml
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer

security:
  - BearerAuth: []  # NOW REQUIRED
```

#### 3. Update Custom Scripts

**Before:**
```javascript
const response = await fetch('https://legal.org.ua/sse', {
  method: 'POST',
  body: JSON.stringify({...})
});
```

**After:**
```javascript
const response = await fetch('https://legal.org.ua/sse', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.SECONDLAYER_API_KEY}`  // REQUIRED
  },
  body: JSON.stringify({...})
});
```

## Security Benefits

1. ✅ **Usage Tracking** - All requests now attributed to specific users/API keys
2. ✅ **Billing Accuracy** - Can track costs per user accurately
3. ✅ **Abuse Prevention** - Rate limiting prevents DoS attacks on public endpoints
4. ✅ **Audit Trail** - All API usage logged with user identification
5. ✅ **Cost Control** - Users can monitor their own usage and costs

## Testing

### Test Required Auth on SSE Endpoints

```bash
# Should return 401
curl -X POST http://localhost:3000/sse

# Should return 401
curl -X POST http://localhost:3000/v1/sse

# Should succeed with valid key
curl -X POST http://localhost:3000/sse \
  -H "Authorization: Bearer test-key-123"
```

### Test Rate Limiting

```bash
# Health check - should allow 60 req/min
for i in {1..65}; do
  curl -s http://localhost:3000/health | grep -q "ok" || echo "Request $i failed"
done

# MCP discovery - should allow 30 req/min
for i in {1..35}; do
  curl -s http://localhost:3000/mcp | jq -r '.serverInfo.name' || echo "Request $i rate limited"
done
```

### Test Protected Endpoints (Should Still Work)

```bash
# Tools endpoint - requires auth
curl -X POST http://localhost:3000/api/tools/search_court_cases \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"query": "contracts", "limit": 5}'
```

## Rollback Plan

If issues arise, revert commits:

```bash
cd /home/vovkes/SecondLayer

# Revert changes
git revert HEAD

# Or restore specific files
git checkout HEAD~1 mcp_backend/src/http-server.ts
git checkout HEAD~1 mcp_backend/src/middleware/rate-limit.ts
```

## Environment Variables

### Required
No new environment variables required. Uses existing:
- `REDIS_HOST` - For rate limiting
- `REDIS_PORT` - For rate limiting

### Optional Rate Limit Configuration

Can be added to customize limits:

```bash
# In .env (optional - defaults shown)
RATE_LIMIT_HEALTH_MAX=60
RATE_LIMIT_HEALTH_WINDOW=60000
RATE_LIMIT_MCP_DISCOVERY_MAX=30
RATE_LIMIT_MCP_DISCOVERY_WINDOW=60000
RATE_LIMIT_WEBHOOK_MAX=10
RATE_LIMIT_WEBHOOK_WINDOW=60000
```

## Monitoring

### Check Rate Limit Usage

```bash
# Redis CLI
redis-cli

# List all rate limit keys
KEYS ratelimit:*

# Check specific IP usage
GET ratelimit:health:192.168.1.100
GET ratelimit:mcp-discovery:192.168.1.100

# TTL shows seconds until reset
TTL ratelimit:health:192.168.1.100
```

### Check Auth Failures

```bash
# Check logs for auth failures
tail -f logs/app.log | grep "Authentication failed"
tail -f logs/app.log | grep "Rate limit exceeded"
```

## Next Steps

1. ✅ Build and test all three servers
2. ✅ Update client integration documentation
3. ✅ Notify existing API users about breaking changes
4. ⏳ Deploy to dev environment first
5. ⏳ Monitor error rates
6. ⏳ Deploy to staging
7. ⏳ Deploy to production

## Support

If clients encounter 401 errors after update:
1. Verify API key is included in Authorization header
2. Check API key is valid: `SELECT * FROM api_keys WHERE key = 'xxx'`
3. Check rate limit status in Redis
4. Review logs for specific error codes

## Related Documentation

- [MCP Client Integration Guide](MCP_CLIENT_INTEGRATION_GUIDE.md)
- [Client Integration Quick Start](../mcp_backend/docs/CLIENT_INTEGRATION.md)
- [SSE Streaming Protocol](../mcp_backend/docs/SSE_STREAMING.md)
- [API Keys Management](../mcp_backend/docs/API_KEYS.md)

---

**Implementation:** Complete ✅  
**Testing:** Required ⏳  
**Deployment:** Pending ⏳
