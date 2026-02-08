
# SecondLayer 2-Environment Deployment Setup

Complete guide for deploying Staging and Development environments across multiple servers.
## Architecture Overview

### Server Allocation

Environments are deployed across multiple servers:

| Environment | Server | Purpose |
|------------|--------|---------|
| **Development** | gate.lexapp.co.ua | Development & testing |
| **Staging** | mail.lexapp.co.ua | Pre-production testing |
| **Local** | localhost | Local development |

### Environment Separation

Two completely isolated remote environments plus local development:

| Environment | Purpose | URL | Stability |
|------------|---------|-----|-----------|
| **Staging** | Pre-production testing | `https://stage.legal.org.ua/` | Medium - Release candidates |
| **Development** | Active development | `https://dev.legal.org.ua/` | Low - Unstable, latest features |
### Port Allocation

Each environment has isolated ports to avoid conflicts:

| Service | Staging | Development |
|---------|---------|-------------|
| **Backend API** | 3004 | 3003 |
| **Frontend** | 8092 | 8091 |
| **PostgreSQL** | 5434 | 5433 |
| **Redis** | 6381 | 6380 |
| **Qdrant** | 6337-6338 | 6335-6336 |

**Nginx Gateway**: Port 8080 (routes to all environments)
### Container Names

Containers follow a consistent naming pattern:

```bash
Staging:      secondlayer-{service}-stage  (e.g., secondlayer-postgres-stage)
Development:  secondlayer-{service}-dev    (e.g., secondlayer-redis-dev)
Gateway:      legal-nginx-gateway
```
## Files Structure

```bash
deployment/
├── docker-compose.stage.yml         # Staging environment
├── docker-compose.dev.yml           # Development environment
├── docker-compose.gateway.yml       # Nginx gateway proxy
├── nginx-gateway-2env.conf          # Nginx routing config
├── .env.stage.example               # Staging env template
├── .env.dev.example                 # Development env template
├── manage-gateway.sh                # Management script
└── GATEWAY_SETUP.md                 # This file
```
## Initial Setup
### 1. Configure Environment Variables

Create environment files for each environment:

```bash
cd deployment
# Staging
cp .env.stage.example .env.stage
nano .env.stage  # Edit with staging values
# Development
cp .env.dev.example .env.dev
nano .env.dev  # Edit with development values
```

**Important Environment Variables:**

- `POSTGRES_PASSWORD` - Strong password for PostgreSQL
- `JWT_SECRET` - Random 64-character secret for JWT tokens
- `OPENAI_API_KEY` - OpenAI API key(s) for embeddings and LLM
- `ZAKONONLINE_API_TOKEN` - ZakonOnline API token(s)
- `SECONDARY_LAYER_KEYS` - Comma-separated API keys for HTTP auth
- `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET` - Google OAuth credentials
### 2. Build Docker Images

Build the application images:

```bash
./manage-gateway.sh build
```

This builds:
- `secondlayer-app:latest` - Backend Node.js application
- `lexwebapp-lexwebapp:latest` - Frontend React application
### 3. Start Environments

Start all environments:

```bash

# Start all at once
./manage-gateway.sh start all
# Or start individually
./manage-gateway.sh start stage
./manage-gateway.sh start dev
```
### 4. Start Nginx Gateway

Start the nginx reverse proxy:

```bash
./manage-gateway.sh gateway start
```
### 5. Configure System Nginx (SSL Termination)

On the server, configure system nginx to proxy to the gateway container:

```nginx

# /etc/nginx/sites-available/legal.org.ua

server {
    listen 443 ssl http2;
    server_name stage.legal.org.ua;

    ssl_certificate /etc/letsencrypt/live/legal.org.ua/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/legal.org.ua/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }
}

server {
    listen 80;
    server_name stage.legal.org.ua;
    return 301 https://$server_name$request_uri;
}
```

Enable and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/legal.org.ua /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```
## Management Commands
### Start/Stop/Restart

```bash

# Start environments
./manage-gateway.sh start stage      # Start staging
./manage-gateway.sh start dev        # Start development
./manage-gateway.sh start all        # Start all environments
# Stop environments
./manage-gateway.sh stop stage       # Stop staging
./manage-gateway.sh stop all         # Stop all environments
# Restart environments
./manage-gateway.sh restart stage    # Restart staging
```
### Gateway Management

```bash

# Gateway operations
./manage-gateway.sh gateway start    # Start nginx gateway
./manage-gateway.sh gateway stop     # Stop nginx gateway
./manage-gateway.sh gateway restart  # Restart nginx gateway
./manage-gateway.sh gateway test     # Test nginx configuration
```
### Monitoring

```bash

# Show status of all containers
./manage-gateway.sh status
# Check health of all services
./manage-gateway.sh health
# View logs
./manage-gateway.sh logs stage       # Staging logs
./manage-gateway.sh logs dev         # Development logs
./manage-gateway.sh logs gateway     # Gateway logs
```
### Deployment to Remote Server

```bash

# Deploy to remote server
./manage-gateway.sh deploy stage     # Deploy staging
./manage-gateway.sh deploy dev       # Deploy development
./manage-gateway.sh deploy all       # Deploy all environments
```
### Build and Clean

```bash

# Build Docker images
./manage-gateway.sh build
# Clean environment data (removes volumes)
./manage-gateway.sh clean dev        # Clean development data
./manage-gateway.sh clean stage      # Clean staging data
```
## URL Routing

After deployment, environments are accessible via:
### Staging
- **Frontend**: https://stage.legal.org.ua/
- **API**: https://stage.legal.org.ua/api
- **Auth**: https://stage.legal.org.ua/auth
- **Health**: https://stage.legal.org.ua/health
### Development
- **Frontend**: https://dev.legal.org.ua/
- **API**: https://dev.legal.org.ua/api
- **Auth**: https://dev.legal.org.ua/auth
- **Health**: https://dev.legal.org.ua/health
## Deployment Workflow
### 1. Development Cycle

```bash

# Developer pushes code
git push origin feature-branch
# Build new images
./manage-gateway.sh build
# Restart dev environment
./manage-gateway.sh restart dev
# Test at https://dev.legal.org.ua/
```
### 2. Staging Release

```bash

# Merge to staging branch
git checkout staging
git merge feature-branch
# Build and deploy to staging
./manage-gateway.sh build
./manage-gateway.sh restart stage
# Test at https://stage.legal.org.ua/

# Run integration tests

# QA approval
```
## Database Migrations

Each environment has its own isolated database. Run migrations separately:

```bash

# Staging
docker exec secondlayer-app-stage npm run migrate
# Development
docker exec secondlayer-app-dev npm run migrate
```
## Backup and Restore
### Backup Databases

```bash

# Staging
docker exec secondlayer-postgres-stage pg_dump -U secondlayer secondlayer_stage > backup-stage-$(date +%Y%m%d).sql
# Development
docker exec secondlayer-postgres-dev pg_dump -U secondlayer secondlayer_dev > backup-dev-$(date +%Y%m%d).sql
```
### Restore Databases

```bash

# Restore staging
cat backup-stage-20260121.sql | docker exec -i secondlayer-postgres-stage psql -U secondlayer secondlayer_stage
# Restore development
cat backup-dev-20260121.sql | docker exec -i secondlayer-postgres-dev psql -U secondlayer secondlayer_dev
```
## Troubleshooting
### Check Container Status

```bash
./manage-gateway.sh status
```
### View Container Logs

```bash

# All logs for an environment
./manage-gateway.sh logs stage
# Specific container
docker logs -f secondlayer-app-stage
docker logs -f secondlayer-postgres-stage
docker logs -f legal-nginx-gateway
```
### Test Health Endpoints

```bash

# Staging
curl http://localhost:3004/health
# Development
curl http://localhost:3003/health
# Through gateway
curl http://localhost:8080/staging/health
curl http://localhost:8080/development/health
```
### Port Conflicts

If ports are already in use:

```bash

# Check what's using a port
sudo lsof -i :3004
sudo lsof -i :5434
# Kill process if needed
sudo kill -9 <PID>
```
### Nginx Configuration Issues

```bash

# Test nginx configuration
./manage-gateway.sh gateway test
# View nginx error logs
docker logs legal-nginx-gateway
# Restart nginx gateway
./manage-gateway.sh gateway restart
```
### Database Connection Issues

```bash

# Check if PostgreSQL is running
docker ps | grep postgres
# Check PostgreSQL logs
docker logs secondlayer-postgres-stage
# Test connection from app container
docker exec secondlayer-app-stage psql postgresql://secondlayer:password@postgres-stage:5432/secondlayer_stage -c "SELECT 1"
```
### Reset Environment

If an environment is completely broken:

```bash

# Stop and remove containers + volumes
./manage-gateway.sh clean dev
# Rebuild images
./manage-gateway.sh build
# Start fresh
./manage-gateway.sh start dev
```
## Security Considerations
### Environment Isolation

- Each environment has separate databases - no data sharing
- Different API keys for each environment
- Separate JWT secrets for session management
- Isolated Docker networks per environment
### API Key Rotation

Update keys in `.env.*` files and restart:

```bash
nano .env.stage  # Update OPENAI_API_KEY
./manage-gateway.sh restart stage
```
### OAuth Configuration

Each environment needs its own callback URL configured in Google Cloud Console:

- Staging: `https://stage.legal.org.ua/auth/google/callback`
- Development: `https://dev.legal.org.ua/auth/google/callback`
## Resource Limits

Docker resource limits per environment:

| Environment | CPU Limit | Memory Limit | CPU Reserved | Memory Reserved |
|------------|-----------|--------------|--------------|-----------------|
| Staging | 1.5 cores | 3 GB | 0.75 core | 1.5 GB |
| Development | 1.0 core | 2 GB | 0.5 core | 1 GB |

Adjust in docker-compose files if needed.
## Monitoring and Alerts
### Health Check Monitoring

Set up monitoring for health endpoints:

```bash

# Simple cron job to check health
*/5 * * * * curl -sf https://stage.legal.org.ua/health || echo "Staging down!" | mail -s "Alert" admin@example.com
```
### Log Aggregation

Container logs are stored in:
- `../mcp_backend/logs/` - Application logs
- Docker logs: `docker logs <container-name>`
## Cost Optimization
### Development Environment

Consider stopping dev environment when not in use:

```bash

# Stop during off-hours
./manage-gateway.sh stop dev
# Start when needed
./manage-gateway.sh start dev
```
### Shared Resources

All environments share:
- OpenAI API quota (consider separate keys)
- ZakonOnline API quota (consider separate tokens)
- Server resources (CPU, memory, disk)
## Maintenance
### Regular Tasks

**Daily:**
- Check health: `./manage-gateway.sh health`
- Review logs for errors

**Weekly:**
- Backup staging database
- Check disk space: `df -h`
- Review resource usage: `docker stats`

**Monthly:**
- Update Docker images: `docker system prune -a`
- Review and rotate API keys
- Check for security updates
### Updates and Upgrades

```bash

# Pull latest code
git pull origin main
# Rebuild images
./manage-gateway.sh build
# Rolling restart (minimize downtime)
./manage-gateway.sh restart dev    # Test first
./manage-gateway.sh restart stage  # Then staging
```
## Support and Documentation

- **Project**: SecondLayer - Semantic Legal Analysis Platform
- **Repository**: https://github.com/your-repo/SecondLayer
- **Issues**: Report issues via GitHub Issues
- **Documentation**: See `../CLAUDE.md` for development details

---

**Last Updated**: 2026-02-08
**Version**: 2.0.0
