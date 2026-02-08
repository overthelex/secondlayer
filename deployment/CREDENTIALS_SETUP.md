# Credentials Setup Guide for SecondLayer Local Deployment

This guide explains how to properly configure PostgreSQL credentials for local development.

## Problem Solved

Previously, the deployment would fail with:
```
error: password authentication failed for user "secondlayer"
```

This happened because:
1. PostgreSQL superuser credentials were not matched in `.env`
2. Application user (`secondlayer`) didn't exist in the database
3. Application database wasn't created
4. Manual intervention was required to fix credentials

## Solution

The new setup **automatically**:
- ✅ Validates all required credentials before deployment
- ✅ Creates application user with correct password
- ✅ Creates application database with proper permissions
- ✅ Prevents mismatches between `.env` and actual database

## Quick Start

### 1. Prepare Environment File

Copy the template:
```bash
cp deployment/.env.example deployment/.env.local
```

Or use existing `.env`:
```bash
cd deployment
```

### 2. Edit Credentials

Edit `.env` or `.env.local` and set PostgreSQL credentials:

```bash
# PostgreSQL Superuser (for initialization only)
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=your_strong_password_change_me

# Application Database User
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=your_app_password_change_me
POSTGRES_DB=secondlayer_local

# Other required fields...
OPENAI_API_KEY=...
ZAKONONLINE_API_TOKEN=...
ANTHROPIC_API_KEY=...
```

**IMPORTANT**: Set strong passwords in production!

### 3. Check Credentials

Before deploying, verify credentials are configured:

```bash
cd deployment

# Option A: Run credential check directly
bash check-credentials.sh

# Option B: Use build script
bash build-local.sh check-creds

# Option C: Interactive menu
bash build-local.sh
# Select option 4: Check credentials
```

### 4. Deploy

Once credentials are verified:

```bash
# Using build-local.sh
bash build-local.sh test

# Or manual docker-compose
docker compose up -d

# Verify PostgreSQL
docker exec $(docker ps -q -f 'ancestor=postgres:15-alpine') \
  psql -U secondlayer -d secondlayer_local -c "SELECT 1;"
```

## File Structure

```
deployment/
├── docker-compose.yml          # Updated with credential initialization
├── docker/
│   ├── init-postgres.sh       # Auto-creates users and databases
│   └── init-db.sql            # SQL template for initialization
├── build-local.sh             # Updated with credential checks
├── check-credentials.sh       # New: Validates credentials
└── CREDENTIALS_SETUP.md        # This file
```

## How It Works

### 1. Credential Check (check-credentials.sh)

```
✅ Validates .env file exists
✅ Checks all required variables are set
✅ Verifies PostgreSQL connection (if running)
✅ Creates user and database if missing
✅ Shows configuration summary
```

### 2. Auto-Initialization (init-postgres.sh)

When PostgreSQL container starts for the first time:

```
✅ Waits for PostgreSQL to be ready
✅ Creates application user with password from .env
✅ Creates application database
✅ Grants proper permissions
✅ Completes silently if already initialized
```

This script runs in the Docker container's init directory and executes automatically.

### 3. Build-Local Integration

The `build-local.sh` script now:

```bash
# Option 4: Check credentials before any deployment
check_deployment_credentials()

# test_local() now calls check_deployment_credentials()
# full_pipeline() includes credential verification
```

## Environment Variables Reference

### PostgreSQL Initialization (Superuser)

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `POSTGRES_SUPERUSER` | Yes | Superuser login | `postgres` |
| `POSTGRES_SUPERUSER_PASSWORD` | Yes | Superuser password | `strong_pass_123` |

### Application Database (User)

| Variable | Required | Purpose | Default |
|----------|----------|---------|---------|
| `POSTGRES_USER` | Yes | App user login | `secondlayer` |
| `POSTGRES_PASSWORD` | Yes | App user password | `local_dev_password` |
| `POSTGRES_DB` | No | App database name | `secondlayer_local` |

### Other Required

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI integration |
| `ZAKONONLINE_API_TOKEN` | Zakononline API |
| `ANTHROPIC_API_KEY` | Claude AI integration |

## Troubleshooting

### "No .env file found"

**Solution**: Create `.env` with required credentials

```bash
cp deployment/.env.example deployment/.env
# Edit deployment/.env with your credentials
```

### "POSTGRES_SUPERUSER_PASSWORD is not set"

**Solution**: Add to `.env`:

```
POSTGRES_SUPERUSER_PASSWORD=your_password_here
```

### "PostgreSQL authentication failed"

**Solution 1**: Delete postgres volume and restart:

```bash
docker volume rm secondlayer_postgres_data
docker compose up -d
```

**Solution 2**: Manually reset password:

```bash
docker exec $(docker ps -q -f 'ancestor=postgres:15-alpine') \
  psql -U postgres -c "ALTER USER secondlayer WITH PASSWORD 'new_password';"
```

### "Connection refused"

**Solution**: Wait longer for services to start:

```bash
docker compose logs postgres
# Check if "PostgreSQL is ready" appears
```

## Commands Reference

```bash
# Check credentials before deployment
bash check-credentials.sh

# Check credentials and see summary
bash check-credentials.sh --verbose

# Deploy with credential check
bash build-local.sh test

# Full pipeline with checks
bash build-local.sh full

# Interactive menu (select option 4)
bash build-local.sh
```

## Security Best Practices

### For Development

✅ Use simple passwords in `.env.local`
✅ Keep `.env.local` in `.gitignore`
✅ Document example in `.env.example`

### For Production

✅ Use strong passwords (16+ chars, mixed)
✅ Use environment variables from CI/CD secrets
✅ Never commit `.env` to git
✅ Rotate credentials regularly
✅ Use separate users for different services

## Docker Compose Integration

The `docker-compose.yml` now includes:

```yaml
postgres:
  volumes:
    # Automatic initialization script
    - ./docker/init-postgres.sh:/docker-entrypoint-initdb.d/01-init-postgres.sh:ro
  environment:
    # Initialization credentials
    POSTGRES_APP_USER: ${POSTGRES_USER:-secondlayer}
    POSTGRES_APP_PASSWORD: ${POSTGRES_PASSWORD:-local_dev_password}
    POSTGRES_APP_DB: ${POSTGRES_DB:-secondlayer_local}
```

The `init-postgres.sh` script runs automatically on first container start.

## Manual Database Setup (if needed)

If you need to manually create user and database:

```bash
# Connect to PostgreSQL
docker exec -it $(docker ps -q -f 'ancestor=postgres:15-alpine') \
  psql -U postgres

# Inside psql:
CREATE USER secondlayer WITH PASSWORD 'your_password';
CREATE DATABASE secondlayer_local OWNER secondlayer;
ALTER USER secondlayer CREATEDB SUPERUSER;
GRANT ALL PRIVILEGES ON DATABASE secondlayer_local TO secondlayer;
\q
```

## Next Steps

1. ✅ Create `.env` with credentials
2. ✅ Run `bash check-credentials.sh`
3. ✅ Run `docker compose up -d`
4. ✅ Verify: `docker compose ps`
5. ✅ Check logs: `docker compose logs -f mcp-server`

## Support

If you encounter issues:

1. Check `.env` file exists and has all required variables
2. Run `bash check-credentials.sh` to see detailed status
3. Check PostgreSQL logs: `docker compose logs postgres`
4. Check MCP server logs: `docker compose logs mcp-server`
5. Verify container is healthy: `docker compose ps`
