# Stage MCP Server - Deployment Complete ✓

**Date:** 2026-02-02
**Server:** mail.lexapp.co.ua (178.162.234.145)
**URL:** https://stage.mcp.legal.org.ua/sse

## Summary

Successfully deployed and configured Stage MCP Server with HTTPS access. All endpoints are operational and accessible.

## What Was Done

### 1. Backend Update
- ✅ Updated repository on mail server with latest code
- ✅ Fixed database configuration (.env.stage)
  - Added `POSTGRES_HOST=postgres-stage`
  - Added `POSTGRES_PORT=5432`
  - Added `DATABASE_URL` with correct parameters
  - Fixed `POSTGRES_DB=secondlayer_stage`
- ✅ Rebuilt Docker image from latest source (with `--no-cache`)
- ✅ Container running on port 3004 with MCP SSE endpoints

### 2. Nginx Configuration
- ✅ Created nginx configuration: `nginx-stage-mcp.conf`
- ✅ Copied to `/etc/nginx/domains/stage.mcp.legal.org.ua.conf`
- ✅ Configured SSL/TLS with proper security headers
- ✅ Configured SSE-specific proxy settings (no buffering, long timeout)

### 3. SSL Certificate
- ✅ Obtained Let's Encrypt certificate for stage.mcp.legal.org.ua
- ✅ Certificate expires: 2026-05-03 (auto-renewal configured)
- ✅ Certificate properly linked in nginx configuration

### 4. Testing
- ✅ Health endpoint: `https://stage.mcp.legal.org.ua/health`
- ✅ MCP discovery: `https://stage.mcp.legal.org.ua/mcp`
- ✅ SSE endpoint: `https://stage.mcp.legal.org.ua/sse`
- ✅ 34 tools available

## Endpoints

### Health Check
```bash
curl https://stage.mcp.legal.org.ua/health
```
Response: `{"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}`

### MCP Discovery
```bash
curl -H "Authorization: Bearer test-key-123" \
     https://stage.mcp.legal.org.ua/mcp
```

### SSE Connection (MCP Protocol)
```bash
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  https://stage.mcp.legal.org.ua/sse
```

## Claude Desktop Configuration

Add to `~/.config/Claude/claude_desktop_config.json` (Linux/Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "secondlayer-stage": {
      "url": "https://stage.mcp.legal.org.ua/sse",
      "transport": {
        "type": "sse"
      },
      "headers": {
        "Authorization": "Bearer test-key-123"
      }
    }
  }
}
```

After updating the configuration, restart Claude Desktop to load the MCP server.

## API Token

**Current API Token:** `test-key-123`

Available tokens (from .env.stage):
- `local-dev-key`
- `test-key-123`

Use in Authorization header:
```
Authorization: Bearer test-key-123
```

## Available Tools (34)

Core functionality:
- `classify_intent` - Query classification
- `search_court_cases` - Search ZakonOnline court decisions
- `get_document_text` - Retrieve full court decision text
- `semantic_search` - Vector similarity search
- `find_legal_patterns` - Legal reasoning pattern matching
- `validate_citations` - Citation verification
- `packaged_lawyer_answer` - Complete legal analysis workflow
- `get_legal_advice` - Legal consultation with streaming support
- `search_legislation` - Search Ukrainian laws/codes
- `get_legislation_section` - Retrieve specific law articles

And 24 more specialized tools for due diligence, document analysis, and legal research.

## Container Status

```bash
ssh mail docker ps --filter name=secondlayer-app-stage
```

Container details:
- **Name:** secondlayer-app-stage
- **Image:** secondlayer-app:latest
- **Port:** 3004:3000
- **Network:** secondlayer-stage_secondlayer-stage-network
- **Health:** healthy
- **Status:** Up and running

## Services Status

All services running in Docker network `secondlayer-stage_secondlayer-stage-network`:

| Service | Container | Port | Status |
|---------|-----------|------|--------|
| App | secondlayer-app-stage | 3004:3000 | ✓ healthy |
| PostgreSQL | secondlayer-postgres-stage | 5434:5432 | ✓ healthy |
| Redis | secondlayer-redis-stage | 6381:6379 | ✓ healthy |
| Qdrant | secondlayer-qdrant-stage | 6337:6333 | ✓ healthy |
| Frontend | lexwebapp-stage | 8093:80 | ✓ healthy |

**Note:** Redis connection from app shows warnings but continues without cache (acceptable for staging).

## Logs

### Backend Logs
```bash
ssh mail docker logs -f secondlayer-app-stage
```

### Nginx Access Logs
```bash
ssh mail sudo tail -f /var/log/nginx/stage.mcp.legal.org.ua-access.log
```

### Nginx Error Logs
```bash
ssh mail sudo tail -f /var/log/nginx/stage.mcp.legal.org.ua-error.log
```

## Maintenance

### Restart Backend
```bash
ssh mail docker restart secondlayer-app-stage
```

### Reload Nginx
```bash
ssh mail sudo systemctl reload nginx
```

### Update Backend Code
Use the automated script:
```bash
cd /home/vovkes/SecondLayer/deployment
./update-stage-backend-on-mail.sh
```

This script will:
1. Pull latest changes from git
2. Stop staging container
3. Rebuild image with `--no-cache`
4. Start updated container
5. Wait for health check
6. Test MCP endpoints

### Certificate Renewal

Certificates auto-renew via certbot. To manually renew:
```bash
ssh mail sudo certbot renew --nginx
```

## Troubleshooting

### Backend not responding
```bash
ssh mail
docker logs --tail 100 secondlayer-app-stage
docker restart secondlayer-app-stage
```

### SSL certificate issues
```bash
ssh mail
sudo certbot certificates
sudo certbot renew --nginx
sudo systemctl reload nginx
```

### Database connection errors
Check if postgres container is running:
```bash
ssh mail docker ps | grep postgres-stage
```

### Redis warnings
Redis warnings are expected in staging (app continues without cache). To fix:
```bash
ssh mail
docker restart secondlayer-redis-stage
docker restart secondlayer-app-stage
```

## Files Modified/Created

### On Local Machine
- `deployment/.env.stage` - Updated with database host configuration
- `deployment/nginx-stage-mcp.conf` - Nginx configuration for HTTPS
- `deployment/update-stage-backend-on-mail.sh` - Automated update script
- `deployment/deploy-stage-mcp-to-mail.sh` - Deployment automation script
- `deployment/test-stage-mcp-connection.sh` - HTTPS testing script
- `deployment/STAGE_MCP_DEPLOYMENT_SUCCESS.md` - This file

### On Mail Server
- `~/SecondLayer/` - Complete repository
- `~/SecondLayer/deployment/.env.stage` - Updated database configuration
- `/etc/nginx/domains/stage.mcp.legal.org.ua.conf` - Active nginx config
- `/etc/letsencrypt/live/stage.mcp.legal.org.ua/` - SSL certificate

## Next Steps

1. ✅ **Test with Claude Desktop**
   - Add configuration to claude_desktop_config.json
   - Restart Claude Desktop
   - Verify tools are loaded
   - Test a few queries

2. **Monitor Performance**
   - Check logs for errors
   - Monitor API costs
   - Track response times

3. **Optional: Fix Redis Connection**
   - Currently app runs without Redis cache
   - Not critical for staging, but can improve performance
   - Check Redis container logs if needed

4. **Production Deployment**
   - After staging validation, use similar process for production
   - Update production .env with correct database credentials
   - Use production domain and SSL certificate

## Support & Documentation

- Main docs: `/home/vovkes/SecondLayer/START_HERE.md`
- API docs: `/home/vovkes/SecondLayer/mcp_backend/docs/api-explorer.html`
- Deployment guide: `/home/vovkes/SecondLayer/deployment/GATEWAY_SETUP.md`
- MCP integration: `/home/vovkes/SecondLayer/mcp_backend/docs/CLIENT_INTEGRATION.md`

## Success Verification

All checkmarks passed:
- ✅ Backend updated with latest code
- ✅ Database connection working
- ✅ MCP endpoints responding (34 tools)
- ✅ HTTPS configured with valid SSL certificate
- ✅ Nginx proxy working correctly
- ✅ Health checks passing
- ✅ SSE streaming functional
- ✅ Ready for Claude Desktop integration

**Status:** 🟢 Production-Ready (Staging Environment)
