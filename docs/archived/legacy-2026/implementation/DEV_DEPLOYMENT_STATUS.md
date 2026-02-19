# Dev Deployment Status - BLOCKED

**Date:** 2026-02-06 00:10  
**Status:** ❌ BLOCKED - Insufficient disk space on gate server  
**Branch:** main  
**Commits:** 2 commits ready to deploy

## Issue

Gate server disk is 99% full (30GB total, 1.4GB free). Docker build requires ~3-4GB temporary space but fails with "no space left on device" error during image build.

## Disk Usage Analysis

### System Disk (/dev/xvda1 - 30GB)
```
Filesystem      Size  Used Avail Use% Mounted on
/dev/xvda1       30G   27G  1.4G  96% /
```

### Docker Resources
```
Images:         11.55GB (active containers)
Build Cache:    2.52GB (cleaned)
Volumes:        611MB (active)
Containers:     2.49MB (19 running)
```

### Home Directory (~3GB in old deployments)
```
1.5GB  /home/vovkes/SecondLayer (OLD REPO?)
606MB  /home/vovkes/secondlayer-deployment (OLD?)
390MB  /home/vovkes/court-registry-mcp (OLD?)
310MB  /home/vovkes/system5-microservices (OLD?)
170MB  /home/vovkes/secondlayer (OLD?)
```

### System Logs
```
3.0GB  /var/log/journal (cannot clean further)
```

## What Was Done

### Successful
1. ✅ Freed 2.5GB by cleaning Docker build cache
2. ✅ Freed 1GB by cleaning apt cache  
3. ✅ Git commits pushed to GitHub
4. ✅ Source code synced to gate server
5. ✅ Deployment script executed

### Failed
❌ Docker image build fails with "no space left on device"

## Deployment Script Behavior

The `manage-gateway.sh deploy dev` script:
1. ✅ Syncs code via rsync
2. ✅ SSHs to gate server
3. ✅ Stops old containers (`docker compose down`)
4. ✅ Cleans stopped containers
5. ✅ Prunes old images
6. ❌ **FAILS HERE:** `docker compose build --no-cache` runs out of space

## Current Dev Containers Status

```
NAMES                      STATUS                  
secondlayer-app-dev        Up 2 days               
secondlayer-postgres-dev   Up 2 days               
openreyestr-app-dev        Up 2 days (healthy)     
lexwebapp-dev              Up 2 days (unhealthy)   
openreyestr-postgres-dev   Up 2 days (healthy)     
secondlayer-redis-dev      Up 2 days (healthy)     
secondlayer-qdrant-dev     Up 2 days              
```

**Note:** Containers are still running with OLD code (from 2 days ago).

## Options to Proceed

### Option 1: Clean Old Deployment Directories (RECOMMENDED)
**Impact:** Remove ~2.7GB  
**Risk:** Low if directories are confirmed old

```bash
ssh vovkes@gate.lexapp.co.ua "
  # Backup first (optional)
  tar -czf /tmp/old-deployments-backup.tar.gz /home/vovkes/SecondLayer /home/vovkes/secondlayer-deployment /home/vovkes/court-registry-mcp

  # Remove old directories
  rm -rf /home/vovkes/SecondLayer  # 1.5GB
  rm -rf /home/vovkes/secondlayer-deployment  # 606MB
  rm -rf /home/vovkes/court-registry-mcp  # 390MB
  rm -rf /home/vovkes/system5-microservices  # 310MB
  rm -rf /home/vovkes/secondlayer-source  # 8MB
"

# Then retry deployment
cd /home/vovkes/SecondLayer/deployment
./manage-gateway.sh deploy dev
```

**Pros:** Simple, immediate, likely safe  
**Cons:** Need to verify directories are truly old

### Option 2: Expand Disk on Gate Server
**Impact:** Add 20-50GB  
**Risk:** Requires server admin access, potential downtime

**Pros:** Permanent solution, no data loss  
**Cons:** Requires infrastructure changes, may cost money

### Option 3: Build Images Locally, Push to Registry
**Impact:** No disk usage on gate server during build  
**Risk:** Requires Docker registry setup

```bash
# Local machine
cd /home/vovkes/SecondLayer
docker build -f mcp_backend/Dockerfile -t secondlayer-app:latest .
docker tag secondlayer-app:latest registry.example.com/secondlayer-app:latest
docker push registry.example.com/secondlayer-app:latest

# Gate server
ssh vovkes@gate.lexapp.co.ua "
  docker pull registry.example.com/secondlayer-app:latest
  docker tag registry.example.com/secondlayer-app:latest secondlayer-app:latest
  cd /home/vovkes/secondlayer/deployment
  docker compose -f docker-compose.dev.yml up -d
"
```

**Pros:** Offloads build to local machine  
**Cons:** Requires registry setup (Docker Hub, GitHub Registry, etc.)

### Option 4: Manual Hot Update (QUICK FIX, NOT RECOMMENDED)
**Impact:** Update code in running containers without rebuild  
**Risk:** Medium - inconsistent state, potential issues

```bash
ssh vovkes@gate.lexapp.co.ua "
  cd /home/vovkes/secondlayer/deployment

  # Copy new files to containers
  docker exec secondlayer-app-dev mkdir -p /app/mcp_backend/src/middleware
  docker cp mcp_backend/src/middleware/rate-limit.ts secondlayer-app-dev:/app/mcp_backend/src/middleware/
  docker cp mcp_backend/src/http-server.ts secondlayer-app-dev:/app/mcp_backend/src/

  # Rebuild and restart
  docker exec secondlayer-app-dev sh -c 'cd /app/mcp_backend && npm run build'
  docker restart secondlayer-app-dev

  # Same for openreyestr
  docker exec openreyestr-app-dev mkdir -p /app/mcp_openreyestr/src/middleware
  docker cp mcp_openreyestr/src/middleware/rate-limit.ts openreyestr-app-dev:/app/src/middleware/
  docker cp mcp_openreyestr/src/http-server.ts openreyestr-app-dev:/app/src/
  docker exec openreyestr-app-dev sh -c 'cd /app && npm run build'
  docker restart openreyestr-app-dev
"
```

**Pros:** Quick, no disk space needed  
**Cons:** Fragile, might fail due to dependencies, not reproducible

### Option 5: Deploy to Staging/Prod First (if they have more space)
**Impact:** Test deployment on different environment  
**Risk:** Skips dev testing

Check disk space on stage/prod:
```bash
ssh vovkes@gate.lexapp.co.ua "df -h /"
```

If stage/prod have more space, deploy there first for testing.

## Recommended Action

**RECOMMENDED:** Option 1 - Clean old deployment directories

1. **Verify directories are old:**
   ```bash
   ssh vovkes@gate.lexapp.co.ua "ls -la /home/vovkes/SecondLayer"
   ssh vovkes@gate.lexapp.co.ua "ls -la /home/vovkes/secondlayer-deployment"
   ```

2. **Remove old directories:**
   ```bash
   ssh vovkes@gate.lexapp.co.ua "rm -rf /home/vovkes/SecondLayer /home/vovkes/secondlayer-deployment /home/vovkes/court-registry-mcp"
   ```

3. **Verify free space:**
   ```bash
   ssh vovkes@gate.lexapp.co.ua "df -h /"
   ```

4. **Retry deployment:**
   ```bash
   cd /home/vovkes/SecondLayer/deployment
   ./manage-gateway.sh deploy dev
   ```

## Changes Waiting to Deploy

### mcp_backend
- ✅ Required auth on SSE endpoints (/sse, /v1/sse)
- ✅ Rate limiting middleware (Redis-based)
- ✅ Rate limits on /health (60/min), /mcp (30/min), webhooks (10/min)

### mcp_openreyestr
- ✅ Rate limiting on /health endpoint

### mcp_rada
- ⚠️ Not deployed (not in dev environment)

## Rollback Status

No rollback needed - old containers still running with old code.

## Next Steps

1. **USER DECISION:** Choose option (1, 2, 3, 4, or 5)
2. Execute chosen option
3. Retry deployment
4. Verify health checks
5. Test authentication and rate limiting

---

**Status:** Awaiting user decision on disk space cleanup  
**ETA:** 10-15 minutes after decision  
**Risk:** Low (changes isolated to dev environment)
