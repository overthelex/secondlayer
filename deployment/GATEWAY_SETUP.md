
# SecondLayer Stage Deployment Setup

Guide for deploying the Staging environment to mail.lexapp.co.ua.

## Architecture Overview

### Server Allocation

| Environment | Server | Purpose |
|------------|--------|---------|
| **Staging** | mail.lexapp.co.ua | Pre-production testing |
| **Local** | localhost | Local development |

### Port Allocation

| Service | Staging | Local |
|---------|---------|-------|
| **Backend API** | 3004 | 3000 |
| **Frontend** | 8092 | 5173 |
| **PostgreSQL** | 5434 | 5432 |
| **Redis** | 6381 | 6379 |
| **Qdrant** | 6337-6338 | 6333-6334 |

### Container Names

```bash
Staging:  secondlayer-{service}-stage  (e.g., secondlayer-postgres-stage)
Gateway:  legal-nginx-gateway
```

## Files Structure

```bash
deployment/
├── docker-compose.stage.yml         # Staging environment
├── docker-compose.local.yml         # Local development
├── docker-compose.gateway.yml       # Nginx gateway proxy
├── nginx-gateway.conf               # Nginx gateway routing config
├── nginx-stage.legal.org.ua.conf    # System nginx config
├── .env.local.example               # Local env template
├── manage-gateway.sh                # Management script
└── GATEWAY_SETUP.md                 # This file
```

## Initial Setup

### 1. Configure Environment Variables

```bash
cd deployment
cp .env.local.example .env.local
nano .env.local  # Edit with local values
```

**Important Environment Variables:**

- `POSTGRES_PASSWORD` - Strong password for PostgreSQL
- `JWT_SECRET` - Random 64-character secret for JWT tokens
- `OPENAI_API_KEY` - OpenAI API key(s) for embeddings and LLM
- `ZAKONONLINE_API_TOKEN` - ZakonOnline API token(s)
- `SECONDARY_LAYER_KEYS` - Comma-separated API keys for HTTP auth
- `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET` - Google OAuth credentials

### 2. Build Docker Images

```bash
./manage-gateway.sh build
```

### 3. Start Environment

```bash
./manage-gateway.sh start stage
./manage-gateway.sh start local
```

### 4. Configure System Nginx (SSL Termination)

On the mail server, configure system nginx using `nginx-stage.legal.org.ua.conf`:

```bash
sudo cp nginx-stage.legal.org.ua.conf /etc/nginx/sites-available/stage.legal.org.ua
sudo ln -sf /etc/nginx/sites-available/stage.legal.org.ua /etc/nginx/sites-enabled/
sudo certbot --nginx -d stage.legal.org.ua
sudo systemctl reload nginx
```

## Management Commands

### Start/Stop/Restart

```bash
./manage-gateway.sh start stage      # Start staging
./manage-gateway.sh start local      # Start local
./manage-gateway.sh stop stage       # Stop staging
./manage-gateway.sh restart stage    # Restart staging
```

### Gateway Management

```bash
./manage-gateway.sh gateway start    # Start nginx gateway
./manage-gateway.sh gateway stop     # Stop nginx gateway
./manage-gateway.sh gateway restart  # Restart nginx gateway
./manage-gateway.sh gateway test     # Test nginx configuration
```

### Monitoring

```bash
./manage-gateway.sh status           # Show status of all containers
./manage-gateway.sh health           # Check health of all services
./manage-gateway.sh logs stage       # Staging logs
./manage-gateway.sh logs local       # Local logs
./manage-gateway.sh logs gateway     # Gateway logs
```

### Deployment

```bash
./manage-gateway.sh deploy stage     # Deploy staging to mail server
./manage-gateway.sh deploy local     # Full local rebuild
```

### Build and Clean

```bash
./manage-gateway.sh build            # Build Docker images
./manage-gateway.sh clean stage      # Clean staging data (removes volumes)
```

## URL Routing

### Staging
- **Frontend**: https://stage.legal.org.ua/
- **API**: https://stage.legal.org.ua/api
- **Auth**: https://stage.legal.org.ua/auth
- **Health**: https://stage.legal.org.ua/health

## Database Migrations

```bash
docker exec secondlayer-app-stage npm run migrate
```

## Backup and Restore

### Backup Database

```bash
docker exec secondlayer-postgres-stage pg_dump -U secondlayer secondlayer_stage > backup-stage-$(date +%Y%m%d).sql
```

### Restore Database

```bash
cat backup-stage-20260121.sql | docker exec -i secondlayer-postgres-stage psql -U secondlayer secondlayer_stage
```

## Troubleshooting

### Check Container Status

```bash
./manage-gateway.sh status
```

### View Container Logs

```bash
./manage-gateway.sh logs stage
docker logs -f secondlayer-app-stage
docker logs -f secondlayer-postgres-stage
```

### Test Health Endpoints

```bash
curl http://localhost:3004/health
curl https://stage.legal.org.ua/health
```

### Port Conflicts

```bash
sudo lsof -i :3004
sudo lsof -i :5434
sudo kill -9 <PID>
```

### Reset Environment

```bash
./manage-gateway.sh clean stage
./manage-gateway.sh build
./manage-gateway.sh start stage
```

## Security

### Environment Isolation
- Separate databases per environment
- Different API keys for each environment
- Separate JWT secrets
- Isolated Docker networks

### OAuth Configuration

Staging callback URL in Google Cloud Console:
- `https://stage.legal.org.ua/auth/google/callback`

## Maintenance

**Daily:**
- Check health: `./manage-gateway.sh health`
- Review logs for errors

**Weekly:**
- Backup staging database
- Check disk space: `df -h`
- Review resource usage: `docker stats`

---

**Last Updated**: 2026-02-13
