# Modular Nginx Configuration for stage.legal.org.ua

This directory contains a modular nginx configuration for the SecondLayer MCP Stage environment.

## Structure

```
nginx/
├── stage.legal.org.ua.conf          # Main server configuration
├── includes/
│   ├── oauth-endpoints.conf         # OAuth 2.0 discovery and authorization
│   ├── mcp-endpoints.conf           # MCP protocol endpoints (SSE)
│   ├── api-endpoints.conf           # REST API and webhooks
│   └── frontend-routes.conf         # Frontend SPA routes
└── README.md                        # This file
```

## Installation

### 1. Copy Files to Server

```bash
# From local machine
cd /home/vovkes/SecondLayer/deployment

# Copy to server
scp -r nginx/ user@178.162.234.145:/tmp/
```

### 2. Install on Server

```bash
# SSH to server
ssh user@178.162.234.145

# Create includes directory
sudo mkdir -p /etc/nginx/includes

# Copy include files
sudo cp /tmp/nginx/includes/*.conf /etc/nginx/includes/

# Copy main config
sudo cp /tmp/nginx/stage.legal.org.ua.conf /etc/nginx/sites-available/

# Create symlink
sudo ln -sf /etc/nginx/sites-available/stage.legal.org.ua /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t
```

Expected output:
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

### 3. Reload Nginx

```bash
sudo systemctl reload nginx
```

## Verification

Test all endpoints:

```bash
# OAuth discovery
curl -s https://stage.legal.org.ua/.well-known/oauth-authorization-server | jq

# MCP discovery
curl -s https://stage.legal.org.ua/mcp | jq

# Health check
curl -s https://stage.legal.org.ua/health

# Frontend
curl -s https://stage.legal.org.ua/ | head -10
```

## Modular Configuration Benefits

### 1. **Easier Maintenance**
   - Each module handles one concern
   - Changes don't affect other modules
   - Clear separation of responsibilities

### 2. **Better Organization**
   - OAuth endpoints in one file
   - MCP endpoints in another
   - API routes separate from frontend
   - Easy to find and modify specific routes

### 3. **Reusability**
   - Include files can be shared across environments
   - Easy to create dev/stage/prod variants
   - Common patterns in one place

### 4. **Troubleshooting**
   - Test individual modules
   - Isolate issues quickly
   - Comment out entire modules if needed

## Module Descriptions

### oauth-endpoints.conf
**Purpose**: OAuth 2.0 authorization flow

**Routes**:
- `/.well-known/oauth-authorization-server` - OAuth discovery (RFC 8414)
- `/.well-known/openid-configuration` - OpenID Connect discovery
- `/oauth/authorize` - Authorization page
- `/oauth/token` - Token exchange
- `/oauth/revoke` - Token revocation
- `/authorize` → redirects to `/oauth/authorize`
- `/token` → redirects to `/oauth/token`

**Used by**: Claude.ai, ChatGPT Custom Connectors

### mcp-endpoints.conf
**Purpose**: Model Context Protocol endpoints

**Routes**:
- `/health` - Health check
- `/mcp` - MCP server discovery
- `/sse` - MCP over SSE (ChatGPT Web, Claude.ai)
- `/v1/sse` - Standard MCP SSE (Claude Desktop, Jan AI)

**Used by**: Claude Desktop, ChatGPT, Jan AI, Cherry Studio

### api-endpoints.conf
**Purpose**: REST API and webhooks

**Routes**:
- `/auth` - Google OAuth, JWT authentication
- `/api` - REST API endpoints (tools, billing, admin)
- `/webhooks` - Payment webhooks (Stripe, Fondy)

**Used by**: Web frontend, mobile apps, payment providers

### frontend-routes.conf
**Purpose**: React SPA frontend

**Routes**:
- `/*.{js,css,png,jpg,...}` - Static assets (cached)
- `/` - SPA fallback (all other routes)

**Used by**: Web users visiting stage.legal.org.ua

## Customization

### Change Backend Port

Edit `stage.legal.org.ua.conf`:

```nginx
upstream stage_mcp_backend {
    server localhost:3004;  # ← Change port here
    keepalive 128;
}
```

### Change Frontend Port

Edit `stage.legal.org.ua.conf`:

```nginx
upstream stage_frontend {
    server localhost:8092;  # ← Change port here
    keepalive 32;
}
```

### Disable a Module

Comment out the include line in `stage.legal.org.ua.conf`:

```nginx
# include /etc/nginx/includes/oauth-endpoints.conf;  # ← Disabled
include /etc/nginx/includes/mcp-endpoints.conf;
include /etc/nginx/includes/api-endpoints.conf;
include /etc/nginx/includes/frontend-routes.conf;
```

### Add Custom Routes

Create new include file:

```bash
sudo nano /etc/nginx/includes/custom-routes.conf
```

Add your routes, then include in main config:

```nginx
include /etc/nginx/includes/custom-routes.conf;
```

## Troubleshooting

### Check if includes are loaded

```bash
sudo nginx -T | grep -A 5 "oauth-endpoints"
```

### Test specific module

Comment out other includes, keep only one:

```nginx
include /etc/nginx/includes/oauth-endpoints.conf;  # ← Test this
# include /etc/nginx/includes/mcp-endpoints.conf;
# include /etc/nginx/includes/api-endpoints.conf;
# include /etc/nginx/includes/frontend-routes.conf;
```

Then reload and test.

### View effective configuration

```bash
sudo nginx -T | less
```

## Backup

Before making changes:

```bash
# Backup main config
sudo cp /etc/nginx/sites-available/stage.legal.org.ua \
       /etc/nginx/sites-available/stage.legal.org.ua.backup.$(date +%Y%m%d)

# Backup includes
sudo tar -czf /tmp/nginx-includes-backup-$(date +%Y%m%d).tar.gz /etc/nginx/includes/
```

## Rollback

```bash
# Restore from backup
sudo cp /etc/nginx/sites-available/stage.legal.org.ua.backup.YYYYMMDD \
       /etc/nginx/sites-available/stage.legal.org.ua

# Or restore includes
sudo tar -xzf /tmp/nginx-includes-backup-YYYYMMDD.tar.gz -C /

# Reload
sudo nginx -t && sudo systemctl reload nginx
```

## Next Steps

1. Deploy this configuration to stage server
2. Test OAuth flow with Claude.ai
3. If successful, create similar configs for dev/prod
4. Document any environment-specific changes

## Support

**Error logs**: `/var/log/nginx/stage.legal.org.ua-error.log`
**Access logs**: `/var/log/nginx/stage.legal.org.ua-access.log`

**Check backend**: `curl http://localhost:3004/health`
**Check frontend**: `curl http://localhost:8092/`
