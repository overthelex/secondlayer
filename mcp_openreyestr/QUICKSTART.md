# OPENREYESTR Quick Start Guide

## Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Downloaded OPENREYESTR data from https://data.gov.ua/dataset/1c7f3815-3259-45e0-bdf1-64dca07ddc10

## Quick Setup (5 steps)

### 1. Install Dependencies

```bash
cd mcp_openreyestr
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
nano .env  # Edit with your database credentials
```

Minimum required settings:
```env
POSTGRES_PASSWORD=your-password
SECONDARY_LAYER_KEYS=your-api-key
```

### 3. Create Database

```bash
npm run db:setup
```

This will:
- Create the `openreyestr` database
- Run all migrations
- Set up tables and indexes

### 4. Import Data

Place your downloaded ZIP file in a known location, then:

```bash
# Import all entity types (recommended)
npm run import:all /path/to/20260126174103-69.zip
```

Or set the path in `.env`:
```env
OPENREYESTR_DATA_PATH=/home/vovkes/SecondLayer/OPENREYESTR
```

Then run:
```bash
npm run import:all $OPENREYESTR_DATA_PATH/20260126174103-69.zip
```

**Note:** Import may take 1-3 hours depending on your hardware. The dataset contains millions of records.

### 5. Start Server

**MCP stdio mode (for Claude Desktop):**
```bash
npm run build
npm start
```

**HTTP API mode:**
```bash
npm run dev:http
```

## Test the Server

### MCP Mode

Configure in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openreyestr": {
      "command": "node",
      "args": ["/path/to/SecondLayer/mcp_openreyestr/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://openreyestr:password@localhost:5435/openreyestr"
      }
    }
  }
}
```

### HTTP Mode

Test with curl:

```bash
# Search for entities
curl -X POST http://localhost:3004/api/search \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"query": "Приватбанк", "limit": 5}'

# Get statistics
curl http://localhost:3004/api/statistics \
  -H "Authorization: Bearer your-api-key"
```

## Usage Examples

### Search by Name

```json
{
  "query": "ТОВ Будівельна компанія",
  "entityType": "UO",
  "limit": 10
}
```

### Search by EDRPOU

```json
{
  "edrpou": "14360570"
}
```

### Get Entity Details

```json
{
  "record": "14426646"
}
```

### Search Beneficiaries

```json
{
  "query": "Іванов Іван",
  "limit": 20
}
```

## Troubleshooting

### Database Connection Error

Check that PostgreSQL is running:
```bash
sudo systemctl status postgresql
```

Verify connection settings in `.env`.

### Import Fails

- Ensure the ZIP file contains `UO_FULL_out.xml`, `FOP_FULL_out.xml`, and `FSU_FULL_out.xml`
- Check disk space (import requires ~10-20GB free space)
- Increase PostgreSQL memory settings if needed

### HTTP Server Won't Start

- Check if port 3004 is already in use: `lsof -i :3004`
- Change port in `.env`: `HTTP_PORT=3005`

## Next Steps

- Integrate with Claude Desktop for AI-powered queries
- Set up automatic data updates (daily refresh)
- Add Redis caching for improved performance
- Configure Nginx reverse proxy for production deployment

## Data Updates

To update with fresh data:

1. Download new ZIP from data.gov.ua
2. Run import again: `npm run import:all /path/to/new-data.zip`
3. The importer uses `ON CONFLICT` upserts, so existing records will be updated

## Performance Tips

- Use `limit` parameter to avoid large result sets
- Create additional indexes for frequently searched fields
- Consider partitioning large tables by year
- Enable PostgreSQL query caching

## Support

See main README.md for detailed documentation.
