# OPENREYESTR MCP Server

MCP server for querying the Ukrainian Unified State Register of Legal Entities, Individual Entrepreneurs and Public Associations (OPENREYESTR / Єдиний державний реєстр юридичних осіб, фізичних осіб – підприємців та громадських формувань).

## Overview

This server provides access to the Ukrainian state registry data through the Model Context Protocol (MCP), allowing AI assistants to search and retrieve information about:

- **Legal Entities (UO)** - Юридичні особи (companies, corporations, etc.)
- **Individual Entrepreneurs (FOP)** - Фізичні особи-підприємці
- **Public Associations (FSU)** - Громадські формування та відокремлені підрозділи

## Features

- **Search entities** by name, EDRPOU code, record number, or status
- **Get full entity details** including founders, beneficiaries, signers, branches
- **Search beneficial owners** across all entities
- **Query by EDRPOU** identification code
- **Registry statistics** - total and active entities by type
- **Dual transport** - MCP stdio and HTTP API

## Installation

```bash
cd mcp_openreyestr
npm install
```

## Database Setup

1. Create PostgreSQL database:

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your database credentials
nano .env

# Create database and run migrations
npm run db:setup
```

2. Import OPENREYESTR data from XML files:

```bash
# Download data from https://data.gov.ua/dataset/1c7f3815-3259-45e0-bdf1-64dca07ddc10

# Import all data types at once
npm run import:all /path/to/OPENREYESTR.zip

# Or import separately
npm run import:uo /path/to/OPENREYESTR.zip
npm run import:fop /path/to/OPENREYESTR.zip
npm run import:fsu /path/to/OPENREYESTR.zip
```

## Usage

### MCP Protocol (stdio)

Start the MCP server:

```bash
npm run dev
```

For production:

```bash
npm run build
npm start
```

### HTTP API

Start the HTTP server:

```bash
npm run dev:http
```

The server will run on port 3004 (configurable via `HTTP_PORT` env variable).

#### API Endpoints

All endpoints require Bearer token authentication (set in `SECONDARY_LAYER_KEYS` env variable).

**Search entities:**
```bash
curl -X POST http://localhost:3004/api/search \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Приватбанк",
    "entityType": "UO",
    "limit": 10
  }'
```

**Get entity by record:**
```bash
curl http://localhost:3004/api/entity/14426646 \
  -H "Authorization: Bearer your-api-key"
```

**Get entity by EDRPOU:**
```bash
curl http://localhost:3004/api/edrpou/14360570 \
  -H "Authorization: Bearer your-api-key"
```

**Search beneficiaries:**
```bash
curl -X POST http://localhost:3004/api/beneficiaries/search \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Коломойський",
    "limit": 50
  }'
```

**Get statistics:**
```bash
curl http://localhost:3004/api/statistics \
  -H "Authorization: Bearer your-api-key"
```

## MCP Tools

### search_entities

Search for entities in the registry by various criteria.

**Parameters:**
- `query` (string, optional) - Name or partial name of entity
- `edrpou` (string, optional) - EDRPOU identification code
- `record` (string, optional) - Registry record number
- `entityType` (enum, optional) - Type: "UO", "FOP", "FSU", or "ALL" (default: "ALL")
- `stan` (string, optional) - Status: "зареєстровано", "припинено", etc.
- `limit` (number, optional) - Maximum results (1-100, default: 50)
- `offset` (number, optional) - Pagination offset (default: 0)

**Example:**
```json
{
  "query": "ТОВ Будівельна",
  "entityType": "UO",
  "stan": "зареєстровано",
  "limit": 20
}
```

### get_entity_details

Get complete information about an entity including all related data.

**Parameters:**
- `record` (string, required) - Registry record number
- `entityType` (enum, optional) - Type: "UO", "FOP", or "FSU" (auto-detected if not provided)

**Returns:** Full entity details including:
- Main information (name, EDRPOU, status, etc.)
- Founders (засновники)
- Beneficial owners (бенефіціари)
- Signers/directors (керівники)
- Members of governing bodies (члени органів управління)
- Branches (філії)
- Predecessors (правопопередники)
- Assignees (правонаступники)
- Termination info (дані про припинення)
- Exchange data (дані обміну з держорганами)

### search_beneficiaries

Search for beneficial owners by name across all entities.

**Parameters:**
- `query` (string, required) - Name or partial name
- `limit` (number, optional) - Maximum results (1-100, default: 50)

### get_by_edrpou

Get entity information by EDRPOU code.

**Parameters:**
- `edrpou` (string, required) - EDRPOU identification code

### get_statistics

Get registry statistics.

**Returns:**
- Total entities count by type
- Active entities count by type
- Overall totals

## Database Schema

### Main Tables

- `legal_entities` - Legal entities (UO)
- `individual_entrepreneurs` - Individual entrepreneurs (FOP)
- `public_associations` - Public associations/separated divisions (FSU)

### Related Tables

- `founders` - Founders/participants
- `beneficiaries` - Beneficial owners
- `signers` - Directors and authorized persons
- `members` - Members of governing bodies
- `branches` - Branches and representative offices
- `predecessors` - Predecessor entities
- `assignees` - Successor entities
- `executive_power` - Executive power bodies (for state enterprises)
- `termination_started` - Termination proceedings data
- `bankruptcy_info` - Bankruptcy/reorganization data
- `exchange_data` - Data from state authorities (tax, social security)

## Environment Variables

```bash
# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5435
POSTGRES_USER=openreyestr
POSTGRES_PASSWORD=your-password
POSTGRES_DB=openreyestr
DATABASE_URL=postgresql://openreyestr:password@localhost:5435/openreyestr

# Redis (optional, for future caching)
REDIS_HOST=localhost
REDIS_PORT=6381

# HTTP Server
HTTP_PORT=3004
NODE_ENV=development

# Security
SECONDARY_LAYER_KEYS=key1,key2,key3
JWT_SECRET=your-jwt-secret

# Data Import
OPENREYESTR_DATA_PATH=/path/to/data
```

## Data Source

Data is obtained from the official Ukrainian open data portal:

**Dataset:** Єдиний державний реєстр юридичних осіб, фізичних осіб – підприємців та громадських формувань

**URL:** https://data.gov.ua/dataset/1c7f3815-3259-45e0-bdf1-64dca07ddc10

**Update frequency:** Daily

**Format:** XML files in ZIP archive

## Architecture

This server follows the SecondLayer monorepo architecture:

- `src/api/` - MCP tools and API handlers
- `src/services/` - Business logic (XML parser, database importer)
- `src/migrations/` - Database migrations
- `src/scripts/` - Import scripts
- `src/utils/` - Utility functions

## Performance Considerations

- **Large dataset:** The registry contains millions of entities. Initial import may take several hours.
- **Batch processing:** Import uses batched transactions (1000 records per batch) for optimal performance.
- **Indexes:** Full-text search indexes on entity names for fast queries.
- **Pagination:** Always use `limit` and `offset` parameters for large result sets.

## Integration with SecondLayer

This server can be integrated with the main SecondLayer legal analysis system to:

- Look up company information during legal research
- Verify beneficial owners in court cases
- Check entity status and registration history
- Cross-reference court case participants with registry data

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Lint code
npm run lint

# Development mode with auto-reload
npm run dev:http
```

## License

MIT

## Support

For issues and questions, please open an issue on the SecondLayer GitHub repository.
