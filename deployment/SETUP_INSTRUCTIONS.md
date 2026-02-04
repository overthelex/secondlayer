# Quick Setup Instructions for Stage MCP HTTPS Access

## Summary

You now have all files ready to enable HTTPS access to the staging MCP server at `https://stage.mcp.legal.org.ua/sse`.

## What Was Created

1. **nginx-stage-mcp.conf** - Nginx configuration for stage.mcp.legal.org.ua subdomain
2. **nginx-gateway-3env.conf** - Updated with staging MCP endpoints (/staging/mcp, /staging/sse)
3. **test-stage-local.sh** - Local testing script (tests port 3004)
4. **test-stage-mcp-connection.sh** - HTTPS testing script (tests https://stage.mcp.legal.org.ua)
5. **STAGE_MCP_SETUP.md** - Detailed setup documentation

## Corrected Information

**Staging Backend Port: 3004** (not 3002)
- docker-compose.stage.yml maps internal port 3000 → host port 3004
- All configuration files have been updated to use port 3004

## Installation Steps (on gate server)

### Step 1: Ensure Staging Backend is Running

```bash
# On gate server
cd /path/to/deployment
sudo docker compose -f docker-compose.stage.yml --env-file .env.stage up -d

# Verify it's running on port 3004
sudo docker ps | grep stage
sudo netstat -tlnp | grep 3004
```

### Step 2: Test Local Connection

```bash
# Copy test script to gate server
scp deployment/test-stage-local.sh gate:/tmp/

# On gate server
chmod +x /tmp/test-stage-local.sh
/tmp/test-stage-local.sh

# Should show all tests passing with HTTP 200
```

### Step 3: Install Nginx Configuration

```bash
# Copy nginx config to gate server
scp deployment/nginx-stage-mcp.conf gate:/tmp/

# On gate server
sudo mv /tmp/nginx-stage-mcp.conf /etc/nginx/sites-available/stage.mcp.legal.org.ua
sudo ln -s /etc/nginx/sites-available/stage.mcp.legal.org.ua /etc/nginx/sites-enabled/

# Test nginx configuration
sudo nginx -t

# If ok, reload nginx
sudo systemctl reload nginx
```

### Step 4: Configure DNS

Create A record:
```
stage.mcp.legal.org.ua → <gate-server-ip>
```

Wait for DNS propagation (5-30 minutes).

### Step 5: Get SSL Certificate

```bash
# On gate server
sudo certbot --nginx -d stage.mcp.legal.org.ua

# Follow prompts, certbot will:
# - Get certificate from Let's Encrypt
# - Automatically update nginx config with SSL settings
# - Set up auto-renewal
```

### Step 6: Test HTTPS Connection

```bash
# Copy test script
scp deployment/test-stage-mcp-connection.sh gate:/tmp/

# On gate server
chmod +x /tmp/test-stage-mcp-connection.sh
/tmp/test-stage-mcp-connection.sh

# Should show all tests passing with HTTPS
```

## Quick Test from Client

```bash
# Test health
curl https://stage.mcp.legal.org.ua/health

# Test MCP discovery
curl -H "Authorization: Bearer test-key-123" \
     https://stage.mcp.legal.org.ua/mcp

# Test SSE connection
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  https://stage.mcp.legal.org.ua/sse
```

## Claude Desktop Integration

Add to `claude_desktop_config.json`:

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

## API Token

Current staging API token (from .env.stage):
```
SECONDARY_LAYER_KEYS=local-dev-key,test-key-123
```

Use either:
- `Authorization: Bearer local-dev-key`
- `Authorization: Bearer test-key-123`

## Troubleshooting

### Port 3004 not accessible

Check staging container:
```bash
sudo docker ps | grep stage
sudo docker logs secondlayer-app-stage
```

Restart if needed:
```bash
cd /path/to/deployment
sudo docker compose -f docker-compose.stage.yml --env-file .env.stage restart app-stage
```

### DNS not resolving

Test DNS:
```bash
nslookup stage.mcp.legal.org.ua
dig stage.mcp.legal.org.ua
```

### SSL certificate issues

Renew manually:
```bash
sudo certbot renew --nginx
```

Check certificate:
```bash
sudo certbot certificates
```

### 404 Not Found on /sse

This means:
1. Backend is not running MCP SSE server, OR
2. Backend is running but not exposing /sse endpoint

Check backend logs:
```bash
sudo docker logs secondlayer-app-stage | grep -i sse
```

Verify HTTP server is running (not stdio mode):
```bash
# Should see dist/http-server.js in command
sudo docker inspect secondlayer-app-stage | grep -i command
```

## Files to Keep Updated

When deploying changes:
1. **nginx-gateway-3env.conf** - If using internal gateway routing
2. **nginx-stage-mcp.conf** - If using direct subdomain access
3. **.env.stage** - Environment variables for staging

## Port Reference

| Service | Internal Port | External Port |
|---------|--------------|---------------|
| MCP Backend | 3000 | 3004 |
| PostgreSQL | 5432 | 5434 |
| Redis | 6379 | 6381 |
| Qdrant | 6333 | 6337 |
| Frontend | 80 | 8093 |

## Next Steps

After successful setup:
1. Test with Claude Desktop
2. Monitor logs: `sudo docker logs -f secondlayer-app-stage`
3. Check nginx logs: `sudo tail -f /var/log/nginx/stage.mcp.legal.org.ua-*.log`
4. Consider setting up monitoring/alerting

## Support

- Full documentation: `STAGE_MCP_SETUP.md`
- Test scripts: `test-stage-local.sh`, `test-stage-mcp-connection.sh`
- Project docs: `CLAUDE.md`, `START_HERE.md`
