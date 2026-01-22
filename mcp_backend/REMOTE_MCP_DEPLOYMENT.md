# Remote MCP Server Deployment Guide

Deploy SecondLayer MCP server to `gate.lexapp.co.ua` and make it accessible via `https://mcp.legal.org.ua/v1/sse`.

## Prerequisites

- DNS record for `mcp.legal.org.ua` pointing to gate server IP
- SSH access to `gate.lexapp.co.ua`
- Docker and Docker Compose installed on gate server
- Nginx installed on gate server
- Certbot installed for SSL certificates

## Files Created

- ✅ `src/sse-server.ts` - SSE-based MCP server
- ✅ `nginx-mcp.legal.org.ua.conf` - Nginx configuration
- ✅ `setup-nginx-on-gate.sh` - Automated setup script
- ✅ Updated `package.json` with SSE scripts
- ✅ Updated `Dockerfile` to use SSE server
- ✅ Built TypeScript (`dist/sse-server.js`)

## Deployment Steps

### Step 1: Verify DNS Configuration

```bash
# From your local machine, check DNS
dig +short mcp.legal.org.ua A

# Should return the IP of gate.lexapp.co.ua
# If not, add DNS A record: mcp.legal.org.ua -> <gate_server_ip>
```

### Step 2: Copy Nginx Setup Script to Gate Server

```bash
# From mcp_backend directory
scp setup-nginx-on-gate.sh gate.lexapp.co.ua:~/
```

### Step 3: SSH to Gate Server and Run Setup

```bash
# SSH to gate server
ssh gate.lexapp.co.ua

# Run the nginx setup script
sudo bash ~/setup-nginx-on-gate.sh

# This script will:
# 1. Create nginx config for mcp.legal.org.ua
# 2. Enable the site
# 3. Test nginx configuration
# 4. Reload nginx
# 5. Run certbot to get SSL certificate (interactive)
```

**Important:** When certbot asks for email and terms, accept and provide your email.

### Step 4: Deploy SecondLayer MCP Server

```bash
# Back on your local machine, in mcp_backend directory
cd /Users/vovkes/ZOMCP/SecondLayer/mcp_backend

# Deploy using the deployment script
./deploy.sh deploy

# This will:
# 1. Package the application
# 2. Copy to gate server
# 3. Build Docker images
# 4. Start containers with docker-compose
```

### Step 5: Verify Deployment

```bash
# Check Docker containers on gate server
ssh gate.lexapp.co.ua
cd ~/secondlayer/secondlayer
docker compose ps

# Should show:
# - secondlayer-postgres (healthy)
# - secondlayer-redis (healthy)
# - secondlayer-qdrant (healthy)
# - secondlayer-app-prod (running)
```

### Step 6: Test Endpoints

```bash
# From your local machine

# Test health endpoint
curl https://mcp.legal.org.ua/health

# Expected response:
# {
#   "status": "ok",
#   "service": "secondlayer-mcp-sse",
#   "version": "1.0.0",
#   "transport": "sse",
#   "tools": 10
# }

# Test SSE endpoint (will hang - this is correct behavior)
curl -X POST https://mcp.legal.org.ua/v1/sse \
  -H "Content-Type: application/json" \
  -d '{}'
# Press Ctrl+C after a few seconds

# If you see "event: " lines, SSE is working!
```

### Step 7: Configure MCP Client

Add to your MCP client configuration (e.g., Claude Desktop):

**File:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "SecondLayerMCP": {
      "url": "https://mcp.legal.org.ua/v1/sse",
      "headers": {}
    }
  }
}
```

Restart Claude Desktop, and you should see SecondLayer tools available!

## Troubleshooting

### DNS Not Resolving

```bash
# Check DNS propagation
dig +short mcp.legal.org.ua A

# If empty, wait for DNS propagation (can take up to 48 hours)
# Or check your DNS provider settings
```

### SSL Certificate Error

```bash
# On gate server, check certificate
sudo ls -la /etc/letsencrypt/live/mcp.legal.org.ua/

# If missing, run certbot manually
sudo certbot --nginx -d mcp.legal.org.ua

# Check nginx error logs
sudo tail -f /var/log/nginx/mcp.legal.org.ua.error.log
```

### Port 3000 Not Responding

```bash
# On gate server, check if app is running
docker ps | grep secondlayer-app

# Check app logs
docker logs secondlayer-app-prod -f

# Check if port is listening
sudo netstat -tlnp | grep 3000
# or
sudo ss -tlnp | grep 3000
```

### Nginx Configuration Issues

```bash
# Test nginx config
sudo nginx -t

# If errors, check the config file
sudo nano /etc/nginx/sites-available/mcp.legal.org.ua

# Reload nginx after fixes
sudo systemctl reload nginx
```

### Docker Containers Not Starting

```bash
# On gate server
cd ~/secondlayer/secondlayer

# Check logs
docker compose logs -f

# Restart containers
docker compose down
docker compose up -d

# Check if .env file exists and has correct values
cat .env | grep -v "PASSWORD\|TOKEN\|KEY"
```

### MCP Client Can't Connect

1. **Test health endpoint first:**
   ```bash
   curl https://mcp.legal.org.ua/health
   ```

2. **Check client logs** (Claude Desktop: `~/Library/Logs/Claude/`)

3. **Verify SSE endpoint:**
   ```bash
   curl -v -X POST https://mcp.legal.org.ua/v1/sse \
     -H "Content-Type: application/json"
   ```

4. **Check nginx access logs:**
   ```bash
   sudo tail -f /var/log/nginx/mcp.legal.org.ua.access.log
   ```

## Monitoring

### View Live Logs

```bash
# App logs
ssh gate.lexapp.co.ua
cd ~/secondlayer/secondlayer
docker compose logs -f app

# Nginx access logs
sudo tail -f /var/log/nginx/mcp.legal.org.ua.access.log

# Nginx error logs
sudo tail -f /var/log/nginx/mcp.legal.org.ua.error.log
```

### Check Service Status

```bash
# On gate server
docker compose ps
sudo systemctl status nginx
```

### Resource Usage

```bash
# Check Docker container resources
docker stats secondlayer-app-prod
```

## Updating the Server

```bash
# From local machine
cd /Users/vovkes/ZOMCP/SecondLayer/mcp_backend

# Make your code changes
# ...

# Rebuild
npm run build

# Deploy
./deploy.sh deploy

# The deployment script will:
# - Stop old containers
# - Rebuild images
# - Start new containers
# - Minimal downtime (~30 seconds)
```

## Rolling Back

```bash
# On gate server
cd ~/secondlayer/secondlayer

# Stop current version
docker compose down

# Restore from backup (if you have one)
# Or redeploy previous version from local machine
```

## Security Notes

- ✅ HTTPS with Let's Encrypt SSL certificate
- ✅ No API keys needed in URL (handled by backend .env)
- ✅ Nginx security headers enabled
- ✅ Rate limiting can be added to nginx if needed
- ⚠️ Monitor access logs for unusual activity

## Available Tools (10)

Once connected, clients have access to:

1. `search_legal_precedents` - Search court decisions
2. `analyze_case_pattern` - Pattern analysis
3. `get_similar_reasoning` - Vector similarity
4. `extract_document_sections` - Extract sections
5. `count_cases_by_party` - Count by party name
6. `find_relevant_law_articles` - Find cited laws
7. `check_precedent_status` - Validate precedents
8. `load_full_texts` - Download full texts
9. `get_citation_graph` - Build citation graph
10. `get_legal_advice` - Comprehensive analysis with streaming

## Cost Tracking

The server tracks API usage and costs. View statistics:

```bash
# SSH to gate server
ssh gate.lexapp.co.ua
cd ~/secondlayer/secondlayer

# Connect to PostgreSQL
docker exec -it secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db

# View recent requests
SELECT request_id, tool_name, total_cost_usd, created_at
FROM cost_tracking
ORDER BY created_at DESC
LIMIT 20;

# Exit psql
\q
```

## Support

- Logs: Check Docker and nginx logs
- Configuration: Review `.env` and nginx config
- DNS: Verify `mcp.legal.org.ua` resolves correctly
- SSL: Ensure certificate is valid and not expired
- MCP SDK: https://github.com/modelcontextprotocol/
