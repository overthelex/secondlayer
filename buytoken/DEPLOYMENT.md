# SecondLayer Console - Deployment to Gate Server

This guide explains how to deploy SecondLayer Console to gate.lexapp.co.ua with nginx reverse proxy.

## Architecture

```
Internet → gate.lexapp.co.ua:443 (nginx)
    ↓
    https://legal.org.ua/console
    ↓
localhost:8081 (Docker container)
    ↓
payment-frontend (nginx) → payment-server (Node.js)
```

## Prerequisites

1. **SSH Access** to gate.lexapp.co.ua
2. **Docker and Docker Compose** installed on gate server
3. **Nginx** installed and running on gate server
4. **SSL Certificate** for legal.org.ua (Let's Encrypt)
5. **Environment variables** configured

## Files Created

| File | Purpose |
|------|---------|
| `nginx-gate-server.conf` | Nginx configuration for gate server |
| `docker-compose.gate-server.yml` | Docker Compose for gate deployment |
| `deploy-to-gate.sh` | Automated deployment script |

## Manual Deployment Steps

### 1. Prepare Environment File

Create `.env` file in `buytoken/` directory:

```bash
# JWT Authentication
JWT_SECRET=your-super-secret-jwt-key-change-this

# Google OAuth2
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=https://legal.org.ua/console/api/auth/google/callback

# Email SMTP
SMTP_HOST=mail.legal.org.ua
SMTP_PORT=587
SMTP_USER=secondlayermcp@legal.org.ua
SMTP_PASS=your-email-password

# Application
FRONTEND_URL=https://legal.org.ua/console
DOMAIN_NAME=legal.org.ua

# Optional: Payment providers
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
MONOBANK_API_TOKEN=
```

### 2. Copy Files to Gate Server

```bash
# From buytoken/ directory
scp -r . vovkes@gate.lexapp.co.ua:/opt/secondlayer-console/
```

### 3. Configure Nginx on Gate Server

```bash
# SSH to gate server
ssh vovkes@gate.lexapp.co.ua

# Copy nginx configuration
sudo cp /opt/secondlayer-console/nginx-gate-server.conf \
  /etc/nginx/sites-available/legal.org.ua-console

# Enable site
sudo ln -s /etc/nginx/sites-available/legal.org.ua-console \
  /etc/nginx/sites-enabled/

# Test nginx configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

### 4. Start Docker Containers

```bash
# On gate server
cd /opt/secondlayer-console

# Start services
docker-compose -f docker-compose.gate-server.yml up -d --build

# Check status
docker-compose -f docker-compose.gate-server.yml ps

# View logs
docker-compose -f docker-compose.gate-server.yml logs -f
```

### 5. Verify Deployment

```bash
# Check local service
curl http://localhost:8081/health

# Check through nginx
curl https://legal.org.ua/console
```

## Automated Deployment

Use the provided deployment script:

```bash
# From buytoken/ directory
./deploy-to-gate.sh
```

The script will:
1. ✓ Build Docker images (optional)
2. ✓ Copy files to gate server
3. ✓ Configure nginx
4. ✓ Check .env file
5. ✓ Start Docker containers
6. ✓ Reload nginx
7. ✓ Verify deployment

## Nginx Configuration Details

### Upstream Configuration

```nginx
upstream secondlayer_console {
    server localhost:8081;  # Docker container
    keepalive 32;
}
```

### Location Rewrite Rules

The `/console` prefix is removed when proxying to Docker:

```nginx
location /console {
    rewrite ^/console$ /console/ permanent;
    rewrite ^/console/(.*)$ /$1 break;
    proxy_pass http://secondlayer_console;
}
```

**Example URL Mapping:**
- `https://legal.org.ua/console` → `http://localhost:8081/`
- `https://legal.org.ua/console/profile.html` → `http://localhost:8081/profile.html`
- `https://legal.org.ua/console/api/auth/login` → `http://localhost:8081/api/auth/login`

### SSL Configuration

Ensure SSL certificates exist:

```bash
ls -la /etc/letsencrypt/live/legal.org.ua/
# Should show: fullchain.pem, privkey.pem, chain.pem
```

If certificates don't exist, create them:

```bash
sudo certbot certonly --nginx -d legal.org.ua
```

## Docker Container Ports

| Service | Internal Port | Exposed Port | Purpose |
|---------|---------------|--------------|---------|
| payment-frontend | 80 | 8080 | Nginx static files + API proxy |
| payment-server | 3001 | - | Node.js backend (internal only) |
| payments-db | 5432 | - | PostgreSQL (internal only) |

**Important:** Only port 8080 is exposed to the host for nginx reverse proxy.

## Troubleshooting

### 1. Port 8080 Already in Use

```bash
# Check what's using port 8080
sudo lsof -i :8080

# Stop the service or change port in docker-compose.gate-server.yml
```

### 2. Nginx 502 Bad Gateway

```bash
# Check if Docker container is running
docker ps | grep secondlayer-payment-frontend

# Check container logs
docker logs secondlayer-payment-frontend

# Check nginx error logs
sudo tail -f /var/log/nginx/legal.org.ua-console-error.log
```

### 3. OAuth Redirect Issues

Ensure `GOOGLE_CALLBACK_URL` matches Google OAuth2 console:

```
https://legal.org.ua/console/api/auth/google/callback
```

### 4. Database Connection Failed

```bash
# Check if database is healthy
docker-compose -f docker-compose.gate-server.yml ps

# Check database logs
docker logs secondlayer-payments-db
```

## Maintenance Commands

### View Logs

```bash
ssh vovkes@gate.lexapp.co.ua
cd /opt/secondlayer-console

# All services
docker-compose -f docker-compose.gate-server.yml logs -f

# Specific service
docker-compose -f docker-compose.gate-server.yml logs -f payment-frontend
```

### Restart Services

```bash
# Restart all
docker-compose -f docker-compose.gate-server.yml restart

# Restart specific service
docker-compose -f docker-compose.gate-server.yml restart payment-frontend
```

### Update Deployment

```bash
# On local machine
./deploy-to-gate.sh

# Or manually
rsync -avz . vovkes@gate.lexapp.co.ua:/opt/secondlayer-console/
ssh vovkes@gate.lexapp.co.ua \
  "cd /opt/secondlayer-console && docker-compose -f docker-compose.gate-server.yml up -d --build"
```

### Stop Services

```bash
docker-compose -f docker-compose.gate-server.yml down
```

### Clean Up

```bash
# Stop and remove volumes
docker-compose -f docker-compose.gate-server.yml down -v

# Remove images
docker-compose -f docker-compose.gate-server.yml down --rmi all
```

## Security Considerations

1. **JWT Secret**: Use strong random string (min 32 characters)
2. **Database Password**: Change default password in docker-compose
3. **HTTPS Only**: All traffic forced to HTTPS by nginx
4. **Security Headers**: Configured in nginx (HSTS, CSP, etc.)
5. **Internal Network**: Backend services not exposed to internet

## Performance Tuning

### Nginx Worker Processes

Edit `/etc/nginx/nginx.conf` on gate server:

```nginx
worker_processes auto;
worker_connections 1024;
```

### Docker Resources

Limit container resources in docker-compose:

```yaml
payment-server:
  deploy:
    resources:
      limits:
        cpus: '0.5'
        memory: 512M
```

## Monitoring

### Health Checks

- Frontend: `http://localhost:8081/health`
- Backend: `http://localhost:3001/health`
- Public: `https://legal.org.ua/console`

### Logs Location

- Nginx: `/var/log/nginx/legal.org.ua-console-*.log`
- Docker: `docker-compose logs`
- System: `journalctl -u nginx`

## Backup

### Database Backup

```bash
# Backup
docker exec secondlayer-payments-db pg_dump \
  -U financemanager payments_db > backup.sql

# Restore
docker exec -i secondlayer-payments-db psql \
  -U financemanager payments_db < backup.sql
```

## Support

For issues or questions:
1. Check logs: `docker-compose logs -f`
2. Check nginx: `sudo nginx -t`
3. Verify DNS: `dig legal.org.ua`
4. Test locally: `curl http://localhost:8081/health`
