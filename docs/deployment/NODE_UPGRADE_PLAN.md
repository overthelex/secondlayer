# Node.js 20 Production Upgrade Plan

## Overview

This document outlines the plan to ensure all production environments are running with Node.js 20+ following the codebase upgrade completed in commit `0d31ce9`.

## Current Status

### Code Changes ✅ COMPLETED
- All package.json files updated with `engines.node >= 20.0.0`
- All Dockerfiles updated to use `node:20-alpine`
- .nvmrc created with version 20
- Documentation updated
- Committed and pushed to main branch

### Docker Images Status

**Backend Images:**
- `mcp_backend/Dockerfile` - ✅ Uses `node:20-alpine` (line 1)
- `Dockerfile.mono-backend` - ✅ Uses `node:20-alpine` (lines 1, 39)

**Frontend Image:**
- `lexwebapp/Dockerfile` - ✅ Uses `node:20-alpine` (line 3)

**Used in Production:**
- `secondlayer-app:latest` (built from mcp_backend/Dockerfile)
- `lexwebapp-lexwebapp:latest` (built from lexwebapp/Dockerfile)

## Deployment Architecture

**Gate Server:** `gate.lexapp.co.ua`
**SSH User:** `root`
**Remote Path:** `/root/secondlayer-deployment`

### Environments

| Environment | URL | Backend Port | PostgreSQL | Redis |
|------------|-----|--------------|------------|-------|
| Production | legal.org.ua | 3001 | 5432 | 6379 |
| Staging | stage.legal.org.ua | 3002 | 5434 | 6381 |
| Development | dev.legal.org.ua | 3003 | 5433 | 6380 |

## Action Required

### Step 1: Rebuild Docker Images (LOCAL)

The Docker images need to be rebuilt with the updated package.json files that now enforce Node.js 20+.

```bash
cd /home/vovkes/SecondLayer/deployment

# Build both images
./manage-gateway.sh build
```

**This creates:**
- `secondlayer-app:latest` (with Node 20 + updated engines requirement)
- `lexwebapp-lexwebapp:latest` (with Node 20)

### Step 2: Transfer Images to Gate Server

**Problem:** Current `manage-gateway.sh` does NOT transfer Docker images to gate server. The `deploy` command only copies compose files.

**Solution Options:**

#### Option A: Build on Gate Server (RECOMMENDED)
Copy source code to gate and build images there:

```bash
# 1. SSH to gate server
ssh root@gate.lexapp.co.ua

# 2. Update source code
cd /root/secondlayer-deployment
git pull origin main

# 3. Build images on gate
cd mcp_backend
docker build -t secondlayer-app:latest .

cd ../lexwebapp
docker build -t lexwebapp-lexwebapp:latest .
```

#### Option B: Save/Load Images
Transfer images from local to gate:

```bash
# LOCAL: Save images
docker save secondlayer-app:latest | gzip > secondlayer-app.tar.gz
docker save lexwebapp-lexwebapp:latest | gzip > lexwebapp.tar.gz

# Transfer to gate
scp secondlayer-app.tar.gz root@gate.lexapp.co.ua:/tmp/
scp lexwebapp.tar.gz root@gate.lexapp.co.ua:/tmp/

# GATE: Load images
ssh root@gate.lexapp.co.ua
docker load < /tmp/secondlayer-app.tar.gz
docker load < /tmp/lexwebapp.tar.gz
rm /tmp/*.tar.gz
```

#### Option C: Docker Registry (FUTURE)
Set up Docker registry for proper CI/CD pipeline (not implemented yet).

### Step 3: Redeploy Environments

Once images are updated on gate server, redeploy containers:

```bash
# From local machine
cd /home/vovkes/SecondLayer/deployment

# Deploy to all environments
./manage-gateway.sh deploy all

# Or deploy individually
./manage-gateway.sh deploy prod
./manage-gateway.sh deploy stage
./manage-gateway.sh deploy dev
```

### Step 4: Verify Node.js Version

Check that containers are running Node.js 20:

```bash
# SSH to gate
ssh root@gate.lexapp.co.ua

# Check production backend
docker exec secondlayer-app-prod node --version
# Expected: v20.x.x

# Check staging backend
docker exec secondlayer-app-stage node --version
# Expected: v20.x.x

# Check dev backend
docker exec secondlayer-app-dev node --version
# Expected: v20.x.x

# Check frontend builds (they use node at build time only)
docker logs secondlayer-lexwebapp-prod 2>&1 | grep -i "node"
```

### Step 5: Health Checks

Verify all services are healthy:

```bash
# From local machine
cd /home/vovkes/SecondLayer/deployment
./manage-gateway.sh health
```

**Or manually:**
```bash
# Production
curl https://legal.org.ua/health
curl https://legal.org.ua/

# Staging
curl https://stage.legal.org.ua/health
curl https://stage.legal.org.ua/

# Development
curl https://dev.legal.org.ua/health
curl https://dev.legal.org.ua/
```

## Host Node.js Requirements

**IMPORTANT:** The gate server host does NOT need Node.js 20 installed because:
- All applications run inside Docker containers
- Containers have their own Node.js runtime (node:20-alpine)
- No processes run directly on the host

**Host only needs:**
- Docker
- Docker Compose
- Git (to pull updates)

## Rollback Plan

If issues occur after deployment:

### Rollback Code
```bash
# LOCAL
cd /home/vovkes/SecondLayer
git revert 0d31ce9  # Node.js 20 upgrade commit
git revert 6f1745b  # Security fixes commit (if Node 20 issues)
git push origin main
```

### Rebuild Old Images
```bash
# On gate or local (after code rollback)
cd mcp_backend
docker build -t secondlayer-app:latest .

cd ../lexwebapp
docker build -t lexwebapp-lexwebapp:latest .
```

### Redeploy
```bash
./manage-gateway.sh deploy all
```

## Testing Strategy

### Pre-Deployment Tests (Local)
```bash
# 1. Build images locally
./manage-gateway.sh build

# 2. Test backend container
docker run --rm secondlayer-app:latest node --version
# Should output: v20.x.x

# 3. Test backend startup
docker run --rm -e DATABASE_URL=test secondlayer-app:latest node --help
```

### Post-Deployment Tests (Gate)
```bash
# 1. Verify versions
ssh root@gate.lexapp.co.ua
docker exec secondlayer-app-prod node --version

# 2. Check logs for errors
docker logs secondlayer-app-prod --tail 100

# 3. Test API endpoints
curl https://legal.org.ua/health -v

# 4. Monitor for 1 hour
watch -n 60 'docker ps --filter name=secondlayer'
```

## Timeline

| Phase | Duration | Status |
|-------|----------|--------|
| Code Update | COMPLETED | ✅ |
| Local Build | 10 minutes | ⏳ Pending |
| Image Transfer | 15 minutes | ⏳ Pending |
| Deploy Dev | 5 minutes | ⏳ Pending |
| Test Dev | 30 minutes | ⏳ Pending |
| Deploy Stage | 5 minutes | ⏳ Pending |
| Test Stage | 30 minutes | ⏳ Pending |
| Deploy Prod | 5 minutes | ⏳ Pending |
| Monitor Prod | 2 hours | ⏳ Pending |

**Total Estimated Time:** 3.5 hours

## Notes

- **Zero-downtime deployment:** Docker Compose automatically handles container replacement
- **Data persistence:** PostgreSQL, Redis, Qdrant data is in volumes (unaffected by Node.js upgrade)
- **Environment variables:** No .env changes needed
- **Nginx routing:** No nginx configuration changes needed

## Responsible

- **Execution:** DevOps/Backend team
- **Monitoring:** All team members
- **Approval:** Project lead

## Success Criteria

- [ ] All containers running Node.js 20.x.x
- [ ] All health checks passing
- [ ] No errors in logs
- [ ] All API endpoints responding
- [ ] No increase in error rates
- [ ] Response times within normal range

## References

- Node.js upgrade commit: `0d31ce9`
- Security fixes commit: `6f1745b`
- CLAUDE.md (Technology Stack section)
- deployment/GATEWAY_SETUP.md
