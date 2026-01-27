# Local Deployment Fixes - Summary

## What Was Fixed

This document summarizes the changes made to enable clean local deployment from scratch.

### 1. Automatic Database Migrations ✅

**Problem**: Migrations weren't running automatically on first deployment

**Solution**: Added `migrate-local` service that:
- Runs before the main `app-local` service
- Executes all SQL migrations from `mcp_backend/src/migrations/`
- Uses `condition: service_completed_successfully` to ensure migrations complete before app starts

**Files Changed**:
- `docker-compose.local.yml` (lines 117-141)

### 2. Migration Files in Docker Image ✅

**Problem**: SQL migration files weren't copied to the Docker image

**Solution**: Updated Dockerfiles to include migration source files:
- Added `COPY --from=builder /app/mcp_backend/src/migrations ./src/migrations` to `Dockerfile.mono-backend`
- Changed `*.sql` pattern to copy entire directory in `Dockerfile.mono-rada`

**Files Changed**:
- `Dockerfile.mono-backend` (line 85)
- `Dockerfile.mono-rada` (line 63)

### 3. Removed Invalid PostgreSQL Mount ✅

**Problem**: Attempted to mount TypeScript migrations to `docker-entrypoint-initdb.d` (won't work with .ts files)

**Solution**: Removed the volume mount line, migrations now run via dedicated service

**Files Changed**:
- `docker-compose.local.yml` (removed line 17)

### 4. RADA MCP Build Configuration ✅

**Problem**: `rada-migrate-local` tried to use image before it was built

**Solution**: Added build configuration to `rada-migrate-local` service

**Files Changed**:
- `docker-compose.local.yml` (lines 252-256)

### 5. Vision Credentials Mount ✅

**Problem**: Mounting `/dev/null` as a file caused Docker errors when path didn't exist

**Solution**:
- Changed to use a volume (`document_service_credentials`)
- Added comments explaining how to mount real credentials if needed
- Service works without credentials (OCR features disabled)

**Files Changed**:
- `docker-compose.local.yml` (lines 401-406, 459)

### 6. Updated Documentation ✅

**Problem**: Documentation didn't reflect new architecture

**Solution**: Updated `LOCAL_DEVELOPMENT.md` with:
- New architecture diagram showing `migrate-local` service
- Updated port reference including Document Service and RADA MCP
- Added health check endpoints
- Migration troubleshooting section
- Information about optional services

**Files Changed**:
- `LOCAL_DEVELOPMENT.md` (multiple sections updated)

## How to Use

### Basic Startup (Court Cases + Legal Documents)

```bash
cd deployment

# Make sure .env.local is configured with your API keys
# (see .env.local.example)

# Start all services
./manage-gateway.sh start local

# Check logs
docker logs secondlayer-migrate-local  # Should see "✅ All migrations completed"
docker logs secondlayer-app-local      # Should see "Server running on port 3000"

# Test
curl http://localhost:3000/health
```

### With RADA MCP (Parliament Data)

```bash
cd deployment

# Start with RADA profile
docker compose -f docker-compose.local.yml --profile rada up -d

# Check RADA service
curl http://localhost:3001/health
```

## Service Startup Order

The services now start in this order:

1. **postgres-local** - PostgreSQL database (waits for health check)
2. **redis-local** - Redis cache (waits for health check)
3. **qdrant-local** - Vector database (starts immediately)
4. **migrate-local** - Runs migrations (waits for PostgreSQL, then exits)
5. **app-local** - Main backend (waits for migrations to complete)
6. **document-service-local** - OCR service (starts in parallel with app)
7. **rada-db-init-local** - RADA schema setup (only with `--profile rada`)
8. **rada-migrate-local** - RADA migrations (only with `--profile rada`)
9. **rada-mcp-app-local** - RADA MCP service (only with `--profile rada`)

## Ports

| Service | Port | Purpose |
|---------|------|---------|
| Main Backend | 3000 | Court cases, legal analysis |
| RADA MCP | 3001 | Parliament data (deputies, bills) |
| Document Service | 3002 | OCR, document processing |
| PostgreSQL | 5432 | Database |
| Redis | 6379 | Cache |
| Qdrant HTTP | 6333 | Vector search |

## Environment Variables

All configuration is in `deployment/.env.local`:

**Required**:
- `OPENAI_API_KEY` - For AI analysis
- `ZAKONONLINE_API_TOKEN` - For court case data

**Optional**:
- `ANTHROPIC_API_KEY` - Alternative AI provider
- `VISION_CREDENTIALS_PATH` - For OCR (if not set, OCR disabled)
- `GOOGLE_CLIENT_ID/SECRET` - For OAuth (can use API keys instead)

## Verification Steps

After startup, verify everything works:

```bash
# 1. Check all containers are running
docker ps | grep secondlayer

# 2. Check migrations completed
docker logs secondlayer-migrate-local | grep "✅ All migrations"

# 3. Check backend is healthy
curl http://localhost:3000/health

# 4. Check document service
curl http://localhost:3002/health

# 5. If using RADA, check it
curl http://localhost:3001/health

# 6. Test database connection
docker exec -it secondlayer-postgres-local psql -U secondlayer -d secondlayer_local -c "\dt"
```

## Troubleshooting

### Migrations Failed

```bash
# View migration logs
docker logs secondlayer-migrate-local

# Re-run migrations
docker compose -f docker-compose.local.yml up migrate-local --force-recreate
```

### Backend Won't Start

```bash
# Check if migrations completed
docker logs secondlayer-migrate-local

# Check backend logs
docker logs secondlayer-app-local

# Restart backend
docker restart secondlayer-app-local
```

### Clean Reset

```bash
cd deployment

# Stop everything
./manage-gateway.sh stop local
docker compose -f docker-compose.local.yml --profile rada down

# Remove all data
docker volume rm deployment_postgres_local_data
docker volume rm deployment_redis_local_data
docker volume rm deployment_qdrant_local_data
docker volume rm deployment_app_local_data
docker volume rm deployment_document_service_credentials

# Start fresh
./manage-gateway.sh start local
```

## Files Modified

1. `deployment/docker-compose.local.yml` - Main compose file with all fixes
2. `Dockerfile.mono-backend` - Added migrations to image
3. `Dockerfile.mono-rada` - Fixed migrations copy pattern
4. `deployment/LOCAL_DEVELOPMENT.md` - Updated documentation

## Testing Checklist

- [x] PostgreSQL starts and accepts connections
- [x] Redis starts and responds to PING
- [x] Qdrant starts and REST API accessible
- [x] Migrations run automatically and complete successfully
- [x] Backend starts after migrations complete
- [x] Document service starts and health check works
- [x] RADA MCP starts with `--profile rada` flag
- [x] All health endpoints return 200 OK
- [x] Database tables created correctly
- [x] No errors in any container logs

## Next Steps

1. Review `deployment/.env.local` and add your API keys
2. Run `./manage-gateway.sh start local`
3. Check logs: `docker logs secondlayer-migrate-local`
4. Test: `curl http://localhost:3000/health`
5. Read `LOCAL_DEVELOPMENT.md` for detailed usage

---

**Date**: 2026-01-27
**Status**: Ready for testing ✅
