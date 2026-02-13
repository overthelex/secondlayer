# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Stack

- Monorepo with shared/backend/frontend packages
- Language: TypeScript (primary), YAML for configs, Shell for deploy scripts
- Infrastructure: Docker Compose for local dev, MinIO for storage, Nginx as reverse proxy
- Auth: Google OAuth
- Architecture: MCP tools pattern with LLM orchestration

## Session Scope

When the user asks for a specific task (e.g., 'commit frontend changes'), do exactly that. Do not expand scope to investigate related issues, refactor adjacent code, or explore the codebase unless explicitly asked. If you see something worth investigating, mention it briefly and ask before proceeding.

## Git & Deployment Workflow

After completing code changes, always: 1) Build and verify no errors, 2) Commit with a descriptive message, 3) Push to remote, 4) Deploy locally if requested. Do NOT over-scope commits — only stage files relevant to the current task.

## Local Dev Environment

- Backend services run in Docker containers, NOT as local processes. Do not attempt to restart backend services outside Docker.
- Always run `docker compose build` after code changes before testing — do not test against stale images.
- Run commands from the correct workspace directory (check with `pwd` before executing).
- Use the correct env passwords from `.env` files, not defaults.

## Project Defaults

Primary stack: JavaScript, Shell, HTML, YAML, Markdown. When creating new files, default to JavaScript (not TypeScript) unless the project already uses TypeScript.

Before implementing non-trivial features, use a task agent to investigate: (1) current state of the system/service, (2) exact API limits or format requirements, (3) existing configs or files that would conflict. Report findings before writing any code.

## Repository Overview

SecondLayer is a monorepo for a Ukrainian legal tech platform. It provides AI-powered legal document analysis, semantic search over court decisions, legislation retrieval, parliament data, and business registry lookups via MCP (Model Context Protocol) servers.

### Workspace Structure

```
SecondLayer/
├── mcp_backend/        # Primary MCP server - court cases, legal docs (ZakonOnline)
├── mcp_rada/           # Parliament data server (deputies, bills, legislation)
├── mcp_openreyestr/    # State Register server (business entities, beneficiaries)
├── lexwebapp/          # Web frontend/admin panel (React 19, Vite, TailwindCSS)
├── packages/shared/    # Shared TypeScript types and utilities (@secondlayer/shared)
├── deployment/         # Docker configs, compose files, nginx, manage-gateway.sh
├── scripts/            # Utility scripts (deploy, rada sync, testing, conversion)
├── tests/              # E2E tests (Playwright), test fixtures
├── docs/               # Documentation, API explorer, reports
├── config/             # MCP client configs
├── legacy/             # Archived code
└── lexconfig/          # Application config files
```

## Architecture

### Triple Transport System

All three MCP servers support:

1. **MCP stdio** - Standard MCP protocol for Claude Desktop integration
2. **HTTP API** - REST endpoints (`/api/tools/:toolName`) for web apps
3. **SSE (Server-Sent Events)** - Remote MCP over HTTPS for distributed clients

### Technology Stack

- **Runtime**: Node.js 20+ (`.nvmrc: 20`) with TypeScript 5.3
- **Databases**: PostgreSQL 15, Redis 7, Qdrant (vector DB)
- **AI**: OpenAI API (GPT-4o, text-embedding-ada-002), optional Anthropic (Claude)
- **External APIs**: ZakonOnline (court DB), Verkhovna Rada Open Data, data.gov.ua (OpenReyestr)
- **Framework**: Express.js, MCP SDK (`@modelcontextprotocol/sdk`)
- **Frontend**: React 19, Vite, TailwindCSS 3, Zustand (state), TanStack Query (data fetching), Vitest

### Unified Gateway (45 MCP Tools)

Stage environment aggregates all services behind a single endpoint (`ENABLE_UNIFIED_GATEWAY=true`):
- **36 backend tools** (no prefix) - court cases, semantic search, legislation, patterns, citations, vault
- **4 RADA tools** (`rada_*`) - deputies, bills, legislation, voting
- **5 OpenReyestr tools** (`openreyestr_*`) - entity search, beneficiaries, debtors

Tool registry: `mcp_backend/src/api/tool-registry.ts` maps all 44 tool names to handler classes.

### Shared Package (`@secondlayer/shared`)

Key exports used across all services:
- `getOpenAIManager` / `getAnthropicManager` - LLM client singletons
- `LLMManager` - Unified interface for OpenAI/Anthropic with fallback
- `ModelSelector` - Budget-aware model selection (quick → gpt-4o-mini, standard → gpt-4o-mini, deep → gpt-4o)
- `logger` - Winston-based structured logging
- `BaseDatabase` - PostgreSQL connection pool management
- `CostTracker` / `CostCalculator` - Per-request API cost tracking
- `SSEHandler` - Server-Sent Events streaming
- `AuthenticatedRequest` - Express request type with auth context

Build shared before other services: `cd packages/shared && npm run build`

### Service Initialization (Factory Pattern)

- `mcp_backend/src/factories/core-services.ts` → `createBackendCoreServices()` composes all backend services
- `mcp_rada/src/factories/` → `createRadaCoreServices()` composes RADA services
- Both factories wire up database, Redis, Qdrant, embedding service, cost tracker

### Key Services (mcp_backend/src/services/)

- **QueryPlanner** - Classifies user intent, selects search strategy
- **DocumentService** - Document retrieval and caching from ZakonOnline
- **EmbeddingService** - Vector embeddings via OpenAI text-embedding-ada-002
- **SemanticSectionizer** - Breaks documents into logical sections (articles, parts)
- **LegalPatternStore** - Stores/retrieves legal reasoning patterns in Qdrant
- **CitationValidator** - Validates legal citations against source documents
- **HallucinationGuard** - Prevents AI from generating unsupported claims
- **CostTracker** - Tracks OpenAI/Anthropic/RADA API costs per request
- **LegislationService** - Legislation text retrieval with intelligent sectioning
- **VaultService** - Secure document storage and retrieval

### Adapter Pattern (mcp_backend/src/adapters/)

- **ZOAdapter** - Two instances: one for court cases search, one for legal practice database (different ZakonOnline endpoints)
- **RadaLegislationAdapter** - Fetches legislation from Verkhovna Rada API (zakon.rada.gov.ua)

### Frontend Architecture (lexwebapp/)

- **State**: Zustand stores (`src/stores/`) for auth, documents, UI state
- **Data fetching**: TanStack React Query (`src/lib/react-query.ts`) with configured stale times
- **Services**: API client layer (`src/services/`) wrapping backend HTTP endpoints
- **Routing**: React Router with protected routes
- **UI**: TailwindCSS + custom component library (`src/components/ui/`)
- **Build**: Vite with separate staging (`npm run build:staging`) and production configs

## Development Commands

### Backend (mcp_backend)

```bash
cd mcp_backend
npm run dev:http     # HTTP server (port 3000)
npm run dev          # MCP stdio mode
npm run dev:sse      # SSE mode for remote MCP
npm run build && npm start:http  # Production HTTP
npm run db:setup     # Create DB and run migrations
npm run migrate      # Run migrations only
npm test             # Jest tests
npm run lint
```

### RADA Server (mcp_rada)

```bash
cd mcp_rada
npm run dev:http     # HTTP server (port 3001)
npm run dev          # MCP stdio mode
npm run db:setup
npm run sync:deputies   # Fetch deputy data from RADA API
npm run sync:laws       # Fetch legislation texts
npm run cleanup:cache   # Clean expired cache entries
npm run build && npm test
```

### OpenReyestr Server (mcp_openreyestr)

```bash
cd mcp_openreyestr
npm run dev:http     # HTTP server (port 3005)
npm run dev          # MCP stdio mode
npm run db:setup && npm run migrate
npm run import:entities   # Import legal entities from XML
npm run import:debtors    # Import debtors registry
npm run build && npm test
```

### Frontend (lexwebapp)

```bash
cd lexwebapp
npm run dev            # Vite dev server
npm run build          # Production build
npm run build:staging  # Staging build
npm run test           # Vitest
npm run test:coverage
npm run lint
```

### Monorepo Root

```bash
npm run install:all    # Install all dependencies (root + workspaces)
npm run backend        # Start mcp_backend HTTP
npm run frontend       # Start lexwebapp dev server
```

## Port Allocation

| Service | HTTP | PostgreSQL | Redis | Qdrant |
|---------|------|-----------|-------|--------|
| mcp_backend | 3000 | 5432 | 6379 | 6333-6334 |
| mcp_rada | 3001 | 5433 | 6380 | 6335-6336 |
| mcp_openreyestr | 3005 | 5435 | 6382 | - |

**Deployment environments**:
- Local: `localhost:3000`
- Stage: `https://stage.legal.org.ua` (Unified Gateway on port 3004, all 45 tools)

## Environment Variables

Each service has `.env.example` with all required variables. Key vars:
- `DATABASE_URL` / `POSTGRES_*` - PostgreSQL connection
- `REDIS_HOST`, `REDIS_PORT` - Redis cache
- `QDRANT_URL` - Vector database
- `OPENAI_API_KEY` - AI embeddings and analysis
- `SECONDARY_LAYER_KEYS` - API authentication tokens (comma-separated)
- `OPENAI_MODEL_QUICK/STANDARD/DEEP` - Budget-aware model selection
- `ZAKONONLINE_API_TOKEN` - ZakonOnline court database API
- `JWT_SECRET` - JWT authentication secret
- `ENABLE_UNIFIED_GATEWAY` - Enable unified gateway mode (stage)

## Database Migrations

Migrations in `mcp_backend/src/migrations/`, `mcp_rada/src/migrations/`, `mcp_openreyestr/src/migrations/`.

```bash
cd mcp_backend && npm run migrate   # Builds then runs dist/migrations/migrate.js
cd mcp_rada && npm run migrate
cd mcp_openreyestr && npm run migrate
```

## Docker Deployment

All Dockerfiles and compose files in `deployment/`. Compose files use `context: ..` (repo root).

```bash
cd deployment

# Local development
./manage-gateway.sh start local     # Start all services
./manage-gateway.sh deploy local    # Full rebuild (--no-cache)
./manage-gateway.sh logs local
./manage-gateway.sh stop local

# Remote deployment (git pull, migrate, rebuild, restart)
./manage-gateway.sh deploy stage    # → mail.lexapp.co.ua

# Status
./manage-gateway.sh status
./manage-gateway.sh health
```

Dockerfiles: `Dockerfile.mono-backend`, `Dockerfile.mono-rada`, `Dockerfile.mono-openreyestr`, `Dockerfile.document-service`

Deploy process pre-builds `packages/shared` and `mcp_backend` dist on remote before Docker build.

## Testing

| Service | Framework | Command |
|---------|-----------|---------|
| mcp_backend | Jest (ts-jest) | `npm test` |
| mcp_rada | Jest (ts-jest) | `npm test` |
| mcp_openreyestr | Jest (ts-jest) | `npm test` |
| lexwebapp | Vitest | `npm run test` |
| E2E | Playwright | `cd tests && npx playwright test` |

Backend Jest config: `maxWorkers=1`, `testTimeout=120000` (tests may call external APIs).

Test files: `__tests__/` directories alongside source. E2E specs in `tests/e2e/`.

```bash
# Single test file
cd mcp_backend && npx jest --no-cache path/to/file.test.ts
cd lexwebapp && npx vitest run path/to/file.test.ts
cd tests && npx playwright test e2e/specific-test.spec.ts
```

## Common Workflows

### Adding a new MCP tool

1. Define tool schema in `mcp_backend/src/api/mcp-query-api.ts` or new file in `src/api/`
2. Implement handler method in the API class
3. Register in `getTools()` and add to `src/api/tool-registry.ts`
4. Add HTTP route in `http-server.ts` if needed
5. Write tests in `src/api/__tests__/`

### Working with legislation

LegislationService fetches full text from RADA API, splits into logical sections (articles, parts, chapters), stores in PostgreSQL. Requesting "Constitution Article 124" returns just that article, not the whole document.

Aliases recognized: "constitution", "цивільний кодекс", "кримінальний кодекс", etc.

### Cost tracking

Every tool execution tracks: OpenAI tokens (prompt + completion), model/tier, execution time, external API calls. Stored in `cost_tracking` table, aggregated in `monthly_api_usage`.

## HTTP Server Structure (all services)

Express app with:
- **Auth**: Bearer token (`SECONDARY_LAYER_KEYS`) + optional JWT/OAuth
- **Tool execution**: `POST /api/tools/:toolName`
- **SSE streaming**: `POST /api/tools/:toolName/stream`
- **Batch**: `POST /api/tools/batch`
- **Health**: `GET /health`

## Important Notes

- **Two ZOAdapter instances**: Different ZakonOnline endpoints (court cases vs practice)
- **Cache TTLs**: Deputies 7d, Bills 1d, Laws 30d (RADA server)
- **Model selection**: `ModelSelector` from shared package for budget-aware choice
- **Gateway routing**: Nginx at port 8080 routes to stage environment
- **SSE streaming**: For long-running ops, use SSE endpoints (works through gateway)
- **Dual-auth**: Bearer token (API clients) + JWT/OAuth (web users)

## Scripts

- `scripts/deploy/` - Deployment automation
- `scripts/rada/` - RADA data sync and import (deputies, laws)
- `scripts/testing/` - 14 test runner scripts for various scenarios
- `scripts/utilities/` - File conversion (DOCX→text, PDF processing)

## Deployment

- Before deploying, always verify the target port is free with `ss -tlnp | grep <port>` and kill any conflicting process. Never assume a port is available.
- Never force-move or overwrite docker-compose files, Dockerfiles, or lock files without first checking `git diff` or `git status`. Always preserve the newest version and confirm with the user before overwriting.

## Remote Servers

- Always try SSH before HTTPS for git clones on servers.
- Use port 587 for mail relay instead of 25.
- Verify correct server hostname/IP before attempting connections. Don't waste attempts on wrong hosts.

## System Administration

- If a database, config, or system state already exists, do NOT re-initialize it. Always check current state first (`aide --check`, `psql \dt`, etc.) before running destructive init commands. Ask the user before re-initializing anything.
- Before running any destructive command (init, reset, force-push, rm -rf, overwrite), first show the current state of what's about to change, explain why the destructive action is necessary, and wait for explicit user confirmation.

## Firewall / Network

- When working with iptables/firewall rules, always test grep patterns against actual rule output format before writing scripts. Use `iptables -S` or `iptables -L -n` to verify exact syntax before pattern matching.

## Development Practices

### Change Impact Analysis

Before modifying shared configuration values (env vars like VITE_API_URL, API base paths, port numbers, OAuth redirect URIs), trace ALL downstream usages across frontend, backend, and deploy scripts. Never change these without verifying the full impact chain.

## Frontend Conventions

### UI Display Rules

Search results, documents, and evidence MUST render in the right side panel — never in the chat window. When implementing features that return structured data, always verify the rendering target matches the design intent.

## Code Patterns

- When writing SQL in JavaScript string literals, use double-dollar quoting ($$) or parameterized queries instead of single quotes to avoid JS string escaping issues.
- For PostgreSQL migrations, always use `IF NOT EXISTS` / `CREATE OR REPLACE` / `DO $$ BEGIN ... EXCEPTION WHEN ... END $$` patterns to make migrations idempotent.

## Related Documentation

- `docs/ALL_MCP_TOOLS.md` - Complete list of all 45 MCP tools
- `docs/UNIFIED_GATEWAY_IMPLEMENTATION.md` - Unified gateway architecture
- `docs/MCP_CLIENT_INTEGRATION_GUIDE.md` - Connecting LLM clients
- `docs/api/mcp_api_docs.html` - Interactive API Explorer
- `mcp_backend/docs/CLIENT_INTEGRATION.md` - Client integration quick start
- `mcp_backend/docs/SSE_STREAMING.md` - SSE streaming protocol
- `mcp_backend/docs/DATABASE_SETUP.md` - PostgreSQL, Redis, Qdrant setup
- `deployment/LOCAL_DEVELOPMENT.md` - Local development setup
- `deployment/GATEWAY_SETUP.md` - Multi-environment gateway config
