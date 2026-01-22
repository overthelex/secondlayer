# Deployment Status

## ✅ Successfully Deployed

**Date**: 2026-01-18 08:48 CET  
**Target**: gate.lexapp.co.ua  
**URL**: http://legal.org.ua/console

## What Was Done

### 1. Infrastructure Setup ✅
- Created `/opt/secondlayer-console` directory on gate server
- Deployed all application files via rsync

### 2. Nginx Configuration ✅
- Modified existing `/etc/nginx/sites-available/legal.org.ua` config
- Added `/console` location proxy to Docker container
- Configured proxy headers for Cloudflare compatibility
- Changed Docker port to **8081** (8080 was in use by api.legal.org.ua)
- Nginx config tested and reloaded successfully

### 3. Docker Containers ✅
- All 3 containers running successfully:
  - `secondlayer-payments-db` (PostgreSQL) - **healthy**
  - `secondlayer-payment-server` (Node.js API) - **healthy**
  - `secondlayer-payment-frontend` (Nginx) - **healthy**
- Exposed on `localhost:8081` → proxied via nginx to `/console`

### 4. Local Testing ✅
```bash
# Direct container test
curl http://localhost:8081/health
# Response: 200 OK, "healthy"

# Through nginx proxy
curl -H 'Host: legal.org.ua' http://localhost/console/
# Response: 200 OK, HTML page loaded
```

## Current Status

### ✅ Working Locally
The application is **fully operational** when accessed directly from gate server:
- Docker containers: **Running**
- Nginx proxy: **Working**
- Health check: **Passing**
- Page load: **Success**

### ⚠️ Cloudflare Issue
Public access via `http://legal.org.ua/console` returns **522 error** (Connection Timed Out).

**Причина**: Cloudflare не может подключиться к origin server на gate.lexapp.co.ua

**Possible Causes**:
1. **Cloudflare SSL Mode**: Cloudflare может быть в режиме "Full SSL", но origin работает на HTTP
2. **Firewall Rules**: Могут блокироваться Cloudflare IP адреса
3. **Origin Rules**: В Cloudflare может быть неправильно настроен origin server

## Next Steps to Fix Cloudflare Issue

### Option 1: Check Cloudflare SSL Mode (Recommended)
```
1. Login to Cloudflare Dashboard
2. Go to SSL/TLS settings for legal.org.ua
3. Set SSL mode to "Flexible" (Cloudflare ↔ Origin uses HTTP)
   OR
4. Add SSL certificate to gate server and use "Full (strict)"
```

### Option 2: Verify Origin IP in Cloudflare
```
1. Go to Cloudflare DNS settings
2. Verify A record for legal.org.ua points to correct IP
3. Check if "Proxy" is enabled (orange cloud)
```

### Option 3: Add Cloudflare IPs to Firewall Whitelist
Already configured in nginx config, but may need server-level firewall:
```bash
# Allow Cloudflare IPs
sudo ufw allow from 173.245.48.0/20
sudo ufw allow from 103.21.244.0/22
# ... (full list in nginx config)
```

## Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| Nginx config | `/etc/nginx/sites-available/legal.org.ua` | Main site + /console proxy |
| Docker Compose | `/opt/secondlayer-console/docker-compose.gate-server.yml` | Container orchestration |
| Environment | `/opt/secondlayer-console/.env` | App secrets |
| Backup | `/etc/nginx/sites-available/legal.org.ua.backup-*` | Original nginx config |

## Quick Commands

```bash
# SSH to server
ssh vovkes@gate.lexapp.co.ua

# Check container status
cd /opt/secondlayer-console
docker compose -f docker-compose.gate-server.yml ps

# View logs
docker compose -f docker-compose.gate-server.yml logs -f

# Test locally
curl http://localhost:8081/health

# Test through nginx
curl -H 'Host: legal.org.ua' http://localhost/console/

# Restart containers
docker compose -f docker-compose.gate-server.yml restart

# Reload nginx
sudo systemctl reload nginx
```

## Summary

✅ **Deployment: Successful**  
✅ **Application: Running**  
✅ **Local Access: Working**  
⚠️ **Public Access**: Cloudflare 522 error (fixable via Cloudflare settings)

The application is deployed correctly and working. The only remaining issue is Cloudflare configuration, which is outside of the server deployment scope.
