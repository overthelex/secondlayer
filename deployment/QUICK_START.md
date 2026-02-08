# Quick Start: Local Deployment with Fixed Credentials

## TL;DR (30 seconds)

```bash
cd /home/vovkes/SecondLayer/deployment

# 1. Create .env from template
cp .env .env.local

# 2. Edit credentials (IMPORTANT!)
nano .env.local
# Set: POSTGRES_SUPERUSER_PASSWORD, POSTGRES_PASSWORD

# 3. Check credentials
bash check-credentials.sh

# 4. Deploy!
docker compose up -d

# 5. Verify
docker compose ps
```

## What Changed?

The deployment now **automatically**:
- ✅ Validates all credentials before starting
- ✅ Creates PostgreSQL user and database automatically
- ✅ Prevents "password authentication failed" errors
- ✅ Provides detailed error messages if something is wrong

## The 4 Required Passwords

Edit `.env.local` and set these 4 passwords:

```bash
# Superuser (PostgreSQL admin) - used only during initialization
POSTGRES_SUPERUSER_PASSWORD=choose_a_strong_password_123

# Application user (used by MCP server)
POSTGRES_PASSWORD=another_strong_password_456

# Optional: Change these if you want
POSTGRES_SUPERUSER=postgres  # Usually don't change
POSTGRES_USER=secondlayer     # Usually don't change
POSTGRES_DB=secondlayer_local # Usually don't change
```

## Commands

```bash
# Check credentials (before deploying)
bash check-credentials.sh

# Deploy (automatic credential check)
bash build-local.sh test

# Full build pipeline
bash build-local.sh full

# Interactive menu
bash build-local.sh
```

## Verify It Works

```bash
# Check containers are running
docker compose ps

# Check PostgreSQL user exists
docker exec $(docker ps -q -f 'ancestor=postgres:15-alpine') \
  psql -U secondlayer -d secondlayer_local -c "SELECT 1;"

# Expected output:
# ?column?
#----------
#        1
# (1 row)
```

## If Something Goes Wrong

```bash
# 1. Run credential check first
bash check-credentials.sh

# 2. View PostgreSQL logs
docker compose logs postgres --tail=50

# 3. View MCP server logs
docker compose logs mcp-server --tail=50

# 4. Reset everything (WARNING: deletes data!)
docker compose down -v
# Edit .env.local, then:
docker compose up -d
```

## Files Changed

- ✅ `docker-compose.yml` - Added auto-init script
- ✅ `build-local.sh` - Added credential check
- ✅ `docker/init-postgres.sh` - NEW: Auto-create user/db
- ✅ `docker/init-db.sql` - NEW: SQL template
- ✅ `check-credentials.sh` - NEW: Validates credentials
- ✅ `CREDENTIALS_SETUP.md` - NEW: Full guide
- ✅ `QUICK_START.md` - NEW: This file

## No More Manual Fixes! 🎉

Before: You had to manually run SQL commands to create users

Now: Everything happens automatically during `docker compose up`

## Next: Read Full Guide

For details, see: `CREDENTIALS_SETUP.md`
