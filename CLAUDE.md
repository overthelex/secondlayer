# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

SecondLayer is a monorepo containing multiple MCP (Model Context Protocol) servers for legal document analysis in Ukraine. The system provides semantic search, AI-powered analysis, and integration with ZakonOnline court database and Verkhovna Rada (Parliament) data.

### Main Components

- **mcp_backend/** - Primary MCP server for court cases and legal documents (ZakonOnline integration)
- **mcp_rada/** - Secondary MCP server for Ukrainian Parliament data (deputies, bills, legislation)
- **mcp_openreyestr/** - Tertiary MCP server for Ukrainian State Register (business entities, beneficiaries)
- **lexwebapp/** - Web frontend/admin panel (React 19, Vite, TailwindCSS, Zustand, TanStack Query)
- **packages/shared/** - Shared TypeScript types and utilities (referenced as `@secondlayer/shared`)
- **deployment/** - Docker configs, compose files, nginx configs, `manage-gateway.sh` script
- **scripts/** - Utility scripts (deploy, rada sync, testing, file conversion)
- **tests/** - E2E tests (Playwright), test fixtures
- **docs/** - Documentation, API explorer, reports

## Architecture

### Dual Transport System

Both MCP servers support three operational modes:

1. **MCP stdio** - Standard MCP protocol for Claude Desktop integration
2. **HTTP API** - REST endpoints for web apps and direct access
3. **SSE (Server-Sent Events)** - Remote MCP over HTTPS for distributed clients

### Technology Stack

- **Runtime**: Node.js 20+ with TypeScript 5.x
- **Databases**: PostgreSQL 15, Redis 7, Qdrant (vector DB)
- **AI**: OpenAI API (GPT-4o, text-embedding-ada-002), optional Anthropic
- **External APIs**: ZakonOnline, Verkhovna Rada Open Data
- **Framework**: Express.js, MCP SDK (@modelcontextprotocol/sdk)

## Development Commands

### Backend (mcp_backend)

```bash
cd mcp_backend

# Development
npm run dev          # MCP stdio mode
npm run dev:http     # HTTP server (port 3000)
npm run dev:sse      # SSE mode for remote MCP

# Build and run
npm run build
npm start           # Production MCP
npm start:http      # Production HTTP

# Database
npm run db:setup    # Create DB and run migrations
npm run migrate     # Run migrations only

# Testing
npm test
npm run test:watch
npm run lint
```

### RADA Server (mcp_rada)

```bash
cd mcp_rada

# Development (uses different ports to avoid conflicts)
npm run dev:http     # HTTP server (port 3001)
npm run dev          # MCP stdio mode

# Database (separate from mcp_backend)
npm run db:setup

# Data synchronization
npm run sync:deputies   # Fetch deputy data from RADA API
npm run sync:laws       # Fetch legislation texts
npm run cleanup:cache   # Clean expired cache entries

# Build and test
npm run build
npm test
```

### OpenReyestr Server (mcp_openreyestr)

```bash
cd mcp_openreyestr

# Development (uses different ports to avoid conflicts)
npm run dev:http     # HTTP server (port 3005)
npm run dev          # MCP stdio mode

# Database (separate from mcp_backend and mcp_rada)
npm run db:setup
npm run migrate

# Data import
npm run import:entities   # Import legal entities from XML
npm run import:debtors    # Import debtors registry

# Build and test
npm run build
npm test
```

### Web Frontend (lexwebapp)

```bash
cd lexwebapp

npm run dev            # Vite dev server
npm run build          # Production build
npm run build:staging  # Staging build
npm run test           # Run tests (Vitest)
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report
npm run lint
```

### Shared Package (packages/shared)

```bash
cd packages/shared
npm run build    # Must build before other services that depend on it
npm run dev      # Watch mode (tsc --watch)
```

Referenced as `@secondlayer/shared` by all three MCP servers.

### Monorepo Root

```bash
# Install all dependencies (root + workspaces)
npm run install:all

# Run both backends simultaneously
npm run backend      # Start mcp_backend HTTP
npm run frontend     # Start lexwebapp dev server
```

## Port Allocation

### Unified Gateway (Stage Environment)

**⭐ Unified Gateway Mode** (enabled via `ENABLE_UNIFIED_GATEWAY=true`)
- **Public Access**: Port 3004 → All MCP tools via unified gateway
- **Internal Services**: RADA (3001) and OpenReyestr (3005) accessible only within Docker network
- **Benefits**: Single endpoint, unified auth, aggregated cost tracking

**Stage deployment** (with unified gateway):
- ✅ **3004** → Unified gateway (public, all tools)
- ❌ **3006** → RADA (removed, now internal only)
- ❌ **3007** → OpenReyestr (removed, now internal only)

### Service Ports (Internal)

**mcp_backend** (main court/legal server):
- HTTP: 3000
- PostgreSQL: 5432
- Redis: 6379
- Qdrant: 6333-6334

**mcp_rada** (parliament server):
- HTTP: 3001 (internal in stage, via gateway)
- PostgreSQL: 5433
- Redis: 6380
- Qdrant: 6335-6336

**mcp_openreyestr** (state register server):
- HTTP: 3005 (internal in stage, via gateway)
- PostgreSQL: 5435
- Redis: 6382 (optional, not currently used)

**Deployment environments**:
- Local: localhost:3000 (PostgreSQL 5432, Redis 6379)
- Dev: gate.lexapp.co.ua:3003 (PostgreSQL 5433, Redis 6380)
- Stage: https://stage.legal.org.ua (Unified Gateway, all 44 tools)
- Prod: mail.lexapp.co.ua:3001 (PostgreSQL 5432, Redis 6379)

## Key Architectural Patterns

### Service Layer Organization (mcp_backend/src/services/)

- **QueryPlanner** - Analyzes user queries, classifies intent, selects appropriate search strategy
- **DocumentService** - Manages document retrieval and caching
- **EmbeddingService** - Generates vector embeddings for semantic search
- **SemanticSectionizer** - Breaks documents into logical sections
- **LegalPatternStore** - Stores and retrieves legal reasoning patterns
- **CitationValidator** - Validates legal citations against source documents
- **HallucinationGuard** - Prevents AI from generating unsupported claims
- **CostTracker** - Tracks OpenAI/Anthropic API costs per request
- **LegislationService** - Handles legislation text retrieval with sectioning

### Adapter Pattern (mcp_backend/src/adapters/)

- **ZOAdapter** - Two instances for different ZakonOnline endpoints (court cases vs practice)
- **RadaLegislationAdapter** - Fetches legislation from Verkhovna Rada API

### MCP Tools API (mcp_backend/src/api/)

**MCPQueryAPI** (mcp-query-api.ts) - Main tools:
- `classify_intent` - Query classification
- `search_court_cases` - Search ZakonOnline database
- `get_document_text` - Retrieve full court decision
- `semantic_search` - Vector similarity search
- `find_legal_patterns` - Pattern matching
- `validate_citations` - Citation verification
- `packaged_lawyer_answer` - Complete legal analysis workflow

**LegislationTools** (legislation-tools.ts):
- `search_legislation` - Search laws/codes by keyword
- `get_legislation_section` - Retrieve specific article/section with intelligent sectioning

### HTTP Server Structure (mcp_backend/src/http-server.ts)

Express app with:
- **Auth middleware**: Bearer token (`SECONDARY_LAYER_KEYS`) + optional JWT/OAuth
- **Tool execution**: `/api/tools/:toolName` (POST)
- **SSE streaming**: `/api/tools/:toolName/stream` (POST)
- **Batch operations**: `/api/tools/batch` (POST)
- **Cost tracking**: Automatic per-request cost calculation

## Environment Variables

Each service has a `.env.example` file with all required variables:
- `mcp_backend/.env.example` - Database, Redis, Qdrant, OpenAI, ZakonOnline, auth keys
- `mcp_rada/.env.example` - Similar to backend with different ports (5433, 6380, 3001)
- `mcp_openreyestr/.env.example` - State registry service configuration

Key variables across services:
- `DATABASE_URL` / `POSTGRES_*` - PostgreSQL connection
- `REDIS_HOST`, `REDIS_PORT` - Redis cache
- `QDRANT_URL` - Vector database
- `OPENAI_API_KEY` - AI embeddings and analysis
- `SECONDARY_LAYER_KEYS` - API authentication tokens
- `OPENAI_MODEL_QUICK/STANDARD/DEEP` - Budget-aware model selection (gpt-4o-mini → gpt-4o)

## Database Migrations

Migrations are in `mcp_backend/src/migrations/` and `mcp_rada/src/migrations/`. Each has a `migrate.ts` runner.

**Running migrations:**
```bash
cd mcp_backend
npm run migrate  # Builds then runs dist/migrations/migrate.js
```

## Docker Deployment

All Dockerfiles and compose files are in `deployment/`. Compose files use `context: ..` (repo root) and reference Dockerfiles as `deployment/Dockerfile.*`.

### Local Development (docker-compose.local.yml)

```bash
cd deployment
./manage-gateway.sh start local    # Start all services
./manage-gateway.sh deploy local   # Full rebuild (pull, migrate, build --no-cache)
./manage-gateway.sh logs local
./manage-gateway.sh stop local
```

### Multi-Environment Gateway (dev/stage/prod)

```bash
cd deployment

# Start specific environment (uses existing images)
./manage-gateway.sh start stage

# Deploy to remote servers (git pull, migrate, rebuild, restart)
./manage-gateway.sh deploy stage   # → mail.lexapp.co.ua
./manage-gateway.sh deploy dev     # → gate.lexapp.co.ua
./manage-gateway.sh deploy prod    # → mail.lexapp.co.ua
./manage-gateway.sh deploy all     # All environments

# View status
./manage-gateway.sh status
./manage-gateway.sh health
```

**Deploy process** (stage/dev): starts all services including RADA, OpenReyestr, and document-service. Pre-builds `packages/shared` and `mcp_backend` dist on remote for document-service Dockerfile.

**Gateway routing**: Nginx at port 8080 routes to environments based on subdomain (dev.legal.org.ua, stage.legal.org.ua, legal.org.ua).

## Testing

Backend servers use Jest with TypeScript (`ts-jest`); lexwebapp uses Vitest; E2E uses Playwright.

```bash
# Run all tests in a service
cd mcp_backend && npm test
cd lexwebapp && npm run test

# Run a single test file
cd mcp_backend && npx jest --no-cache path/to/file.test.ts
cd lexwebapp && npx vitest run path/to/file.test.ts

# Watch mode
npm run test:watch

# E2E tests (Playwright)
cd tests && npx playwright test
cd tests && npx playwright test e2e/specific-test.spec.ts
```

Test files are in `__tests__/` directories alongside source files. Backend jest config uses `maxWorkers=1` and `testTimeout=120000` (tests may call external APIs).

## Common Workflows

### Adding a new MCP tool

1. Define tool schema in `mcp_backend/src/api/mcp-query-api.ts` or create new file in `src/api/`
2. Implement handler method in MCPQueryAPI class
3. Register tool in `getTools()` method
4. Add to HTTP router in `http-server.ts` if needed
5. Write tests in `src/api/__tests__/`

### Working with legislation

The LegislationService uses intelligent sectioning:
- Fetches full legislation text from RADA API
- Splits into logical sections (articles, parts, chapters)
- Stores sections in PostgreSQL with metadata
- Enables precise article/section retrieval

**Example**: Requesting "Constitution Article 124" returns just that article with context, not the entire Constitution.

### Cost tracking

Every tool execution automatically tracks:
- OpenAI token usage (prompt + completion)
- Model used and tier
- Execution time
- External API calls (ZakonOnline, RADA)

Stored in `cost_tracking` table and aggregated in `monthly_api_usage`.

## Important Notes

- **Unified Gateway**: Stage environment uses unified gateway (`ENABLE_UNIFIED_GATEWAY=true`) exposing all tools via single endpoint
  - Tool naming: Backend (no prefix, 36 tools), RADA (`rada_*`, 4 tools), OpenReyestr (`openreyestr_*`, 5 tools)
  - Internal routing: Gateway proxies to RADA/OpenReyestr services via Docker network
  - Cost tracking: Aggregates costs from all services into master tracking record
  - See `docs/UNIFIED_GATEWAY_IMPLEMENTATION.md` for details
- **Two ZOAdapter instances**: One for court cases search, one for legal practice database (different endpoints)
- **Cache TTLs**: Deputies 7d, Bills 1d, Laws 30d (configured in RADA server)
- **Model selection**: Use `ModelSelector` utility for budget-aware model choice (quick/standard/deep)
- **Legislation aliases**: System recognizes "constitution", "цивільний кодекс", "кримінальний кодекс", etc.
- **SSE streaming**: For long-running operations, use SSE endpoints to stream progress events (works with gateway)
- **Dual-auth**: HTTP mode supports both bearer token (for API clients) and JWT/OAuth (for web users)
- **Dockerfiles**: All in `deployment/`, referenced from compose files as `deployment/Dockerfile.*` with `context: ..` (repo root)

## Related Documentation

- `docs/ALL_MCP_TOOLS.md` - Complete list of all MCP tools across services
- `docs/UNIFIED_GATEWAY_IMPLEMENTATION.md` - Unified gateway architecture
- `docs/MCP_CLIENT_INTEGRATION_GUIDE.md` - Connecting LLM clients (Claude Desktop, ChatGPT, etc.)
- `docs/MCP_TOOLS.md` - MCP tools reference
- `docs/batch/` - Batch processing quickstart and README
- `docs/api/mcp_api_docs.html` - Interactive API Explorer (open in browser)
- `mcp_backend/docs/CLIENT_INTEGRATION.md` - Client integration quick start
- `mcp_backend/docs/SSE_STREAMING.md` - SSE streaming protocol
- `mcp_backend/docs/DATABASE_SETUP.md` - PostgreSQL, Redis, Qdrant setup
- `deployment/LOCAL_DEVELOPMENT.md` - Local development setup
- `deployment/GATEWAY_SETUP.md` - Multi-environment gateway configuration
