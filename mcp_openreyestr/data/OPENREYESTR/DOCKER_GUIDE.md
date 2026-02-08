# NAIS Open Data - Docker Guide

Complete Docker setup for the NAIS (Ministry of Justice Ukraine) Open Data registries system.

## 🏗️ Architecture

The system runs in Docker containers:

```
┌─────────────────────────────────────────┐
│   NAIS Open Data System                 │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  PostgreSQL 15 (opendata_db)     │  │
│  │  Port: 5432                       │  │
│  │  User: opendatauser               │  │
│  │  - 11 Registry Tables             │  │
│  │  - 3 Auxiliary Tables             │  │
│  │  Volume: postgres_data            │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## 📋 Database Tables

The system includes **14 tables** for 11 NAIS registries:

1. **legal_entities** - Legal Entities Registry (Єдиний державний реєстр юридичних осіб)
2. **notaries** - Notaries Registry (Єдиний реєстр нотаріусів)
3. **court_experts** - Court Experts Registry (Державний реєстр атестованих судових експертів)
4. **special_forms** - Special Forms Registry (Єдиний реєстр спеціальних бланків)
5. **forensic_methods** - Forensic Methods Registry (Реєстр методик проведення судових експертиз)
6. **bankruptcy_cases** - Bankruptcy Registry (Єдиний реєстр підприємств-банкрутів)
7. **arbitration_managers** - Arbitration Managers Registry (Єдиний реєстр арбітражних керуючих)
8. **legal_acts** - Legal Acts Registry (Єдиний державний реєстр нормативно-правових актів)
9. **administrative_units** + **streets** - Administrative Units Dictionary (Словник АТУ)
10. **enforcement_proceedings** - Enforcement Proceedings (Система виконавчого провадження)
11. **debtors** - Debtors Registry (Єдиний реєстр боржників)

**Auxiliary tables:**
- **registry_metadata** - Registry metadata
- **import_log** - Import operation tracking

## 🚀 Quick Start

### 1. Start Containers

```bash
./manage-nais-docker.sh start
```

This will:
- Start PostgreSQL container
- Wait for database to be ready
- Show container status

### 2. Verify Setup

```bash
./manage-nais-docker.sh status
```

### 3. Connect to Database

```bash
./manage-nais-docker.sh db-shell
```

## 📦 Management Commands

The `manage-nais-docker.sh` script provides these commands:

| Command | Description |
|---------|-------------|
| `start` | Start containers |
| `stop` | Stop containers |
| `restart` | Restart containers |
| `status` | Show container and database status |
| `logs` | Show container logs (Ctrl+C to exit) |
| `db-shell` | Connect to PostgreSQL shell |
| `backup` | Create database backup |
| `restore` | Restore from backup |
| `clean` | Remove containers and volumes ⚠️ DATA LOSS |

## 🔧 Manual Docker Commands

### Start Container

```bash
docker compose up -d postgres
```

### Stop Container

```bash
docker compose stop postgres
```

### View Logs

```bash
docker compose logs -f postgres
```

### Connect to Database

```bash
docker exec -it opendata_postgres psql -U opendatauser -d opendata_db
```

### Execute SQL

```bash
docker exec opendata_postgres psql -U opendatauser -d opendata_db -c "SELECT COUNT(*) FROM legal_entities;"
```

## 💾 Backup & Restore

### Create Backup

```bash
./manage-nais-docker.sh backup
```

Backups are stored in `backups/nais_opendata_YYYYMMDD_HHMMSS.sql.gz`

### Restore Backup

```bash
./manage-nais-docker.sh restore
```

### Manual Backup

```bash
# Create backup
docker exec opendata_postgres pg_dump -U opendatauser -d opendata_db | gzip > backup.sql.gz

# Restore backup
gunzip -c backup.sql.gz | docker exec -i opendata_postgres psql -U opendatauser -d opendata_db
```

## 🔍 Database Queries

### Check Table Sizes

```sql
SELECT
    tablename,
    pg_size_pretty(pg_total_relation_size('public.' || tablename)) AS size,
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = tablename) AS columns
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size('public.' || tablename) DESC;
```

### View Registry Metadata

```sql
SELECT registry_id, registry_name, registry_title, last_updated
FROM registry_metadata
ORDER BY registry_id;
```

### Check Import History

```sql
SELECT
    registry_name,
    file_name,
    records_imported,
    import_started_at,
    import_completed_at,
    status
FROM import_log
ORDER BY import_started_at DESC
LIMIT 10;
```

## 📊 Connection Details

**Container:** `opendata_postgres`
**Database:** `opendata_db`
**User:** `opendatauser`
**Password:** `REDACTED_ODATA_PASS`
**Port:** `5432` (host) → `5432` (container)
**Network:** `opendata-network`

### Connection String

```
postgresql://opendatauser:REDACTED_ODATA_PASS@localhost:5432/opendata_db
```

### Environment Variables

Configure in `.env` file:

```bash
POSTGRES_ODATA_HOST=localhost
POSTGRES_ODATA_PORT=5432
POSTGRES_ODATA_DB=opendata_db
POSTGRES_ODATA_USER=opendatauser
POSTGRES_ODATA_PASSWORD=REDACTED_ODATA_PASS
```

## 🐳 Docker Compose Configuration

The `docker-compose.yml` defines:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    container_name: opendata_postgres
    environment:
      POSTGRES_DB: opendata_db
      POSTGRES_USER: opendatauser
      POSTGRES_PASSWORD: REDACTED_ODATA_PASS
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U opendatauser -d opendata_db"]
      interval: 10s
      timeout: 5s
      retries: 5
```

## 📁 Volume Management

### List Volumes

```bash
docker volume ls | grep postgres
```

### Inspect Volume

```bash
docker volume inspect openreyestr_postgres_data
```

### Remove Volume (⚠️ DATA LOSS)

```bash
docker volume rm openreyestr_postgres_data
```

## 🔒 Security

**Production deployment:**

1. **Change default password:**
   ```bash
   docker exec opendata_postgres psql -U postgres -c "ALTER USER opendatauser WITH PASSWORD 'new_secure_password';"
   ```

2. **Restrict network access:**
   ```yaml
   ports:
     - "127.0.0.1:5432:5432"  # Only localhost
   ```

3. **Use Docker secrets:**
   ```yaml
   secrets:
     - postgres_password
   ```

4. **Enable SSL:**
   ```yaml
   environment:
     POSTGRES_SSL: "on"
   ```

## 🐛 Troubleshooting

### Container won't start

```bash
# Check logs
docker compose logs postgres

# Check if port is in use
sudo lsof -i :5432

# Remove old containers
docker rm -f opendata_postgres
```

### Database connection refused

```bash
# Verify container is running
docker ps | grep opendata_postgres

# Check health status
docker inspect --format='{{.State.Health.Status}}' opendata_postgres

# Wait for ready
docker exec opendata_postgres pg_isready -U opendatauser -d opendata_db
```

### Schema not applied

```bash
# Manually apply schema
docker cp schema.sql opendata_postgres:/tmp/schema.sql
docker exec opendata_postgres psql -U opendatauser -d opendata_db -f /tmp/schema.sql
```

### Out of disk space

```bash
# Check Docker disk usage
docker system df

# Clean unused data
docker system prune -a

# Check volume size
docker exec opendata_postgres du -sh /var/lib/postgresql/data
```

## 📈 Performance Tuning

### Increase Shared Buffers

```yaml
environment:
  POSTGRES_SHARED_BUFFERS: 256MB
  POSTGRES_EFFECTIVE_CACHE_SIZE: 1GB
  POSTGRES_WORK_MEM: 16MB
```

### Connection Pooling

Use PgBouncer for connection pooling:

```yaml
pgbouncer:
  image: pgbouncer/pgbouncer
  environment:
    DATABASES_HOST: postgres
    DATABASES_PORT: 5432
    DATABASES_DBNAME: opendata_db
```

## 🎯 Next Steps

1. **Import Data:**
   - Download registry data from NAIS
   - Create import scripts
   - Load data into tables

2. **Build API:**
   - Create REST API for data access
   - Add authentication
   - Deploy API container

3. **Add Monitoring:**
   - Set up Prometheus metrics
   - Configure Grafana dashboards
   - Add alerting

## 📚 Additional Resources

- [DATABASE_SETUP.md](DATABASE_SETUP.md) - Detailed database documentation
- [SCHEMA_OVERVIEW.md](SCHEMA_OVERVIEW.md) - Table structure reference
- [DATA_SOURCES_SCHEMA.md](DATA_SOURCES_SCHEMA.md) - Data source details
- [PostgreSQL Docker Hub](https://hub.docker.com/_/postgres)
- [Docker Compose Documentation](https://docs.docker.com/compose/)

## 🆘 Support

For issues or questions:
1. Check container logs: `./manage-nais-docker.sh logs`
2. Verify database status: `./manage-nais-docker.sh status`
3. Review troubleshooting section above
4. Create backup before making changes: `./manage-nais-docker.sh backup`
