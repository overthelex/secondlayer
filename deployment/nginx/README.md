# Nginx Configuration

Nginx configs for SecondLayer environments.

## Files

| File | Environment | Purpose |
|------|-------------|---------|
| `prod.legal.org.ua.conf` | Production | Main prod config (legal.org.ua, preview.legal.org.ua, plane.legal.org.ua) |
| `conf.d/local-docker.conf` | Local | Local dev config (local.legal.org.ua with self-signed TLS) |
| `localdev.legal.org.ua.conf` | Local | Alternative local config |
| `stage.legal.org.ua.conf` | Legacy | Stage config (not actively used) |

## Includes (shared partials)

```
includes/
  prod-upstreams.conf          # Active production upstreams (managed by deploy script)
  preview-upstreams.conf       # Preview upstreams (managed by deploy script)
  prod-server-common.conf      # Shared production server block config
  preview-server-common.conf   # Preview server block config
  api-endpoints.conf           # REST API and webhook routes
  mcp-endpoints.conf           # MCP protocol endpoints (SSE)
  oauth-endpoints.conf         # OAuth 2.0 authorization flow
  frontend-routes.conf         # React SPA routes and static assets
  ssl-common.conf              # TLS settings
  security-headers.conf        # Security headers
  server-common.conf           # Shared server block directives
  nextcloud-proxy.conf         # Nextcloud reverse proxy
```

## Production Architecture

The production nginx container (`nginx-prod`) serves all domains:

- **legal.org.ua** / **mcp.legal.org.ua** - Main application (frontend + API)
- **preview.legal.org.ua** - Blue-green preview (points to inactive color)
- **plane.legal.org.ua** - Plane project management

### Blue-Green Upstream Switching

Production uses blue-green deployments. The upstream files are **managed by the CI/CD deploy script** and must not be edited manually:

- `includes/prod-upstreams.conf` - Points to the active color containers
- `includes/preview-upstreams.conf` - Points to the inactive color (for preview)

During deployment:
1. New containers start alongside existing ones
2. `preview-upstreams.conf` is updated to point to new containers
3. Nginx is force-recreated to pick up changes
4. Preview is verified at `preview.legal.org.ua`
5. After approval, `prod-upstreams.conf` switches to new containers
6. Nginx is force-recreated again
7. Old containers are stopped

Nginx must be `--force-recreated` after ANY upstream change because Docker bind mounts can become stale (inode caching).

### Key Routes

| Route | Backend |
|-------|---------|
| `/health` | Backend API health check |
| `/api/*` | REST API endpoints |
| `/auth/*` | Google OAuth, JWT auth |
| `/sse`, `/v1/sse` | MCP over SSE |
| `/mcp` | MCP server discovery |
| `/webhooks/*` | Payment webhooks (Monobank) |
| `/.well-known/oauth-*` | OAuth discovery |
| `/*` | Frontend SPA (fallback) |

## Local Development

Local nginx (`nginx-local`) uses `local-docker.conf` with self-signed TLS certificates:

```
certs/
  fullchain.pem / privkey.pem                # Production TLS (if present)
  localdev.legal.org.ua+2.pem               # Local mkcert certificate
  localdev.legal.org.ua+2-key.pem           # Local mkcert key
```

To regenerate local certificates:

```bash
# Install mkcert
brew install mkcert   # macOS
# or: sudo apt install mkcert  # Ubuntu

mkcert -install
mkcert -cert-file nginx/certs/localdev.legal.org.ua+2.pem \
       -key-file nginx/certs/localdev.legal.org.ua+2-key.pem \
       local.legal.org.ua "*.local.legal.org.ua" localhost
```

## Troubleshooting

### Test configuration

```bash
# Production (via SSH)
ssh prod "docker exec nginx-prod nginx -t"

# Local
docker exec nginx-local nginx -t
```

### View effective config

```bash
docker exec nginx-prod nginx -T | less
```

### Reload after manual config change

```bash
# Production — force recreate (required for bind mount changes)
ssh prod "cd /home/ubuntu/SecondLayer/deployment && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d nginx-prod --force-recreate"

# Local
docker exec nginx-local nginx -s reload
```

### Logs

```bash
# Production
ssh prod "docker logs --tail=100 nginx-prod"

# Local
docker logs --tail=100 nginx-local
```
