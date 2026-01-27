# RADA MCP Server

Ukrainian Parliament (Verkhovna Rada) data analysis server implementing the Model Context Protocol (MCP).

## Overview

RADA MCP Server provides AI-powered analysis of Ukrainian parliamentary data including:
- **Deputies** - Member information, voting records, committee work
- **Bills** - Legislative proposals with status tracking
- **Legislation** - Full text of laws, codes, and Constitution
- **Voting Records** - Session votes with pattern analysis
- **Cross-referencing** - Links parliament data to court cases via SecondLayer

## Architecture

- **Dual Mode**: MCP stdio + HTTP REST API
- **Database**: PostgreSQL with intelligent caching (TTL-based)
- **Cache Strategy**: Redis + PostgreSQL (deputies 7d, bills 1d, laws 30d)
- **AI Analysis**: OpenAI/Anthropic with budget-based model selection
- **Cost Tracking**: Comprehensive API usage monitoring

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- OpenAI API key

### Installation

```bash
# Clone and setup
cd mcp_rada
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Setup database
npm run db:setup

# Run migrations
npm run migrate
```

### Development

```bash
# Start HTTP server (port 3001)
npm run dev:http

# Start MCP stdio server
npm run dev

# Sync initial data
npm run sync:deputies
npm run sync:laws
```

### Production

```bash
# Build TypeScript
npm run build

# Start with Docker
docker-compose up -d

# Or start directly
npm run start:http
```

## Phase 1 MCP Tools

### 1. search_parliament_bills

Search and filter legislative bills with semantic analysis.

**Input:**
```json
{
  "query": "tax reform",
  "status": "adopted",
  "date_from": "2025-01-01",
  "limit": 20
}
```

**Cost:** $0.01-$0.05 USD

### 2. get_deputy_info

Get detailed deputy information with optional voting history.

**Input:**
```json
{
  "name": "Зеленський",
  "include_voting_record": true
}
```

**Cost:** $0.005-$0.01 USD (mostly cached)

### 3. search_legislation_text

Search Ukrainian laws with full-text search and court citations.

**Input:**
```json
{
  "law_identifier": "constitution",
  "article": "124",
  "include_court_citations": true
}
```

**Aliases supported:** constitution, цивільний кодекс, кримінальний кодекс, кпк, etc.

**Cost:** $0.005-$0.02 USD

### 4. analyze_voting_record

Analyze deputy voting patterns with AI insights.

**Input:**
```json
{
  "deputy_name": "Іванов",
  "date_from": "2025-01-01",
  "analyze_patterns": true
}
```

**Cost:** $0.02-$0.10 USD (includes AI analysis)

## API Endpoints

All endpoints except `/health` require `Authorization: Bearer <API_KEY>` header.

### HTTP REST API

```bash
# Health check
GET /health

# List available tools
GET /api/tools

# Execute tool (JSON response)
POST /api/tools/:toolName
Content-Type: application/json
Authorization: Bearer test-key-123

{
  "arguments": {
    "query": "tax reform"
  }
}

# Execute tool (SSE streaming)
POST /api/tools/:toolName/stream
Accept: text/event-stream
Authorization: Bearer test-key-123
```

## Database Schema

### Core Tables

- **deputies** - Parliament members (7d cache TTL)
- **bills** - Legislative proposals (1d cache TTL)
- **legislation** - Law texts (30d cache TTL)
- **voting_records** - Session votes
- **factions** / **committees** - Metadata

### Cost Tracking

- **cost_tracking** - Per-request API usage
- **monthly_api_usage** - Monthly aggregates
- **tool_usage_stats** - Tool performance metrics

### Cross-Reference

- **law_court_citations** - Links laws to court cases
- **bill_court_impact** - Bill impact analysis
- **deputy_court_mentions** - Deputy mentions in cases

## Data Sync Scripts

```bash
# Sync all deputies (run weekly)
npm run sync:deputies

# Sync law texts (run monthly)
npm run sync:laws

# Cleanup expired cache
npm run cleanup:cache
```

## Configuration

### Environment Variables

See `.env.example` for all available options.

**Key settings:**
- `POSTGRES_PORT=5433` (avoids conflict with SecondLayer on 5432)
- `HTTP_PORT=3001` (avoids conflict with SecondLayer on 3000)
- `REDIS_PORT=6380` (avoids conflict with SecondLayer on 6379)

### Cache TTL

Configure in `.env`:
```bash
CACHE_TTL_DEPUTIES=604800   # 7 days
CACHE_TTL_BILLS=86400       # 1 day
CACHE_TTL_LAWS=2592000      # 30 days
```

### Model Selection

**Budget-based** (recommended):
```bash
OPENAI_MODEL_QUICK=gpt-4o-mini      # Simple tasks
OPENAI_MODEL_STANDARD=gpt-4o-mini   # Moderate complexity
OPENAI_MODEL_DEEP=gpt-4o            # Complex analysis
```

**Single model** (simpler):
```bash
OPENAI_MODEL=gpt-4o-mini
```

## Docker Deployment

```yaml
# docker-compose.yml includes:
- postgres (port 5433)
- redis (port 6380)
- rada-mcp-app (port 3001)
```

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop services
docker-compose down
```

## SecondLayer Integration

Enable cross-referencing with court cases:

```bash
# In .env
SECONDLAYER_URL=http://localhost:3000
SECONDLAYER_API_KEY=your-secondlayer-key
```

Then use `include_court_citations: true` in `search_legislation_text` tool.

## Cost Tracking

Every API call is tracked with:
- OpenAI token usage and cost
- Anthropic token usage and cost (if used)
- RADA API calls (free but bandwidth tracked)
- SecondLayer API calls (when cross-referencing)
- Execution time

View cost breakdown in response:
```json
{
  "result": {...},
  "cost_tracking": {
    "request_id": "abc-123",
    "totals": {
      "cost_usd": 0.0234,
      "execution_time_ms": 1245
    },
    "openai": {
      "total_tokens": 1523,
      "total_cost_usd": 0.0234
    }
  }
}
```

## Development

### Project Structure

```
mcp_rada/
├── src/
│   ├── index.ts              # MCP stdio entry
│   ├── http-server.ts        # HTTP server entry
│   ├── database/             # PostgreSQL connection
│   ├── migrations/           # SQL migrations (001, 002, 003)
│   ├── adapters/             # RADA API clients
│   ├── services/             # Business logic
│   ├── api/                  # MCP tools
│   ├── utils/                # Helpers
│   ├── middleware/           # Auth middleware
│   └── types/                # TypeScript types
├── scripts/                  # Data sync scripts
├── docker/                   # Docker configs
└── logs/                     # Application logs
```

### Testing

```bash
# Run all tests
npm test

# Watch mode
npm test:watch

# Lint
npm run lint
```

### Manual Testing

```bash
# Test HTTP API
curl -X POST http://localhost:3001/api/tools/get_deputy_info \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"name": "Зеленський"}}'

# Test MCP stdio (from Claude Desktop)
# Add to claude_desktop_config.json:
{
  "mcpServers": {
    "rada": {
      "command": "node",
      "args": ["/path/to/mcp_rada/dist/index.js"]
    }
  }
}
```

## Troubleshooting

### Port conflicts

If ports 5433, 6380, or 3001 are in use:
```bash
lsof -i :5433
# Change POSTGRES_PORT in .env
```

### Database connection fails

```bash
# Check PostgreSQL is running
pg_isready -h localhost -p 5433

# Recreate database
npm run db:create
npm run migrate
```

### Cache not working

```bash
# Check Redis is running
redis-cli -p 6380 ping
# Should return "PONG"
```

### High costs

- Use `OPENAI_MODEL=gpt-4o-mini` for lower costs
- Enable caching: check `cache_expires_at` in database
- Review `cost_tracking` table for usage patterns

## Roadmap

### Phase 1 (Current)
- ✅ Core infrastructure
- ✅ 4 basic MCP tools
- ✅ Cost tracking
- ✅ Cross-referencing with SecondLayer

### Phase 2 (Future)
- Bill impact predictions with ML
- Faction discipline analysis
- Historical convocation comparisons
- Full-text search with embeddings
- Advanced voting pattern analysis
- Plenary session stenogram search

## License

MIT

## Support

For issues or questions, refer to the implementation plan at `/Users/vovkes/.claude/plans/sorted-floating-stardust.md`.
