# EULA System - Deployment Guide

This guide explains how to deploy the EULA (End User License Agreement) system to SecondLayer.

## What Was Added

### Backend Changes
- **New Migration**: `007_add_eula_acceptance.sql` - Creates tables for EULA tracking
- **New Service**: `eula-service.ts` - Manages EULA documents and acceptance
- **New Routes**: `eula.ts` - API endpoints for EULA operations
- **Updated**: `http-server.ts` - Registers EULA routes

### Frontend Changes
- **New Dependency**: `react-markdown` - For rendering markdown documents
- **New Context**: `EULAContext.tsx` - Global EULA state management
- **New Component**: `EULAModal.tsx` - Modal dialog for EULA acceptance
- **New Page**: `help/index.tsx` - Help & Documentation page
- **Updated**: `App.tsx` - Integrated EULA modal and help page

### Features
1. **First-Time EULA Acceptance**: Users must accept EULA on first login
2. **Three Documents**: EULA, User Manual, Service Agreement (all from `EULA_manual_license.txt`)
3. **Acceptance Tracking**: Records timestamp, IP address, user agent
4. **Help Page**: Always accessible from navigation menu
5. **Document Download**: Users can download documents as markdown

## Deployment Options

### Option 1: Test Locally First (Recommended)

```bash
cd /Users/vovkes/ZOMCP/SecondLayer

# Run local deployment
./deploy-local.sh
```

This will:
- Install all dependencies (including `react-markdown`)
- Run database migrations
- Build backend TypeScript
- Optionally start services in tmux
- Run endpoint tests

**Then test:**
1. Open http://localhost:5173
2. Login with Google OAuth
3. EULA modal should appear automatically
4. Accept EULA
5. Navigate to "Help & Documentation" menu
6. Verify all three documents load correctly

### Option 2: Deploy to Production Server

```bash
cd /Users/vovkes/ZOMCP/SecondLayer

# Configure server (first time only)
export DEPLOY_USER=ubuntu
export DEPLOY_HOST=gate-server
export DEPLOY_PORT=22
export BACKEND_DEPLOY_PATH=~/secondlayer
export FRONTEND_DEPLOY_PATH=/var/www/secondlayer

# Run production deployment
./deploy-eula-update.sh
```

The script will:
1. Check prerequisites
2. Test server connection
3. Build and deploy backend
4. Run database migrations automatically
5. Build and deploy frontend
6. Restart services (PM2, Docker, or systemd)
7. Run health checks

### Option 3: Manual Deployment

#### Backend

```bash
cd /Users/vovkes/ZOMCP/SecondLayer/mcp_backend

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run migrations
npm run migrate

# Restart service
pm2 restart secondlayer-http
# OR
docker-compose restart app
# OR
systemctl restart secondlayer
```

#### Frontend

```bash
cd /Users/vovkes/ZOMCP/SecondLayer/frontend

# Install dependencies (includes react-markdown)
npm install

# Build for production
npm run build

# Copy to web server
scp -r dist/* user@server:/var/www/secondlayer/

# Reload nginx
ssh user@server "sudo systemctl reload nginx"
```

## Environment Variables

No new environment variables are required. The EULA service reads directly from:
```
/Users/vovkes/ZOMCP/SecondLayer/EULA_manual_license.txt
```

Make sure this file is accessible from the backend server.

## Database Migration

The migration `007_add_eula_acceptance.sql` creates:

### Tables
- `eula_acceptances` - Tracks user acceptance
- `eula_documents` - Stores EULA versions

### Indexes
- `idx_eula_acceptances_user_id` - Fast user lookup
- `idx_eula_acceptances_accepted_at` - Time-based queries
- `idx_eula_documents_active` - Active version lookup

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/eula` | Public | Get active EULA document |
| GET | `/api/eula/status` | JWT | Check if user accepted EULA |
| POST | `/api/eula/accept` | JWT | Record user acceptance |
| GET | `/api/eula/history` | JWT | Get user's acceptance history |
| GET | `/api/eula/documents` | Public | Get all legal documents |
| GET | `/api/eula/manual` | Public | Get user manual only |

## Testing Checklist

After deployment, verify:

- [ ] Backend health endpoint works: `curl http://localhost:3000/health`
- [ ] EULA endpoint returns data: `curl http://localhost:3000/api/eula`
- [ ] Documents endpoint returns all three docs: `curl http://localhost:3000/api/eula/documents`
- [ ] Frontend loads without errors
- [ ] Login works with Google OAuth
- [ ] EULA modal appears for new users
- [ ] Acceptance is recorded (check `eula_acceptances` table)
- [ ] Help page loads and shows all documents
- [ ] Documents can be downloaded

## Troubleshooting

### EULA Modal Doesn't Appear

**Check:**
1. Backend is running: `curl http://localhost:3000/health`
2. EULA endpoint works: `curl http://localhost:3000/api/eula`
3. User is authenticated (check browser localStorage for `auth_token`)
4. Browser console for errors

**Fix:**
```bash
# Check backend logs
pm2 logs secondlayer-http
# OR
docker-compose logs -f app
```

### "Failed to load EULA content" Error

**Cause:** `EULA_manual_license.txt` not found

**Fix:**
```bash
# On server, check file exists
ls -la ~/secondlayer/secondlayer/EULA_manual_license.txt

# If missing, copy from project root
scp EULA_manual_license.txt user@server:~/secondlayer/secondlayer/
```

### Migration Fails

**Check database connection:**
```bash
cd mcp_backend
npm run db:setup
```

**Manually run migration:**
```sql
-- Connect to PostgreSQL
psql -U secondlayer -d secondlayer_db

-- Run migration
\i src/migrations/007_add_eula_acceptance.sql
```

### Frontend Build Fails

**Check for react-markdown:**
```bash
cd frontend
npm install react-markdown --save
npm run build
```

### 401 Unauthorized on EULA Endpoints

**EULA status/accept/history require JWT authentication.**

Public endpoints (no auth needed):
- `/api/eula`
- `/api/eula/documents`
- `/api/eula/manual`

Protected endpoints (JWT required):
- `/api/eula/status`
- `/api/eula/accept`
- `/api/eula/history`

## Rollback Procedure

If deployment fails, rollback:

### Backend
```bash
# SSH to server
ssh user@server

# Revert to previous version
cd ~/secondlayer
tar -xzf secondlayer-backup-YYYYMMDD.tar.gz

# Restart service
pm2 restart secondlayer-http
```

### Frontend
```bash
# Restore previous build
ssh user@server "cp -r /var/www/secondlayer.backup/* /var/www/secondlayer/"
```

### Database
```bash
# Drop new tables (if needed)
psql -U secondlayer -d secondlayer_db

DROP TABLE IF EXISTS eula_acceptances;
DROP TABLE IF EXISTS eula_documents;
```

## Support

For issues or questions:
1. Check logs: `pm2 logs secondlayer-http`
2. Check database: `psql -U secondlayer -d secondlayer_db`
3. Test endpoints: `curl http://localhost:3000/api/eula`
4. Review browser console for frontend errors

## Next Steps

After successful deployment:
1. Test with a new user account
2. Monitor acceptance logs
3. Update EULA content if needed (edit `EULA_manual_license.txt`)
4. Create EULA version 2.0 when needed:
   ```bash
   curl -X POST http://localhost:3000/api/eula/update-from-file \
     -H "Content-Type: application/json" \
     -d '{"version": "2.0"}'
   ```
