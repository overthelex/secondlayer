# Development Database Migration - Completed ✓

## Summary

Successfully migrated **11 tables** to the development PostgreSQL database on gate server.

**Date:** 2026-01-21 11:43:16 UTC
**Database:** `secondlayer_db` (development)
**Container:** `secondlayer-postgres-dev`
**PostgreSQL Version:** 15.15

---

## Migration Results

### ✅ Created Tables (11)

| # | Table Name | Purpose |
|---|------------|---------|
| 1 | **documents** | Court decisions from ZakonOnline |
| 2 | **document_sections** | Extracted sections (FACTS, REASONING, DECISION) |
| 3 | **legal_patterns** | Recognized patterns in judicial practice |
| 4 | **embedding_chunks** | Text chunks with vector embeddings |
| 5 | **citation_links** | Citation relationships between cases |
| 6 | **precedent_status** | Status tracking for precedents (valid/overruled) |
| 7 | **events** | Event log (replaces Kafka for MVP) |
| 8 | **cost_tracking** | API cost tracking (OpenAI, ZakonOnline, SecondLayer) |
| 9 | **users** | User authentication (Google OAuth2) |
| 10 | **user_sessions** | User session management |
| 11 | **migrations** | Migration tracking table |

### ✅ Applied Migrations (6)

| Migration | Description | Status |
|-----------|-------------|--------|
| **001_initial_schema** | Core tables for legal analysis | ✓ Applied |
| **002_add_html_field** | Add `full_text_html` column to documents | ✓ Applied |
| **003_add_cost_tracking** | Add cost tracking for OpenAI & ZakonOnline | ✓ Applied |
| **004_add_secondlayer_tracking** | Add SecondLayer MCP cost tracking | ✓ Applied |
| **005_convert_uah_to_usd** | Convert prices to USD (no-op for new DB) | ✓ Applied |
| **006_add_users_table** | Add users and sessions tables | ✓ Applied |

---

## Database Schema Overview

### Core Legal Analysis Tables

```
documents (court decisions)
  ├─> document_sections (extracted sections)
  │   └─> embedding_chunks (vector embeddings)
  ├─> citation_links (case citations)
  └─> precedent_status (precedent validation)

legal_patterns (judicial patterns)
  └─> example_cases → documents
```

### Supporting Tables

```
events (event log)
cost_tracking (API usage & costs)
users (authentication)
  └─> user_sessions
migrations (schema version tracking)
```

### Indexes Created

**Performance Indexes:**
- `idx_zo_id` - Fast lookup by ZakonOnline ID
- `idx_date` - Date range queries on documents
- `idx_type` - Filter by document type
- `idx_doc_sections` - Document section lookup
- `idx_vector_id` - Vector similarity search
- `idx_citation_from/to` - Citation graph traversal
- `idx_users_email` - User lookup by email
- `idx_sessions_token` - Session validation

---

## Key Features

### 1. UUID Primary Keys
All tables use UUID v4 for primary keys (future-proof for distributed systems)

### 2. Automatic Timestamps
Tables with `updated_at` have triggers for auto-updating:
- `documents`
- `legal_patterns`
- `precedent_status`
- `users`

### 3. JSONB Columns
Flexible metadata storage:
- `documents.metadata` - Document metadata
- `legal_patterns.anti_patterns` - Pattern analysis
- `events.payload` - Event data
- `cost_tracking.cost_breakdown` - Detailed cost info

### 4. Foreign Keys & Cascades
All foreign keys configured with `ON DELETE CASCADE` for data integrity

---

## Migration File

**Location:** `/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/src/migrations/apply-all-dev.sql`

**How to use:**
```bash
# Copy to gate server
scp mcp_backend/src/migrations/apply-all-dev.sql gate:/tmp/

# Copy to container
ssh gate "docker cp /tmp/apply-all-dev.sql secondlayer-postgres-dev:/tmp/"

# Apply migrations
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_db -f /tmp/apply-all-dev.sql"
```

---

## Verification Commands

### Check tables
```bash
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_db -c '\dt'"
```

### Check migrations
```bash
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_db -c 'SELECT * FROM migrations ORDER BY id'"
```

### Check table sizes
```bash
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_db -c \"
  SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
\""
```

### Test connection from backend
```bash
ssh gate "docker exec secondlayer-app-dev node -e \"
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.query('SELECT COUNT(*) FROM documents')
    .then(res => console.log('Documents count:', res.rows[0].count))
    .catch(err => console.error('Error:', err))
    .finally(() => pool.end());
\""
```

---

## Comparison: Production vs Development

| Aspect | Production | Development |
|--------|-----------|-------------|
| **Tables** | 9 tables (before migration 006) | 11 tables (all migrations) |
| **Container** | `secondlayer-postgres-prod` | `secondlayer-postgres-dev` |
| **Port** | 5432 | 5433 |
| **Data** | Live production data | Empty (ready for testing) |
| **Migrations** | Applied manually over time | All applied at once |

**Note:** Production is missing `cost_tracking` and `migrations` tables from older migrations. Consider backporting migration 003-005 to production.

---

## Next Steps

### 1. Test Backend Connection
Restart dev backend to ensure it connects to the new schema:
```bash
ssh gate "docker restart secondlayer-app-dev"
ssh gate "docker logs -f secondlayer-app-dev"
```

### 2. Test Frontend
Visit https://dev.legal.org.ua/ and verify:
- ✓ Login works (users table)
- ✓ API queries work (documents table)
- ✓ Search works (embedding_chunks)

### 3. Seed Test Data (Optional)
```bash
# Add sample documents for testing
ssh gate "docker exec secondlayer-app-dev npm run seed:dev"
```

### 4. Backport to Production (If needed)
Apply missing migrations to production:
- Migration 003: cost_tracking table
- Migration 004: secondlayer tracking columns
- Migration 005: UAH to USD conversion

---

## Troubleshooting

### Error: "relation does not exist"
```bash
# Check if migrations were applied
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_db -c 'SELECT * FROM migrations'"
```

### Error: "could not connect to database"
```bash
# Check if container is running
ssh gate "docker ps | grep postgres-dev"

# Check logs
ssh gate "docker logs secondlayer-postgres-dev"
```

### Reset database (nuclear option)
```bash
# Drop and recreate database
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -c 'DROP DATABASE secondlayer_db'"
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -c 'CREATE DATABASE secondlayer_db'"

# Reapply migrations
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_db -f /tmp/apply-all-dev.sql"
```

---

## Related Documentation

- [Database Setup Guide](../mcp_backend/docs/DATABASE_SETUP.md)
- [Gate Containers Map](./GATE_CONTAINERS_MAP.md)
- [Migration Files](../mcp_backend/src/migrations/)

---

**Status:** ✅ Complete
**Tables:** 11/11
**Migrations:** 6/6
**Ready for:** Development & Testing
