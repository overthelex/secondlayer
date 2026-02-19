# Deployment Guide for ChatGPT Integration

This guide covers deploying the MCP backend for ChatGPT web integration.

## Prerequisites

- Ubuntu 20.04+ or similar Linux distribution
- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- Qdrant vector database
- Nginx with SSL/TLS
- Domain: `mcp.legal.org.ua`

## 1. DNS Configuration

Add A record for your domain:

```
mcp.legal.org.ua    A    your.server.ip
```

## 2. SSL Certificate

Install Let's Encrypt certificate:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot certonly --nginx -d mcp.legal.org.ua
```

## 3. Nginx Configuration

Copy the nginx configuration:

```bash
sudo cp /home/vovkes/SecondLayer/mcp_backend/nginx-mcp-chatgpt.conf \
  /etc/nginx/sites-available/mcp.legal.org.ua

sudo ln -s /etc/nginx/sites-available/mcp.legal.org.ua \
  /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

## 4. Backend Configuration

Create `.env` file:

```bash
cd /home/vovkes/SecondLayer/mcp_backend
cat > .env << 'EOF'
# Server
NODE_ENV=production
HTTP_PORT=3000
HTTP_HOST=0.0.0.0

# Database
DATABASE_URL=postgresql://secondlayer:password@localhost:5432/secondlayer
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=your-strong-password
POSTGRES_DB=secondlayer

# Cache
REDIS_HOST=localhost
REDIS_PORT=6379

# Vector DB
QDRANT_URL=http://localhost:6333

# OpenAI
OPENAI_API_KEY=sk-your-key-here
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o

# External APIs
ZAKONONLINE_API_TOKEN=your-token-here

# Security
SECONDARY_LAYER_KEYS=key1,key2,key3
JWT_SECRET=your-64-char-secret-here

# OAuth (optional - for web users)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-secret
GOOGLE_CALLBACK_URL=https://mcp.legal.org.ua/auth/google/callback

# CORS
ALLOWED_ORIGINS=https://chat.openai.com,https://chatgpt.com

# MCP Settings
DISABLE_MCP_AUTH=false
EOF
```

## 5. Database Setup

Create database and run migrations:

```bash
# Create database
sudo -u postgres psql << EOF
CREATE DATABASE secondlayer;
CREATE USER secondlayer WITH PASSWORD 'your-strong-password';
GRANT ALL PRIVILEGES ON DATABASE secondlayer TO secondlayer;
EOF

# Run migrations
cd /home/vovkes/SecondLayer/mcp_backend
npm run db:setup
npm run migrate
```

## 6. Build and Start

```bash
cd /home/vovkes/SecondLayer/mcp_backend

# Install dependencies
npm install

# Build
npm run build

# Start with PM2
npm install -g pm2
pm2 start dist/http-server.js --name mcp-backend \
  --max-memory-restart 2G \
  --log-date-format "YYYY-MM-DD HH:mm:ss Z"

# Save PM2 configuration
pm2 save

# Setup PM2 startup
pm2 startup
```

## 7. Verify Installation

### Check health endpoint

```bash
curl https://mcp.legal.org.ua/health
```

Expected output:
```json
{
  "status": "ok",
  "service": "secondlayer-mcp-http",
  "version": "1.0.0"
}
```

### Check MCP discovery

```bash
curl https://mcp.legal.org.ua/mcp
```

Expected output:
```json
{
  "protocolVersion": "2024-11-05",
  "serverInfo": {
    "name": "SecondLayer Legal MCP Server",
    "version": "1.0.0",
    "description": "Ukrainian legal research and document analysis platform"
  },
  "capabilities": {
    "tools": {
      "count": 41,
      "listChanged": false
    }
  },
  "tools": [...]
}
```

### Test SSE connection

```bash
curl -X POST https://mcp.legal.org.ua/sse \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    }
  }'
```

## 8. ChatGPT Configuration

In ChatGPT web interface:

1. Go to Settings → Beta Features
2. Enable "Developer Mode"
3. Click "New App"
4. Fill in:
   - **Name**: SecondLayer Legal Research
   - **Description**: Ukrainian legal research and document analysis with 40+ tools
   - **MCP Server URL**: `https://mcp.legal.org.ua/sse`
   - **Authentication**: OAuth or Bearer Token
     - If OAuth:
       - Client ID: from `GOOGLE_CLIENT_ID`
       - Client Secret: from `GOOGLE_CLIENT_SECRET`
     - If Bearer Token:
       - Token: one of your `SECONDARY_LAYER_KEYS`

5. Click "Create"
6. Test with a query: "Find recent Supreme Court cases about appeal deadlines"

## 9. Monitoring

### View logs

```bash
# PM2 logs
pm2 logs mcp-backend

# Nginx access log
sudo tail -f /var/log/nginx/access.log

# Nginx error log
sudo tail -f /var/log/nginx/error.log

# Application logs
tail -f /home/vovkes/SecondLayer/mcp_backend/logs/combined.log
```

### Monitor performance

```bash
# PM2 monitoring
pm2 monit

# Check memory usage
pm2 show mcp-backend

# Check CPU usage
top -p $(pm2 pid mcp-backend)
```

### Database queries

Check recent tool executions:

```sql
SELECT
  tool_name,
  status,
  execution_time_ms,
  total_cost_usd,
  created_at
FROM cost_tracking
ORDER BY created_at DESC
LIMIT 20;
```

Check daily statistics:

```sql
SELECT
  DATE(created_at) as date,
  COUNT(*) as executions,
  COUNT(DISTINCT client_key) as unique_clients,
  SUM(total_cost_usd) as total_cost,
  AVG(execution_time_ms) as avg_time_ms
FROM cost_tracking
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

## 10. Troubleshooting

### SSE not working

1. Check nginx SSE configuration:
```bash
sudo nginx -t
grep -A 20 "location /sse" /etc/nginx/sites-available/mcp.legal.org.ua
```

2. Check nginx error log:
```bash
sudo tail -100 /var/log/nginx/error.log
```

3. Test direct connection:
```bash
curl -v http://localhost:3000/health
```

### Tools not appearing in ChatGPT

1. Check tool count:
```bash
curl https://mcp.legal.org.ua/mcp | jq '.capabilities.tools.count'
```

2. List all tools:
```bash
curl https://mcp.legal.org.ua/mcp | jq '.tools[].name'
```

3. Check backend logs:
```bash
pm2 logs mcp-backend --lines 100
```

### High memory usage

1. Check PM2 status:
```bash
pm2 show mcp-backend
```

2. Restart if needed:
```bash
pm2 restart mcp-backend
```

3. Adjust max memory:
```bash
pm2 delete mcp-backend
pm2 start dist/http-server.js --name mcp-backend --max-memory-restart 4G
pm2 save
```

### Authentication errors

1. Test bearer token:
```bash
curl -H "Authorization: Bearer your-key" \
  https://mcp.legal.org.ua/api/tools
```

2. Check OAuth configuration:
```bash
grep GOOGLE .env
```

3. Verify CORS:
```bash
curl -H "Origin: https://chat.openai.com" \
  -H "Access-Control-Request-Method: POST" \
  -X OPTIONS https://mcp.legal.org.ua/sse -v
```

## 11. Backup

### Database backup

```bash
# Daily backup
pg_dump -U secondlayer secondlayer | gzip > \
  /backups/secondlayer-$(date +%Y%m%d).sql.gz

# Restore from backup
gunzip -c /backups/secondlayer-20240115.sql.gz | \
  psql -U secondlayer secondlayer
```

### Configuration backup

```bash
# Backup configuration
tar -czf /backups/mcp-config-$(date +%Y%m%d).tar.gz \
  /home/vovkes/SecondLayer/mcp_backend/.env \
  /etc/nginx/sites-available/mcp.legal.org.ua
```

## 12. Updates

### Update backend

```bash
cd /home/vovkes/SecondLayer/mcp_backend
git pull
npm install
npm run build
pm2 restart mcp-backend
```

### Update dependencies

```bash
npm update
npm audit fix
npm run build
pm2 restart mcp-backend
```

## 13. Security

### SSL/TLS renewal

Certbot automatically renews certificates. Test renewal:

```bash
sudo certbot renew --dry-run
```

### API key rotation

1. Generate new keys:
```bash
# Add new key to .env
SECONDARY_LAYER_KEYS=old-key,new-key-1,new-key-2

# Restart
pm2 restart mcp-backend
```

2. Update ChatGPT configuration with new key

3. Remove old keys after migration:
```bash
# Remove old key from .env
SECONDARY_LAYER_KEYS=new-key-1,new-key-2

# Restart
pm2 restart mcp-backend
```

### Firewall

```bash
# Allow HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow SSH
sudo ufw allow 22/tcp

# Enable firewall
sudo ufw enable
```

## 14. Performance Optimization

### Nginx caching

Already configured in `nginx-mcp-chatgpt.conf`:
- MCP discovery cached for 5 minutes
- SSE connections not cached

### Redis caching

Backend automatically caches:
- Legislation: 30 days
- Court decisions: 7 days
- Embeddings: 90 days

### Database optimization

```sql
-- Create indexes (already in migrations)
CREATE INDEX IF NOT EXISTS idx_cost_tracking_created_at
  ON cost_tracking(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_tool_name
  ON cost_tracking(tool_name);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_client_key
  ON cost_tracking(client_key);

-- Vacuum analyze
VACUUM ANALYZE;
```

## Support

- Docs: `/home/vovkes/SecondLayer/mcp_backend/docs/`
- Logs: `pm2 logs mcp-backend`
- Issues: Create GitHub issue with logs attached
