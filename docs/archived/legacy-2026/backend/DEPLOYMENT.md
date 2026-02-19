# SecondLayer MCP Backend - Deployment Guide

This guide explains how to deploy the SecondLayer MCP Backend to a production server using Docker containers.

## Prerequisites

### Local Machine
- SSH access to the gate server
- SSH key authentication configured (recommended)
- Bash shell (macOS/Linux/WSL)

### Gate Server
- Ubuntu 20.04+ or similar Linux distribution
- Docker Engine installed (20.10+)
- Docker Compose installed (v2.0+)
- Sufficient resources:
  - **CPU**: 2+ cores (4+ recommended)
  - **RAM**: 4GB minimum (8GB+ recommended)
  - **Disk**: 20GB+ free space
  - **Network**: Stable internet connection

## Quick Start

### 1. Configure Environment

Copy the production environment template and fill in your actual values:

```bash
cd /Users/vovkes/ZOMCP/SecondLayer/mcp_backend
cp .env.production.template .env.production
```

Edit `.env.production` and update:
- Database passwords (use strong passwords!)
- OpenAI API key(s)
- ZakonOnline API token(s)
- API authentication keys for `SECONDARY_LAYER_KEYS`

**Security Best Practices:**
```bash
# Generate strong passwords
openssl rand -base64 32

# Generate API keys
openssl rand -hex 32
```

### 2. Configure Deployment

Set environment variables for deployment (or edit `deploy.sh` defaults):

```bash
export DEPLOY_USER=ubuntu              # SSH user on gate server
export DEPLOY_HOST=gate-server         # Hostname or IP address
export DEPLOY_PORT=22                  # SSH port (default: 22)
export DEPLOY_PATH=~/secondlayer       # Deployment path on server
```

Alternatively, create a `.deploy.env` file:
```bash
DEPLOY_USER=ubuntu
DEPLOY_HOST=your-server.example.com
DEPLOY_PORT=22
DEPLOY_PATH=~/secondlayer
```

Then source it before deployment:
```bash
source .deploy.env
```

### 3. Deploy to Server

Run the deployment script:

```bash
./deploy.sh deploy
```

This will:
1. ✅ Verify prerequisites (SSH, .env.production)
2. 📦 Create deployment package (source code, configs)
3. 🚀 Copy to gate server
4. 🛑 Stop existing containers (if any)
5. 🐳 Pull Docker images
6. 🔨 Build application image
7. ▶️ Start all services
8. ✅ Verify deployment

### 4. Verify Deployment

Check service status:
```bash
./deploy.sh status
```

View logs:
```bash
./deploy.sh logs
```

Test the API:
```bash
curl http://your-server:3000/health
```

## Deployment Commands

### Deploy Application
```bash
./deploy.sh deploy
```

### Check Service Status
```bash
./deploy.sh status
```

Sample output:
```
NAME                         COMMAND                  SERVICE    STATUS         PORTS
secondlayer-app-prod         "docker-entrypoint.s…"   app        Up 2 minutes   0.0.0.0:3000->3000/tcp
secondlayer-postgres-prod    "docker-entrypoint.s…"   postgres   Up 2 minutes   0.0.0.0:5432->5432/tcp
secondlayer-qdrant-prod      "/qdrant/qdrant"         qdrant     Up 2 minutes   0.0.0.0:6333-6334->6333-6334/tcp
secondlayer-redis-prod       "docker-entrypoint.s…"   redis      Up 2 minutes   0.0.0.0:6379->6379/tcp
```

### View Logs
```bash
./deploy.sh logs
```

This will stream live logs from all services.

## Manual Server Management

If you need to manage services directly on the server:

### SSH into Server
```bash
ssh ubuntu@gate-server
cd ~/secondlayer/secondlayer
```

### Docker Compose Commands
```bash
# View all containers
docker-compose ps

# View logs
docker-compose logs -f app              # App logs only
docker-compose logs -f                  # All services

# Restart a service
docker-compose restart app

# Stop all services
docker-compose down

# Start all services
docker-compose up -d

# Rebuild and restart
docker-compose up -d --build

# View resource usage
docker stats
```

### Database Access
```bash
# Connect to PostgreSQL
docker exec -it secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db

# Backup database
docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db > backup.sql

# Restore database
cat backup.sql | docker exec -i secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db
```

### Redis Commands
```bash
# Connect to Redis CLI
docker exec -it secondlayer-redis-prod redis-cli

# Check memory usage
docker exec secondlayer-redis-prod redis-cli INFO memory

# Clear cache
docker exec secondlayer-redis-prod redis-cli FLUSHALL
```

### Qdrant Management
```bash
# View Qdrant collections
curl http://localhost:6333/collections

# Check Qdrant health
curl http://localhost:6333/
```

## Troubleshooting

### Deployment Fails

**Error: .env.production not found**
```bash
# Create from template
cp .env.production.template .env.production
# Edit and fill in actual values
nano .env.production
```

**Error: Permission denied (publickey)**
```bash
# Add your SSH key to the server
ssh-copy-id ubuntu@gate-server

# Or specify a different key
ssh -i ~/.ssh/your-key ubuntu@gate-server
```

### Container Issues

**Container exits immediately**
```bash
# Check logs for errors
docker-compose logs app

# Check environment variables
docker-compose exec app env | grep OPENAI
```

**Out of memory**
```bash
# Check memory usage
docker stats

# Increase server RAM or adjust resource limits in docker-compose.prod.yml
```

**Port already in use**
```bash
# Check what's using the port
sudo lsof -i :3000

# Or change the port in docker-compose.prod.yml
```

### Database Issues

**Database connection refused**
```bash
# Verify PostgreSQL is running
docker-compose ps postgres

# Check PostgreSQL logs
docker-compose logs postgres

# Verify credentials in .env.production
```

**Database not initialized**
```bash
# Run migrations manually
docker-compose exec app npm run migrate
```

### API Issues

**401 Unauthorized**
- Verify `SECONDARY_LAYER_KEYS` in `.env.production`
- Check Authorization header: `Authorization: Bearer <your-key>`

**OpenAI errors**
- Verify API key is valid
- Check API key has sufficient credits
- View logs: `docker-compose logs app | grep OpenAI`

**ZakonOnline errors**
- Verify API token is active
- Check if token has rate limits
- View logs: `docker-compose logs app | grep Zakon`

## Security Considerations

### Firewall Configuration
```bash
# On the gate server, configure firewall
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 3000/tcp    # Application API

# DO NOT expose database ports publicly
# sudo ufw deny 5432/tcp
# sudo ufw deny 6379/tcp
# sudo ufw deny 6333/tcp
```

### SSL/TLS Configuration

For production, use a reverse proxy (Nginx, Caddy, Traefik) with SSL:

**Example Nginx Configuration:**
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Environment Variables Security

**Never commit `.env.production` to git!**

Add to `.gitignore`:
```
.env.production
*.env.production
```

### Regular Backups

Create a backup script on the server:
```bash
#!/bin/bash
# /home/ubuntu/backup.sh

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/home/ubuntu/backups"

mkdir -p $BACKUP_DIR

# Backup PostgreSQL
docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db | gzip > $BACKUP_DIR/db_$DATE.sql.gz

# Backup Qdrant data
docker exec secondlayer-qdrant-prod tar czf - /qdrant/storage > $BACKUP_DIR/qdrant_$DATE.tar.gz

# Keep only last 7 days of backups
find $BACKUP_DIR -type f -mtime +7 -delete
```

Schedule with cron:
```bash
# Run daily at 2 AM
0 2 * * * /home/ubuntu/backup.sh
```

## Monitoring

### Health Checks

The application provides health endpoints:
- `GET /health` - Basic health check

### Resource Monitoring

Install monitoring tools on the server:
```bash
# Install htop for process monitoring
sudo apt install htop

# Install ctop for container monitoring
sudo wget https://github.com/bcicen/ctop/releases/download/v0.7.7/ctop-0.7.7-linux-amd64 -O /usr/local/bin/ctop
sudo chmod +x /usr/local/bin/ctop

# Run ctop
ctop
```

### Log Management

To prevent logs from filling disk space:
```bash
# Configure Docker log rotation in /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}

# Restart Docker
sudo systemctl restart docker
```

## Updates and Maintenance

### Updating the Application

1. Update code locally
2. Run deployment script:
```bash
./deploy.sh deploy
```

The script will automatically:
- Stop old containers
- Deploy new code
- Build and start new containers

### Updating Dependencies

Update Docker images:
```bash
# On the server
cd ~/secondlayer/secondlayer
docker-compose pull
docker-compose up -d
```

### Database Migrations

Run migrations after deployment:
```bash
# On the server
docker-compose exec app npm run migrate
```

## Architecture Overview

The deployment includes 4 services:

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| **app** | Custom (Node.js 20) | 3000 | MCP API server |
| **postgres** | postgres:15-alpine | 5432 | Document metadata & structured data |
| **qdrant** | qdrant/qdrant:latest | 6333, 6334 | Vector embeddings storage |
| **redis** | redis:7-alpine | 6379 | Caching layer |

### Data Persistence

All data is stored in Docker volumes:
- `postgres_data` - PostgreSQL database
- `qdrant_data` - Vector embeddings
- `redis_data` - Cache data
- `app_data` - Application data

These volumes persist across container restarts.

## Support

For issues or questions:
- Check logs: `./deploy.sh logs`
- Review this documentation
- Check the main project documentation in `/Users/vovkes/ZOMCP/SecondLayer/CLAUDE.md`

## Additional Resources

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Qdrant Documentation](https://qdrant.tech/documentation/)
- [Redis Documentation](https://redis.io/documentation)
