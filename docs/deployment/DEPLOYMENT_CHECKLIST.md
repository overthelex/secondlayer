# Production Deployment Checklist

**Use this checklist to ensure a smooth production deployment.**

---

## Pre-Deployment

### Infrastructure

- [ ] Server provisioned (16GB RAM, 8 cores, 100GB disk minimum)
- [ ] Docker & Docker Compose installed on server
- [ ] Domain name configured and DNS pointing to server
- [ ] SSL certificate obtained (Let's Encrypt recommended)
- [ ] Firewall configured (allow ports 80, 443, 22)
- [ ] Backup strategy defined

### API Keys & Credentials

- [ ] OpenAI API key obtained (production account)
- [ ] OpenAI API key #2 obtained (for rotation)
- [ ] Legal data source API tokens obtained
- [ ] Secondary layer keys generated (use: `openssl rand -hex 32`)
- [ ] PostgreSQL password generated (use: `openssl rand -base64 32`)
- [ ] All credentials stored securely (e.g., password manager)

### Code Preparation

- [ ] Latest code pulled from main branch
- [ ] All tests passing (`npm test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Environment variables configured for production
- [ ] Database migrations tested
- [ ] Docker images built and tagged

---

## Deployment Steps

### 1. Backend Deployment

```bash
# On deployment server

# 1.1. Create deployment directory
mkdir -p /opt/secondlayer
cd /opt/secondlayer

# 1.2. Create production environment file
cat > .env.prod << 'EOF'
# Database
DATABASE_URL=postgresql://secondlayer:CHANGE_ME@postgres:5432/secondlayer_db
POSTGRES_PASSWORD=CHANGE_ME

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# Qdrant
QDRANT_URL=http://qdrant:6333

# OpenAI (use production keys)
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002
OPENAI_API_KEY=sk-prod-key-1
OPENAI_API_KEY2=sk-prod-key-2

# Legal API
ZAKONONLINE_API_TOKEN=prod-token-1
ZAKONONLINE_API_TOKEN2=prod-token-2

# Security (generate with: openssl rand -hex 32)
SECONDARY_LAYER_KEYS=prod-key-1,prod-key-2,prod-key-3

# Server
HTTP_PORT=3000
HTTP_HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info
EOF

# 1.3. Create docker-compose.prod.yml
cat > docker-compose.prod.yml << 'EOF'
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: secondlayer_db
      POSTGRES_USER: secondlayer
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - backend
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U secondlayer"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    networks:
      - backend
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  qdrant:
    image: qdrant/qdrant:latest
    restart: unless-stopped
    volumes:
      - qdrant_data:/qdrant/storage
    networks:
      - backend
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:6333/healthz"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    image: secondlayer-backend:prod
    restart: unless-stopped
    env_file: .env.prod
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      qdrant:
        condition: service_healthy
    networks:
      - backend
      - frontend
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  frontend:
    image: secondlayer-frontend:prod
    restart: unless-stopped
    depends_on:
      - backend
    networks:
      - frontend
    ports:
      - "8091:80"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:80/"]
      interval: 30s
      timeout: 10s
      retries: 3

networks:
  backend:
  frontend:

volumes:
  postgres_data:
  qdrant_data:
EOF

# 1.4. Load Docker images (transferred from dev machine)
gunzip -c /tmp/backend.tar.gz | docker load
gunzip -c /tmp/frontend.tar.gz | docker load

# 1.5. Start services
docker-compose -f docker-compose.prod.yml --env-file .env.prod up -d

# 1.6. Wait for services to be healthy
sleep 60

# 1.7. Check status
docker-compose -f docker-compose.prod.yml ps
```

**Checklist:**
- [ ] All services show "Up (healthy)" status
- [ ] Backend health check passes: `curl http://localhost:3000/health`
- [ ] Frontend loads: `curl http://localhost:8091`
- [ ] Database migrations applied
- [ ] Logs show no errors: `docker-compose logs backend`

### 2. Nginx Reverse Proxy Setup

```bash
# 2.1. Install Nginx
sudo apt update && sudo apt install nginx certbot python3-certbot-nginx

# 2.2. Create Nginx config
sudo nano /etc/nginx/sites-available/secondlayer

# Paste the following:
server {
    listen 80;
    server_name yourdomain.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Frontend
    location / {
        proxy_pass http://localhost:8091;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend API
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE streaming support
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 300s;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://localhost:3000/health;
        access_log off;
    }
}

# 2.3. Enable site
sudo ln -s /etc/nginx/sites-available/secondlayer /etc/nginx/sites-enabled/

# 2.4. Test Nginx config
sudo nginx -t

# 2.5. Obtain SSL certificate
sudo certbot --nginx -d yourdomain.com

# 2.6. Restart Nginx
sudo systemctl restart nginx

# 2.7. Enable auto-renewal
sudo systemctl enable certbot.timer
```

**Checklist:**
- [ ] Nginx config syntax valid (`nginx -t`)
- [ ] SSL certificate obtained
- [ ] HTTPS working: `curl https://yourdomain.com`
- [ ] HTTP redirects to HTTPS
- [ ] API accessible: `curl https://yourdomain.com/api/tools -H "Authorization: Bearer key"`
- [ ] Certificate auto-renewal enabled

### 3. Database Setup

```bash
# 3.1. Run migrations
docker exec backend-container npm run migrate

# 3.2. Verify database
docker exec -it postgres-container psql -U secondlayer -d secondlayer_db
\dt  # List tables
\q

# 3.3. Create initial data (optional)
docker exec backend-container node scripts/seed-data.js
```

**Checklist:**
- [ ] All migrations applied successfully
- [ ] Database tables created
- [ ] Initial data loaded (if applicable)
- [ ] Database backup configured

### 4. Monitoring & Logging

```bash
# 4.1. Setup log rotation
sudo nano /etc/docker/daemon.json

{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}

sudo systemctl restart docker

# 4.2. Create backup script
cat > /opt/secondlayer/backup.sh << 'EOF'
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/opt/backups/secondlayer

mkdir -p $BACKUP_DIR

# Backup database
docker exec postgres-container pg_dump -U secondlayer secondlayer_db | \
  gzip > $BACKUP_DIR/db_backup_$DATE.sql.gz

# Backup Qdrant
docker exec qdrant-container tar czf - /qdrant/storage | \
  cat > $BACKUP_DIR/qdrant_backup_$DATE.tar.gz

# Keep only last 7 days
find $BACKUP_DIR -type f -mtime +7 -delete

echo "Backup completed: $DATE"
EOF

chmod +x /opt/secondlayer/backup.sh

# 4.3. Setup daily backup cron
crontab -e
# Add: 0 2 * * * /opt/secondlayer/backup.sh >> /var/log/secondlayer-backup.log 2>&1
```

**Checklist:**
- [ ] Log rotation configured
- [ ] Backup script created and tested
- [ ] Cron job scheduled
- [ ] Backup directory has sufficient space
- [ ] Test restore from backup

---

## Post-Deployment Verification

### Functional Tests

```bash
# 1. Health check
curl https://yourdomain.com/health
# Expected: {"status":"ok"}

# 2. List tools
curl -H "Authorization: Bearer your-key" \
  https://yourdomain.com/api/tools
# Expected: JSON array of tools

# 3. Execute simple tool
curl -X POST \
  -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":5}' \
  https://yourdomain.com/api/tools/search_legal_precedents
# Expected: JSON response with results
```

**Checklist:**
- [ ] Health endpoint returns 200 OK
- [ ] API authentication working
- [ ] Tools list returns successfully
- [ ] Tool execution works
- [ ] Frontend loads without errors
- [ ] Chat interface functional
- [ ] Search returns results
- [ ] Streaming works (if enabled)

### Performance Tests

```bash
# 1. Response time check
time curl https://yourdomain.com/health
# Expected: < 100ms

# 2. Load test (requires Apache Bench)
ab -n 100 -c 10 https://yourdomain.com/health
# Expected: No failures

# 3. Check resource usage
docker stats --no-stream
```

**Checklist:**
- [ ] Response times acceptable (< 2s for most queries)
- [ ] CPU usage < 80% under load
- [ ] Memory usage stable
- [ ] No memory leaks after 1 hour
- [ ] Database connections stable

### Security Verification

```bash
# 1. SSL rating
curl https://www.ssllabs.com/ssltest/analyze.html?d=yourdomain.com

# 2. Check open ports
nmap yourdomain.com

# 3. Test authentication
curl https://yourdomain.com/api/tools
# Expected: 401 Unauthorized (without auth header)

# 4. Check security headers
curl -I https://yourdomain.com
```

**Checklist:**
- [ ] SSL Labs rating A or higher
- [ ] Only ports 80, 443, 22 open
- [ ] Authentication enforced on API endpoints
- [ ] Security headers present (HSTS, X-Frame-Options, etc.)
- [ ] No sensitive data in logs
- [ ] CORS configured correctly

---

## Rollback Plan

If deployment fails:

```bash
# 1. Stop new containers
docker-compose -f docker-compose.prod.yml down

# 2. Load previous images
docker load < /opt/backups/backend-previous.tar
docker load < /opt/backups/frontend-previous.tar

# 3. Restore database (if needed)
gunzip -c /opt/backups/db_backup_YYYYMMDD.sql.gz | \
  docker exec -i postgres-container psql -U secondlayer secondlayer_db

# 4. Start previous version
docker-compose -f docker-compose.prod.yml up -d

# 5. Verify rollback
curl https://yourdomain.com/health
```

**Checklist:**
- [ ] Previous Docker images backed up
- [ ] Database backup available
- [ ] Rollback tested in staging
- [ ] DNS TTL short enough for quick changes

---

## Monitoring Setup

### System Monitoring

```bash
# Install monitoring tools
apt install -y prometheus node-exporter grafana

# Configure Prometheus to scrape:
# - Node Exporter (system metrics)
# - Docker metrics
# - Application /metrics endpoint
```

**Checklist:**
- [ ] CPU/RAM/Disk monitoring active
- [ ] Docker container metrics collected
- [ ] Application metrics exposed
- [ ] Alerts configured for critical issues
- [ ] Dashboard created in Grafana

### Application Monitoring

Add to backend code:

```typescript
// Install: npm install prom-client
import client from 'prom-client';

// Create metrics
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status']
});

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});
```

**Checklist:**
- [ ] Request duration tracked
- [ ] Error rates monitored
- [ ] API usage by tool tracked
- [ ] Cost tracking enabled
- [ ] Slow queries logged

### Log Aggregation

```bash
# Setup centralized logging (optional)
# Options: ELK Stack, Loki, CloudWatch Logs

# Simple file-based logging
docker-compose logs -f backend > /var/log/secondlayer-backend.log &
docker-compose logs -f frontend > /var/log/secondlayer-frontend.log &
```

**Checklist:**
- [ ] Logs centralized
- [ ] Log rotation configured
- [ ] Error alerts set up
- [ ] Log retention policy defined

---

## Maintenance Schedule

### Daily

- [ ] Check application logs for errors
- [ ] Verify backup completed successfully
- [ ] Check disk space usage

### Weekly

- [ ] Review error rates and performance metrics
- [ ] Test database restore from backup
- [ ] Update system packages: `apt update && apt upgrade`
- [ ] Review API usage and costs

### Monthly

- [ ] Review and optimize costs (OpenAI, infrastructure)
- [ ] Update Docker images: `docker-compose pull`
- [ ] Review and archive old logs
- [ ] Test disaster recovery plan
- [ ] Review and update documentation

### Quarterly

- [ ] Rotate API keys
- [ ] Security audit
- [ ] Performance optimization review
- [ ] Update dependencies: `npm audit fix`

---

## Emergency Contacts

Document your emergency contacts:

- **DevOps Lead:** Name, Phone, Email
- **Backend Developer:** Name, Phone, Email
- **Infrastructure Provider:** Support URL, Phone
- **OpenAI Support:** https://help.openai.com
- **Database Admin:** Name, Phone, Email

---

## Sign-Off

Deployment completed by: ___________________

Date: ___________________

Verified by: ___________________

Production URL: ___________________

Rollback plan tested: [ ] Yes [ ] No

---

**Deployment Status:** ⬜ Not Started | ⬜ In Progress | ⬜ Complete | ⬜ Rolled Back

**Last Updated:** 2026-01-21
