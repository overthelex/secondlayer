# OPENREYESTR Docker Setup Guide

This guide explains how to set up and use the OPENREYESTR database with Docker.

## Prerequisites

- Docker installed
- Docker Compose installed
- OPENREYESTR data ZIP file downloaded from https://data.gov.ua/dataset/1c7f3815-3259-45e0-bdf1-64dca07ddc10

## Quick Start

### 1. Start PostgreSQL and Redis containers

```bash
cd ~/SecondLayer/OPENREYESTR

# Start OPENREYESTR containers (PostgreSQL + Redis)
docker-compose up -d openreyestr-postgres openreyestr-redis

# Check container status
docker-compose ps

# View logs
docker-compose logs -f openreyestr-postgres
```

### 2. Wait for database to be ready

```bash
# Check health status
docker-compose ps openreyestr-postgres

# Or manually test connection
docker exec -it openreyestr_postgres pg_isready -U openreyestr -d openreyestr
```

### 3. Run migrations

```bash
cd ~/SecondLayer/mcp_openreyestr

# Install dependencies (if not already done)
npm install

# Run migrations
npm run migrate
```

### 4. Import OPENREYESTR data

```bash
# Import all entity types
npm run import:all ~/SecondLayer/OPENREYESTR/20260126174103-69.zip
```

This will import:
- Legal Entities (UO_FULL_out.xml) - Юридичні особи
- Individual Entrepreneurs (FOP_FULL_out.xml) - Фізичні особи-підприємці
- Public Associations (FSU_FULL_out.xml) - Громадські формування

**Note:** Import may take 1-3 hours depending on your hardware.

### 5. Start MCP server

```bash
cd ~/SecondLayer/mcp_openreyestr

# Build the project
npm run build

# Start MCP server (stdio mode)
npm start

# OR start HTTP API server
npm run start:http
```

## Container Details

### PostgreSQL Container

- **Container name:** `openreyestr_postgres`
- **Image:** `postgres:15-alpine`
- **Port:** `5435` (host) → `5432` (container)
- **Database:** `openreyestr`
- **User:** `openreyestr`
- **Password:** Set in `.env` file
- **Volume:** `openreyestr-postgres-data`

### Redis Container

- **Container name:** `openreyestr_redis`
- **Image:** `redis:7-alpine`
- **Port:** `6381` (host) → `6379` (container)
- **Volume:** `openreyestr-redis-data`
- **Persistence:** AOF (Append-Only File) enabled

## Docker Commands

### Start containers

```bash
# Start all OPENREYESTR services
docker-compose up -d openreyestr-postgres openreyestr-redis

# Start only PostgreSQL
docker-compose up -d openreyestr-postgres

# Start only Redis
docker-compose up -d openreyestr-redis
```

### Stop containers

```bash
# Stop all OPENREYESTR services
docker-compose stop openreyestr-postgres openreyestr-redis

# Stop only PostgreSQL
docker-compose stop openreyestr-postgres
```

### Remove containers

```bash
# Stop and remove containers (keeps data volumes)
docker-compose down

# Remove containers AND data volumes (WARNING: deletes all data)
docker-compose down -v
```

### View logs

```bash
# Follow logs for PostgreSQL
docker-compose logs -f openreyestr-postgres

# Follow logs for Redis
docker-compose logs -f openreyestr-redis

# View last 100 lines
docker-compose logs --tail=100 openreyestr-postgres
```

### Access PostgreSQL CLI

```bash
# Connect to database
docker exec -it openreyestr_postgres psql -U openreyestr -d openreyestr

# Run SQL query from command line
docker exec -it openreyestr_postgres psql -U openreyestr -d openreyestr -c "SELECT COUNT(*) FROM legal_entities;"

# Run SQL file
docker exec -i openreyestr_postgres psql -U openreyestr -d openreyestr < /path/to/query.sql
```

### Access Redis CLI

```bash
# Connect to Redis
docker exec -it openreyestr_redis redis-cli

# Check if Redis is working
docker exec -it openreyestr_redis redis-cli ping
```

## Environment Variables

All configuration is in `~/SecondLayer/OPENREYESTR/.env`:

```bash
# PostgreSQL Configuration
POSTGRES_HOST=localhost
POSTGRES_PORT=5435
POSTGRES_USER=openreyestr
POSTGRES_PASSWORD=REDACTED_OPENREYESTR_DEV_PASS
POSTGRES_DB=openreyestr
DATABASE_URL=postgresql://openreyestr:REDACTED_OPENREYESTR_DEV_PASS@localhost:5435/openreyestr

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6381

# Server Configuration
HTTP_PORT=3004
NODE_ENV=development

# Security
SECONDARY_LAYER_KEYS=openreyestr-dev-key-2026,openreyestr-prod-key-2026
JWT_SECRET=openreyestr-jwt-secret-change-in-production

# Data Import
OPENREYESTR_DATA_PATH=/home/vovkes/SecondLayer/OPENREYESTR
```

## Database Backup and Restore

### Backup database

```bash
# Backup to SQL file
docker exec -t openreyestr_postgres pg_dump -U openreyestr openreyestr > openreyestr_backup_$(date +%Y%m%d).sql

# Backup to compressed file
docker exec -t openreyestr_postgres pg_dump -U openreyestr openreyestr | gzip > openreyestr_backup_$(date +%Y%m%d).sql.gz
```

### Restore database

```bash
# Restore from SQL file
docker exec -i openreyestr_postgres psql -U openreyestr -d openreyestr < openreyestr_backup.sql

# Restore from compressed file
gunzip -c openreyestr_backup.sql.gz | docker exec -i openreyestr_postgres psql -U openreyestr -d openreyestr
```

## Troubleshooting

### Container won't start

```bash
# Check container logs
docker-compose logs openreyestr-postgres

# Check if port is already in use
lsof -i :5435
```

### Can't connect to database

```bash
# Verify container is running
docker-compose ps openreyestr-postgres

# Check health status
docker inspect openreyestr_postgres | grep -A 10 Health

# Test connection from host
psql -h localhost -p 5435 -U openreyestr -d openreyestr
```

### Out of disk space

```bash
# Check Docker disk usage
docker system df

# Clean up unused data
docker system prune -a

# Remove specific volumes (WARNING: deletes data)
docker volume rm openreyestr-postgres-data
```

### Reset everything

```bash
# Stop and remove containers and volumes
docker-compose down -v

# Remove all related Docker resources
docker volume rm openreyestr-postgres-data openreyestr-redis-data

# Start fresh
docker-compose up -d openreyestr-postgres openreyestr-redis

# Re-run migrations
cd ~/SecondLayer/mcp_openreyestr
npm run migrate

# Re-import data
npm run import:all ~/SecondLayer/OPENREYESTR/20260126174103-69.zip
```

## Production Considerations

For production deployment:

1. **Change passwords** in `.env` file
2. **Enable SSL/TLS** for PostgreSQL connections
3. **Set up regular backups** with cron jobs
4. **Configure resource limits** in docker-compose.yml:
   ```yaml
   deploy:
     resources:
       limits:
         cpus: '2'
         memory: 4G
   ```
5. **Use Docker secrets** instead of plain text passwords
6. **Set up monitoring** with Prometheus/Grafana
7. **Configure log rotation** to prevent disk fill-up

## Data Updates

To update with fresh OPENREYESTR data:

1. Download new ZIP from data.gov.ua
2. Run import again:
   ```bash
   cd ~/SecondLayer/mcp_openreyestr
   npm run import:all /path/to/new-data.zip
   ```

The importer uses upserts, so existing records will be updated and new ones will be added.

## Integration with Other Services

The docker-compose.yml includes both the original `opendata_postgres` and the new `openreyestr-postgres` containers. They run on different ports:

- **opendata_postgres:** Port 5432 (existing NAIS open data)
- **openreyestr-postgres:** Port 5435 (new OPENREYESTR data)

Both can run simultaneously without conflicts.
