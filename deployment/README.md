# Production + Development Environments Deployment

This deployment setup creates two parallel environments on the gate server:
- **Production**: https://legal.org.ua/
- **Development**: https://legal.org.ua/development/

## Architecture

### Production Environment (existing)
- **lexwebapp**: Frontend on port 8090
- **secondlayer-app-prod**: Backend API on port 3001
- **secondlayer-postgres-prod**: PostgreSQL on port 5432
- **secondlayer-redis-prod**: Redis on port 6379
- **secondlayer-qdrant-prod**: Qdrant vector DB on ports 6333-6334

### Development Environment (new)
- **lexwebapp-dev**: Frontend on port 8091
- **secondlayer-app-dev**: Backend API on port 3002
- **secondlayer-postgres-dev**: PostgreSQL on port 5433
- **secondlayer-redis-dev**: Redis on port 6380
- **secondlayer-qdrant-dev**: Qdrant vector DB on ports 6335-6336

### Nginx Routing
- **legal-nginx-proxy**: Nginx container on port 8080
  - Routes `/` → production (ports 8090/3001)
  - Routes `/development/` → development (ports 8091/3002)
- **System nginx**: SSL termination and proxy to nginx container

## Files

- `docker-compose.dev.yml` - Development environment configuration
- `docker-compose.nginx-proxy.yml` - Nginx proxy container
- `nginx-proxy.conf` - Nginx routing configuration
- `nginx-legal.org.ua-updated.conf` - System nginx configuration
- `deploy-environments.sh` - Deployment script

## Deployment

### Prerequisites

1. SSH access to gate server configured in `~/.ssh/config`
2. `.env` file in parent directory with required environment variables
3. Docker and docker-compose installed on gate server

### Full Deployment

Deploy everything (development environment + nginx proxy + system nginx):

```bash
cd deployment
./deploy-environments.sh deploy
```

This will:
1. Copy all configuration files to gate server
2. Start development environment containers
3. Start nginx proxy container
4. Update system nginx configuration
5. Reload system nginx

### Partial Deployment

Start only development environment:
```bash
./deploy-environments.sh start-dev
```

Start only nginx proxy:
```bash
./deploy-environments.sh start-proxy
```

Update only system nginx:
```bash
./deploy-environments.sh update-nginx
```

### Check Status

View status of all containers:
```bash
./deploy-environments.sh status
```

### Stop Services

Stop development environment:
```bash
./deploy-environments.sh stop-dev
```

Stop nginx proxy:
```bash
./deploy-environments.sh stop-proxy
```

## URLs

After deployment:
- **Production**: https://legal.org.ua/
  - Frontend: Routes to lexwebapp (port 8090)
  - API: Routes to /api → secondlayer-app-prod (port 3001)

- **Development**: https://legal.org.ua/development/
  - Frontend: Routes to lexwebapp-dev (port 8091)
  - API: Routes to /development/api → secondlayer-app-dev (port 3002)

## Environment Variables

Development environment uses the same `.env` file as production, with these differences:

- `NODE_ENV=development`
- `LOG_LEVEL=debug`
- `POSTGRES_DB=secondlayer_dev` (separate database)
- `GOOGLE_CALLBACK_URL=https://legal.org.ua/development/auth/callback`
- `FRONTEND_URL=https://legal.org.ua/development`

## Troubleshooting

### Check container logs

Development backend:
```bash
ssh gate "cd ~/secondlayer-deployment && sudo docker logs -f secondlayer-app-dev"
```

Development frontend:
```bash
ssh gate "cd ~/secondlayer-deployment && sudo docker logs -f lexwebapp-dev"
```

Nginx proxy:
```bash
ssh gate "cd ~/secondlayer-deployment && sudo docker logs -f legal-nginx-proxy"
```

### Check nginx proxy configuration

```bash
ssh gate "cd ~/secondlayer-deployment && sudo docker exec legal-nginx-proxy nginx -t"
```

### Restart services

Development environment:
```bash
ssh gate "cd ~/secondlayer-deployment && sudo docker compose -f docker-compose.dev.yml restart"
```

Nginx proxy:
```bash
ssh gate "cd ~/secondlayer-deployment && sudo docker compose -f docker-compose.nginx-proxy.yml restart"
```

### Port conflicts

If ports are already in use, check what's using them:
```bash
ssh gate "sudo lsof -i :8091"  # Dev frontend
ssh gate "sudo lsof -i :3002"  # Dev backend
ssh gate "sudo lsof -i :8080"  # Nginx proxy
```

## Manual Steps on Server

If you need to manually manage services on the server:

```bash
# SSH to server
ssh gate

# Navigate to deployment directory
cd ~/secondlayer-deployment

# View all containers
sudo docker ps -a

# Start development environment
sudo docker compose -f docker-compose.dev.yml up -d

# Start nginx proxy
sudo docker compose -f docker-compose.nginx-proxy.yml up -d

# View logs
sudo docker compose -f docker-compose.dev.yml logs -f

# Restart a specific service
sudo docker compose -f docker-compose.dev.yml restart app-dev
```

## Rollback

To rollback system nginx configuration:

```bash
ssh gate "sudo cp /etc/nginx/sites-available/legal.org.ua.backup-* /etc/nginx/sites-available/legal.org.ua && sudo systemctl reload nginx"
```

To stop all development services:

```bash
./deploy-environments.sh stop-dev
./deploy-environments.sh stop-proxy
```

Then restore nginx config and reload.
