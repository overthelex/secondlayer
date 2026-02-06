# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

SecondLayer is a monorepo containing multiple MCP (Model Context Protocol) servers for legal document analysis in Ukraine. The system provides semantic search, AI-powered analysis, and integration with ZakonOnline court database and Verkhovna Rada (Parliament) data.

### Main Components

- **mcp_backend/** - Primary MCP server for court cases and legal documents (ZakonOnline integration)
- **mcp_rada/** - Secondary MCP server for Ukrainian Parliament data (deputies, bills, legislation)
- **mcp_openreyestr/** - Tertiary MCP server for Ukrainian State Register (business entities, beneficiaries)
- **lexwebapp/** - Web frontend/admin panel
- **packages/shared/** - Shared TypeScript types and utilities
- **deployment/** - Multi-environment Docker deployment configurations

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
npm run dev:http     # HTTP server (port 3004)
npm run dev          # MCP stdio mode

# Database (separate from mcp_backend and mcp_rada)
npm run db:setup
npm run migrate

# Data import from XML files
npm run import:all /path/to/openreyestr-full.zip  # Import all entity types
npm run import:uo /path/to/UO_FULL_out.xml        # Legal entities only
npm run import:fop /path/to/FOP_FULL_out.xml      # Individual entrepreneurs only
npm run import:fsu /path/to/FSU_FULL_out.xml      # Public associations only

# Build and test
npm run build
npm test
```

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

**⭐ NEW: Unified Gateway Mode** (enabled via `ENABLE_UNIFIED_GATEWAY=true`)
- **Public Access**: Port 3004 → All 44 MCP tools via unified gateway
- **Internal Services**: RADA (3001) and OpenReyestr (3005) accessible only within Docker network
- **Benefits**: Single endpoint, unified auth, aggregated cost tracking

**Stage deployment** (with unified gateway):
- ✅ **3004** → Unified gateway (public, all 44 tools)
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

### Required for mcp_backend

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/secondlayer
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=<secret>
POSTGRES_DB=secondlayer

# Cache & Vectors
REDIS_HOST=localhost
REDIS_PORT=6379
QDRANT_URL=http://localhost:6333

# AI Models
OPENAI_API_KEY=sk-...
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002

# Dynamic model selection (budget-aware)
OPENAI_MODEL_QUICK=gpt-4o-mini        # Simple tasks
OPENAI_MODEL_STANDARD=gpt-4o-mini     # Moderate complexity
OPENAI_MODEL_DEEP=gpt-4o              # Complex analysis

# External APIs
ZAKONONLINE_API_TOKEN=<token>

# Security
SECONDARY_LAYER_KEYS=test-key-123,prod-key-456
JWT_SECRET=<64-char-secret>

# OAuth (optional)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=https://domain/auth/google/callback
```

### Required for mcp_rada

Similar to mcp_backend but with different ports (5433, 6380, 3001) and optional SecondLayer integration:

```bash
SECONDLAYER_URL=http://localhost:3000
SECONDLAYER_API_KEY=<key>  # For cross-referencing court cases
```

## Database Migrations

Migrations are in `mcp_backend/src/migrations/` and `mcp_rada/src/migrations/`. Each has a `migrate.ts` runner.

**Running migrations:**
```bash
cd mcp_backend
npm run migrate  # Builds then runs dist/migrations/migrate.js
```

## Docker Deployment

### Local Development (docker-compose.local.yml)

```bash
cd deployment
./manage-gateway.sh start local
./manage-gateway.sh logs local
./manage-gateway.sh stop local
```

### Multi-Environment Gateway (dev/stage/prod)

Located in `deployment/` directory with separate compose files for each environment.

```bash
cd deployment

# Build images
./manage-gateway.sh build

# Start specific environment
./manage-gateway.sh start dev
./manage-gateway.sh start stage
./manage-gateway.sh start prod

# Start all environments
./manage-gateway.sh start all

# View status
./manage-gateway.sh status
./manage-gateway.sh health

# Deploy to remote servers (dev→gate, stage/prod→mail)
./manage-gateway.sh deploy all
```

**Gateway routing**: Nginx at port 8080 routes to environments based on subdomain (dev.legal.org.ua, stage.legal.org.ua, legal.org.ua).

## Testing

Both servers use Jest with TypeScript:

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

Test files are in `__tests__/` directories alongside source files.

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

- **Unified Gateway**: Stage environment uses unified gateway (`ENABLE_UNIFIED_GATEWAY=true`) exposing all 45 tools via single endpoint
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

## Related Documentation

### 🔧 API Documentation

- **`docs/ALL_MCP_TOOLS.md`** ⭐ - Complete list of all 45 MCP tools
- **`docs/UNIFIED_GATEWAY_IMPLEMENTATION.md`** ⭐ **NEW!** - Unified gateway architecture and implementation
  - mcp_backend: 34 tools (court cases, legal analysis, document parsing)
  - mcp_rada: 4 tools (parliament data, bills, deputies)
  - mcp_openreyestr: 5 tools (state registry, beneficiaries, EDRPOU)
  - Cost breakdown, parameters, examples, integrations

- **`mcp_backend/docs/api-explorer.html`** - Interactive API Explorer (Swagger-style)
  - All 41 MCP tools with search and filtering
  - Copy-paste curl examples
  - Cost information and parameter descriptions
  - Open in browser: `file:///.../mcp_backend/docs/api-explorer.html`

- **`mcp_backend/docs/index.html`** - Documentation Hub with navigation to all docs

### 📚 Integration & Deployment

- **`docs/MCP_CLIENT_INTEGRATION_GUIDE.md`** ⭐ **NEW!** - Complete guide for connecting 10+ LLM clients
  - Desktop: Claude Desktop, Jan AI, Cherry Studio, Chat-MCP, BoltAI
  - Web: LibreChat, AnythingLLM, Open WebUI, Chainlit, ChatGPT Web
  - All transports (stdio, HTTP, SSE, Streamable HTTP)
  - Configurations, examples, troubleshooting
- `mcp_backend/docs/CLIENT_INTEGRATION.md` - Client integration quick start (HTTP, MCP stdio, SSE)
- `mcp_backend/docs/SSE_STREAMING.md` - SSE streaming protocol for long operations
- `mcp_backend/docs/CHATGPT_INTEGRATION.md` - ChatGPT Actions integration
- `mcp_backend/docs/DEPLOYMENT_CHATGPT.md` - Multi-environment deployment guide
- `deployment/LOCAL_DEVELOPMENT.md` - Local development setup
- `deployment/GATEWAY_SETUP.md` - Multi-environment gateway configuration

### 🗄️ Database & Infrastructure

- `mcp_backend/docs/DATABASE_SETUP.md` - PostgreSQL, Redis, Qdrant setup
- `mcp_backend/docs/postgres-optimization.md` - Query optimization and indexing

### 📖 Getting Started

- `START_HERE.md` - Quick start guide for the monorepo
- `mcp_backend/docs/README.md` - Complete documentation index
