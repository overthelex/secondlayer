# Database Setup Guide

This guide explains how to set up the PostgreSQL database for NAIS Open Data.

## Overview

The database contains tables for all 11 NAIS registries:

1. **legal_entities** - Єдиний державний реєстр юридичних осіб
2. **notaries** - Єдиний реєстр нотаріусів
3. **court_experts** - Державний реєстр атестованих судових експертів
4. **special_forms** - Єдиний реєстр спеціальних бланків
5. **forensic_methods** - Реєстр методик проведення судових експертиз
6. **bankruptcy_cases** - Реєстр підприємств-банкрутів
7. **arbitration_managers** - Реєстр арбітражних керуючих
8. **legal_acts** - Реєстр нормативно-правових актів
9. **administrative_units** + **streets** - Словник адміністративно-територіального устрою
10. **enforcement_proceedings** - Система виконавчого провадження
11. **debtors** - Реєстр боржників

Plus auxiliary tables:
- **registry_metadata** - Metadata about each registry
- **import_log** - Track data import operations

## Prerequisites

- PostgreSQL 12+ installed and running
- Node.js 20+ (already installed)
- PostgreSQL admin (postgres) password

## Quick Setup

### Option 1: Node.js Script (Recommended)

```bash
# 1. Ensure .env file is configured (already done)
cat .env

# 2. Run setup script
npm run db:setup

# 3. Enter postgres password when prompted
```

### Option 2: Shell Script

```bash
# Run the shell script
npm run db:setup:shell

# Or directly:
./setup-database.sh
```

### Option 3: Manual Setup

```bash
# 1. Create user
sudo -u postgres psql <<EOF
CREATE USER opendatauser WITH PASSWORD 'opendata_secure_pass_2026';
EOF

# 2. Create database
sudo -u postgres createdb -O opendatauser opendata_db

# 3. Run schema
psql -U opendatauser -d opendata_db -f schema.sql
```

## Environment Variables

The following variables are configured in `.env`:

```bash
POSTGRES_ODATA_HOST=localhost
POSTGRES_ODATA_PORT=5432
POSTGRES_ODATA_DB=opendata_db
POSTGRES_ODATA_USER=opendatauser
POSTGRES_ODATA_PASSWORD=opendata_secure_pass_2026
DATABASE_ODATA_URL=postgresql://opendatauser:opendata_secure_pass_2026@localhost:5432/opendata_db
```

## Database Schema

### Main Tables Structure

Each table includes:
- UUID primary key
- Registry-specific fields
- `raw_data` JSONB column for full XML/CSV data
- `created_at` and `updated_at` timestamps
- `data_source` and `source_file` tracking
- Full-text search indexes on Ukrainian text fields
- Appropriate indexes for common queries

### Example: Legal Entities Table

```sql
CREATE TABLE legal_entities (
    id UUID PRIMARY KEY,
    edrpou VARCHAR(10) UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    short_name TEXT,
    legal_form VARCHAR(255),
    status VARCHAR(100),
    registration_date DATE,
    address TEXT,
    region VARCHAR(255),
    raw_data JSONB,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    ...
);
```

## Connecting to the Database

### Using psql

```bash
psql -h localhost -p 5432 -U opendatauser -d opendata_db
```

### Using Node.js

```javascript
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_ODATA_URL
});

await client.connect();
```

### Using connection string

```
postgresql://opendatauser:opendata_secure_pass_2026@localhost:5432/opendata_db
```

## Verifying Installation

```bash
# List all tables
psql -U opendatauser -d opendata_db -c "\dt"

# Check registry metadata
psql -U opendatauser -d opendata_db -c "SELECT registry_id, registry_name, registry_title FROM registry_metadata ORDER BY registry_id;"

# Count tables
psql -U opendatauser -d opendata_db -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
```

Expected output: **14 tables** (11 main + 3 auxiliary)

## Database Features

### Full-Text Search

All text fields support Ukrainian full-text search:

```sql
-- Search legal entities by name
SELECT * FROM legal_entities
WHERE to_tsvector('ukrainian', full_name) @@ to_tsquery('ukrainian', 'київ');

-- Search legal acts by title or text
SELECT * FROM legal_acts
WHERE to_tsvector('ukrainian', act_title || ' ' || COALESCE(act_text, ''))
      @@ to_tsquery('ukrainian', 'податок');
```

### Automatic Timestamps

All tables have triggers that automatically update `updated_at` on row modification.

### UUID Primary Keys

All tables use UUID v4 primary keys for:
- Better distribution in distributed systems
- No sequential ID leakage
- Better for external APIs

### JSONB Storage

The `raw_data` column stores complete XML/CSV data as JSONB, allowing:
- Preservation of all original data
- Flexible querying without schema changes
- JSON path queries for nested data

Example:
```sql
SELECT raw_data->'founders' FROM legal_entities WHERE edrpou = '12345678';
```

## Import Tracking

The `import_log` table tracks all data imports:

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

## Troubleshooting

### Connection refused

```bash
# Check if PostgreSQL is running
sudo systemctl status postgresql

# Start PostgreSQL if not running
sudo systemctl start postgresql
```

### Permission denied

```bash
# Ensure user has correct permissions
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE opendata_db TO opendatauser;"
```

### Schema already exists

```bash
# Drop and recreate database
sudo -u postgres dropdb opendata_db
sudo -u postgres createdb -O opendatauser opendata_db
psql -U opendatauser -d opendata_db -f schema.sql
```

### Password authentication failed

Check `.env` file and ensure password matches what was set during user creation.

## Next Steps

After database setup:

1. **Download data files** - Use the HTML report to download ZIP files from NAIS
2. **Extract XML/CSV files** - Unzip the downloaded files
3. **Import data** - Create import scripts to parse and load data (coming soon)
4. **Query data** - Use SQL or build APIs on top of the database

## Security Notes

- Change default password in production
- Use SSL connections for remote access
- Restrict network access to database port
- Regularly backup the database
- Keep credentials in `.env` and never commit to Git

## Database Size Estimates

Expected sizes after importing all data:

- **legal_entities**: 2-3 million records (~50 GB)
- **legal_acts**: 500k-1M records (~20 GB)
- **enforcement_proceedings**: 5-10 million records (~100 GB)
- **debtors**: 3-5 million records (~50 GB)
- Other tables: 100k-1M records each (~5-20 GB each)

**Total estimated**: 300-500 GB

Ensure sufficient disk space before importing full datasets.
