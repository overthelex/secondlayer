# Deployment Changes - Server Assignments

**Date:** 2026-02-06
**Status:** ✅ Implemented

## Summary

Реорганизовали deployment скрипты для правильного распределения окружений по серверам:

| Environment | Old Server | New Server | Change |
|-------------|-----------|------------|--------|
| **Local** | localhost | localhost | ✅ No change |
| **Dev** | gate.lexapp.co.ua | gate.lexapp.co.ua | ✅ No change |
| **Stage** | gate.lexapp.co.ua | mail.lexapp.co.ua | 🔄 **MOVED** |
| **Prod** | gate.lexapp.co.ua | mail.lexapp.co.ua | 🔄 **MOVED** |

---

## Changes Made

### 1. Updated `manage-gateway.sh`

#### Configuration
```bash
# Added mail server configuration
GATE_SERVER="gate.lexapp.co.ua"  # For dev environment
MAIL_SERVER="mail.lexapp.co.ua"  # For stage and prod environments
DEPLOY_USER="vovkes"              # Renamed from GATE_USER
```

#### Deployment Routing
- **Dev:** `./manage-gateway.sh deploy dev` → gate.lexapp.co.ua
- **Stage:** `./manage-gateway.sh deploy stage` → mail.lexapp.co.ua
- **Prod:** `./manage-gateway.sh deploy prod` → mail.lexapp.co.ua
- **Local:** No remote deployment (runs on localhost)

#### Health Checks
Updated to show correct server names:
- Production (mail.lexapp.co.ua)
- Staging (mail.lexapp.co.ua)
- Development (gate.lexapp.co.ua)
- Local (localhost)

### 2. Created `DEPLOYMENT_ENDPOINTS.md`

Comprehensive documentation covering:
- All MCP backend endpoints for each environment
- Frontend URLs
- Infrastructure ports (PostgreSQL, Redis, Qdrant)
- Authentication requirements
- Rate limits
- MCP client integration examples
- Health check commands

---

## Server Current State

### Gate Server (gate.lexapp.co.ua)

**Containers:**
```
✅ Dev Environment (6 containers):
   - secondlayer-app-dev
   - secondlayer-postgres-dev
   - openreyestr-postgres-dev
   - secondlayer-redis-dev
   - secondlayer-qdrant-dev
   - lexwebapp-dev (if deployed)

✅ Infrastructure (3 containers):
   - portainer_agent2
   - document-service-gate
   - legal-policies

❌ Stage Environment: REMOVED
❌ Prod Environment: Should NOT be here
```

### Mail Server (mail.lexapp.co.ua)

**Containers:**
```
✅ Stage Environment:
   - secondlayer-app-stage
   - secondlayer-postgres-stage
   - secondlayer-redis-stage
   - secondlayer-qdrant-stage
   - lexwebapp-stage

✅ Prod Environment:
   - secondlayer-app-prod
   - secondlayer-postgres-prod
   - secondlayer-redis-prod
   - secondlayer-qdrant-prod
   - lexwebapp-prod

✅ Infrastructure:
   - portainer_agent
```

---

## Migration Steps Completed

### ✅ 1. Removed Stage from Gate Server
- Stopped all stage containers
- Removed stage volumes (6 volumes)
- Removed stage network
- Removed docker-compose.stage.yml from gate server
- Freed ~100MB disk space

### ✅ 2. Updated Deployment Scripts
- Modified `manage-gateway.sh` to route deployments correctly
- Updated function `deploy_to_gate()` to select server based on environment
- Updated health checks to show correct server locations
- Updated usage documentation

### ✅ 3. Created Documentation
- `DEPLOYMENT_ENDPOINTS.md` - All endpoints for all environments
- `DEPLOYMENT_CHANGES.md` - This file

---

## Testing Deployment

### Test Dev Deployment (to Gate Server)
```bash
cd /home/vovkes/SecondLayer/deployment
./manage-gateway.sh deploy dev
```

Expected: Deploys to `gate.lexapp.co.ua`

### Test Stage Deployment (to Mail Server)
```bash
cd /home/vovkes/SecondLayer/deployment
./manage-gateway.sh deploy stage
```

Expected: Deploys to `mail.lexapp.co.ua`

### Test Prod Deployment (to Mail Server)
```bash
cd /home/vovkes/SecondLayer/deployment
./manage-gateway.sh deploy prod
```

Expected: Deploys to `mail.lexapp.co.ua`

### Check All Health
```bash
./manage-gateway.sh health
```

Expected output:
```
=== Production (mail.lexapp.co.ua) ===
✅ Backend: healthy
✅ Frontend: healthy

=== Staging (mail.lexapp.co.ua) ===
✅ Backend: healthy
✅ Frontend: healthy

=== Development (gate.lexapp.co.ua) ===
✅ Backend: healthy
✅ Frontend: healthy
✅ OpenReyestr: healthy
```

---

## Endpoints Reference

### Local (localhost)
- MCP Backend: http://localhost:3000
- Frontend: http://localhost:8080

### Dev (gate.lexapp.co.ua)
- MCP Backend: https://dev.legal.org.ua
- OpenReyestr: https://dev.legal.org.ua:3005
- Frontend: https://dev.legal.org.ua (port 8091)

### Stage (mail.lexapp.co.ua)
- MCP Backend: https://stage.legal.org.ua
- Frontend: https://stage.legal.org.ua (port 8092)

### Prod (mail.lexapp.co.ua)
- MCP Backend: https://legal.org.ua
- Frontend: https://legal.org.ua (port 8090)

---

## Next Steps

1. ✅ Update deployment scripts - DONE
2. ✅ Remove stage from gate server - DONE
3. ⏳ Test dev deployment to gate server
4. ⏳ Test stage deployment to mail server
5. ⏳ Test prod deployment to mail server
6. ⏳ Update team documentation
7. ⏳ Commit changes to git

---

## Files Modified

1. `/deployment/manage-gateway.sh` - Main deployment script
2. `/deployment/DEPLOYMENT_ENDPOINTS.md` - NEW - Endpoints documentation
3. `/deployment/DEPLOYMENT_CHANGES.md` - NEW - This file

---

## Rollback Plan

If issues occur, revert changes:

```bash
cd /home/vovkes/SecondLayer
git checkout HEAD -- deployment/manage-gateway.sh
```

Or manually restore old configuration:
```bash
GATE_SERVER="gate.lexapp.co.ua"
GATE_USER="vovkes"
# Remove MAIL_SERVER variable
# Revert deploy_to_gate function to always use GATE_SERVER
```

---

**Status:** Ready for testing
**Risk:** Low (only affects deployment routing, not runtime)
