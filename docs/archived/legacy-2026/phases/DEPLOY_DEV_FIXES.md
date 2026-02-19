# Development Environment Deployment - Fixed Issues

## Summary

Fixed deployment configuration for the development environment to ensure proper Docker service connectivity.

## Issues Fixed

### 1. `.env.dev` - Incorrect Container Hostnames

**Problem:** The `.env.dev` file was pointing to `-local` container names instead of `-dev` container names, which would cause service connectivity failures in the dev environment.

**Fixed:**
- ✅ `RADA_MCP_URL`: Changed from `http://rada-mcp-app-local:3001` → `http://rada-mcp-app-dev:3001`
- ✅ `REDIS_HOST`: Changed from `redis-local` → `redis-dev`
- ✅ `QDRANT_URL`: Changed from `http://qdrant-local:6333` → `http://qdrant-dev:6333`

### 2. Created `deploy-dev.sh` Convenience Script

**New File:** `scripts/deploy/deploy-dev.sh`

A standalone deployment script similar to `deploy-local.sh` that:
- Validates configuration files exist
- Shows deployment summary
- Prompts for confirmation
- Calls `manage-gateway.sh deploy dev` to execute deployment
- Provides next steps after completion

## Deployment Methods

### Method 1: Using manage-gateway.sh (Recommended)

```bash
cd deployment
./manage-gateway.sh deploy dev
```

This is the comprehensive script that handles:
- Pre-flight checks
- Backup creation
- Remote git pull on gate.lexapp.co.ua
- Docker image builds (--no-cache)
- Database migrations
- Service startup
- Smoke tests
- Rollback on failure

### Method 2: Using deploy-dev.sh (Convenience wrapper)

```bash
cd scripts/deploy
./deploy-dev.sh
```

This wraps `manage-gateway.sh deploy dev` with a nicer interface.

## Environment Configuration

### Development Environment (dev)
- **Server:** gate.lexapp.co.ua
- **Public URL:** https://dev.legal.org.ua
- **Env File:** `deployment/.env.dev`
- **Compose File:** `deployment/docker-compose.dev.yml`
- **Container Suffix:** `-dev`

### Port Mapping (Dev)
- Backend (app-dev): 3003
- RADA MCP: 3001
- OpenReyestr: 3005
- Frontend: 8091 → 80
- Document Service: 3006 → 3002
- PostgreSQL: 5433 → 5432
- Redis: 6380 → 6379
- Qdrant: 6335:6333, 6336:6334
- MinIO S3: 9002 → 9000
- MinIO Console: 9003 → 9001
- OpenReyestr DB: 5437 → 5432

## Deployment Process

The `manage-gateway.sh deploy dev` command executes:

1. **Pre-flight Checks** (lib/preflight.sh)
   - Verify .env.dev exists
   - Validate docker-compose.dev.yml
   - Check SSH connectivity to gate.lexapp.co.ua

2. **Backup** (lib/backup.sh)
   - Create timestamped backup of current deployment
   - Store in /home/vovkes/SecondLayer/backups/

3. **Deploy**
   - Git pull latest code on remote server
   - Copy .env.dev to server
   - Stop existing containers
   - Clean up stopped containers and dangling images
   - Pre-build shared package and backend dist
   - Build ALL images without cache
   - Start infrastructure (PostgreSQL, Redis, Qdrant, MinIO)
   - Initialize RADA schema/user
   - Run migrations sequentially (backend → RADA → OpenReyestr)
   - Start application services
   - Start monitoring services (Prometheus, Grafana, exporters)

4. **Smoke Tests** (lib/smoke-test.sh)
   - Verify containers are running
   - Check health endpoints
   - Validate service connectivity

5. **Report** (lib/report.sh)
   - Generate deployment report
   - Show container status
   - Rollback on failure

## Service Dependencies (dev environment)

```
Infrastructure Layer:
├── postgres-dev (5433)
├── postgres-openreyestr-dev (5437)
├── redis-dev (6380)
├── qdrant-dev (6335-6336)
└── minio-dev (9002-9003)

Database Initialization:
└── rada-db-init-dev (creates RADA schema in main DB)

Migration Layer:
├── migrate-dev (backend migrations)
├── rada-migrate-dev (RADA migrations)
└── migrate-openreyestr-dev (OpenReyestr migrations)

Application Layer:
├── app-dev (main backend, port 3003)
├── rada-mcp-app-dev (RADA service, port 3001)
├── app-openreyestr-dev (registry service, port 3005)
├── document-service-dev (doc processing, port 3006)
└── lexwebapp-dev (frontend, port 8091)

Monitoring (optional):
├── prometheus-dev (9090)
├── grafana-dev (3100)
├── postgres-exporter-backend (9187)
├── postgres-exporter-openreyestr (9188)
├── redis-exporter (9121)
└── node-exporter (9100)
```

## Verification Commands

After deployment:

```bash
# Check container status
cd deployment
./manage-gateway.sh status

# View logs
./manage-gateway.sh logs dev

# Check health
./manage-gateway.sh health

# Test endpoints
curl https://dev.legal.org.ua/health
curl https://dev.legal.org.ua/
curl https://dev.legal.org.ua:3005/health
```

## Troubleshooting

### Container fails to start
```bash
# Check logs
ssh vovkes@gate.lexapp.co.ua
cd /home/vovkes/SecondLayer/deployment
docker compose -f docker-compose.dev.yml --env-file .env.dev logs <container-name>
```

### Migration fails
```bash
# Re-run migrations manually
ssh vovkes@gate.lexapp.co.ua
cd /home/vovkes/SecondLayer/deployment
docker compose -f docker-compose.dev.yml --env-file .env.dev up migrate-dev
```

### Service connectivity issues
- Verify .env.dev has correct hostnames (use `-dev` suffix, not `-local`)
- Check containers are on the same Docker network: `secondlayer-dev-network`
- Verify container names match environment variable values

## Related Files

- `deployment/.env.dev` - Environment configuration
- `deployment/docker-compose.dev.yml` - Service definitions
- `deployment/manage-gateway.sh` - Main deployment orchestrator
- `deployment/lib/preflight.sh` - Pre-deployment validation
- `deployment/lib/backup.sh` - Backup management
- `deployment/lib/smoke-test.sh` - Post-deployment tests
- `deployment/lib/report.sh` - Deployment reporting
- `scripts/deploy/deploy-dev.sh` - Convenience wrapper script

## Old Scripts (Deprecated)

- `scripts/deploy/deploy-to-gate.sh` - **DEPRECATED** - Uses rsync/PM2 instead of Docker
  - This script is for the old non-Docker deployment method
  - Should not be used for current deployments
  - Kept for reference only
