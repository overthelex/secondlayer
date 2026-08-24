# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## MCP & External Tools

- When working with MCP servers, always verify which MCP server is connected and use the correct one before attempting operations. Check `mcp__` tool availability first rather than falling back to SSH or codebase search.
- Available MCP servers: `mcp_backend`, `mcp_rada`, `mcp_openreyestr`, Nextcloud (Deck/Tables/Calendar), Thunderbird, AWS API. Use the correct prefix (`mcp__nextcloud__`, `mcp__thunderbird__`, `mcp__awslabs-aws-api-mcp-server__`).
- Never use SSH or codebase grep as a workaround when the appropriate MCP tool is available.

## Architecture

- This is a monorepo with shared/backend/frontend packages. The app runs in Docker locally (nginx, backend, frontend, DB, MinIO).
- Frontend API calls go through nginx. When changing API URLs or paths, trace the FULL request path (frontend → nginx → backend) before making changes to avoid cascading breakage.
- Features should render results in the right panel/evidence panel, NOT in the chat window, unless explicitly told otherwise.

## TypeScript

- This project uses TypeScript throughout. After making multi-file changes, always run the TypeScript build (`tsc` or the build script) and fix all type errors before committing.
- When removing or refactoring tools/functions, grep for ALL references across the monorepo before deleting to avoid stale references.

## Deployment

- Production deployment is fully automated via CI/CD. Merge PR to main triggers the pipeline. NEVER deploy manually via SSH.
- CI/CD runs on self-hosted runners (on local.lex). **Two prods, one codebase** (split is env-side, never a code fork):
  - `ci-local-deploy.yml` — push to main: builds and tests only (deploys nothing itself)
  - `deploy-legal-ua.yml` — after successful CI (or manual): deploys **legal.org.ua prod on local.lex** from a persistent clone (`LEX_DEPLOY_REPO`), marker tags `deploy-lex-*`
  - `deploy-lawrider.yml` — after successful CI or manual: blue-green deploy to **lawrider.ch on AWS** via SSH (marker tags remain `deploy-prod-*`)
- Blue-green deployment: prod uses `.active-colors` file in `deployment/` to track which color (blue/green) is active per service group (backend, frontend). New deploys go to the inactive color, then traffic is switched.
- Nginx must be `--force-recreated` after ANY upstream/backend change (bind mount staleness).
- Never manually recreate prod containers; use the deploy pipeline.
- After making changes to CI/CD workflows or Dockerfiles, verify the build passes locally or check for missing dependencies (e.g., `npm ci` requires lock files, volume mounts in docker-compose). Never assume CI will pass without validation.
- There is NO stage environment. There are TWO prods: legal.org.ua (local.lex, UA product) and lawrider.ch (AWS, multi-jurisdiction incl. CH/UK/NL/PL).
- After deploying, always check container health and logs for errors.
- After making code changes, always rebuild Docker images before testing (`docker compose build <service>` then `docker compose up -d`). Never test against stale containers.
- Local dev runs in Docker. Do NOT attempt to restart backend processes directly — always use docker compose commands.
- Compose files have NO `env_file:` directives — secrets are injected via shell env substitution. **Always pass `--env-file`**:
  - Local: `docker compose -f docker-compose.local.yml --env-file .env.local up -d`
  - Prod: `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d`

## Git Workflow

- Always create feature branches from `main` unless explicitly told otherwise.
- Standard flow: commit → push → create PR → merge → switch back to main.
- Never create branches off other feature branches without asking.
- When asked to commit and push, commit ONLY the files relevant to the current task. Do not stage unrelated files or over-scope commits.
- If the user says a number or short response after listing options, ask for clarification rather than assuming intent.

## Working Style

- Prefer action over analysis. When the user asks to implement something, start coding after brief analysis (< 2 minutes exploration). Do NOT spend the whole session producing plans without writing code.
- If asked to fix a specific bug, stay focused on that bug. Do not go down rabbit holes investigating tangentially related issues unless explicitly asked.

## Project Overview

- This is a TypeScript monorepo. Primary language is TypeScript. Always ensure builds pass (`npm run build` or equivalent) before creating PRs or deploying.

## Project Stack

- Monorepo with shared/backend/frontend packages
- Language: TypeScript (primary), YAML for configs, Shell for deploy scripts
- Infrastructure: Docker Compose for local dev, MinIO for storage, Nginx as reverse proxy
- Auth: Google OAuth, Authentik (OIDC), Diia, password, WebAuthn
- Payments: Monobank (live, dual UAH/USD balance system)
- Architecture: MCP tools pattern with LLM orchestration

## Session Scope

When the user asks for a specific task (e.g., 'commit frontend changes'), do exactly that. Do not expand scope to investigate related issues, refactor adjacent code, or explore the codebase unless explicitly asked. If you see something worth investigating, mention it briefly and ask before proceeding.

## Language & Localization

- This project uses Ukrainian (uk-UA) for all user-facing strings and error messages.
- All UI text, toast notifications, and error messages should be in Ukrainian unless told otherwise.

## Infrastructure Notes

- Primary stack: TypeScript, Docker Compose, PostgreSQL (with PgBouncer), Redis, Qdrant.
- Only two environments: local and prod — always double-check VITE_API_URL and similar env vars match the target environment.
- When changing PostgreSQL auth or connection pooling config, verify auth method compatibility (MD5 vs SCRAM-SHA-256).
- Never change SSH-related paths (home directory, authorized_keys) on remote servers without explicit confirmation.
- SSH to prod as `ubuntu`, not root. Use `ssh prod` alias (key at `~/.ssh/secondlayer-prod`).
- When deploying to production or working with infrastructure, verify SSH keys match the target region/instance before proceeding. For multi-server setups, confirm IP bindings and firewall rules (ufw, postfix mynetworks) for each new service.

## Debugging Approach

- When debugging production issues, start with logs and targeted debug output FIRST. Do not extensively explore the codebase before checking actual runtime behavior.
- When asked to check errors or logs, always check the REMOTE server logs (via SSH) unless explicitly told to check locally.
- When diagnosing search/query issues, log the actual generated query before assuming the logic is correct.
- When fixing bugs, deploy the fix AND verify it works in the target environment before marking done.

## Git & Deployment Workflow

Branch `main` is protected — direct pushes are blocked for everyone (including admins). All changes must go through a Pull Request with at least 1 approving review.

After completing code changes, always: 1) Build and verify no errors, 2) Create a feature branch (`git checkout -b <descriptive-name>`), 3) Commit with a descriptive message, 4) Push the branch and create a PR via `gh pr create`, 5) Deploy locally if requested. Do NOT over-scope commits — only stage files relevant to the current task. NEVER push directly to `main`.

## Local Dev Environment

- Backend services run in Docker containers, NOT as local processes. Do not attempt to restart backend services outside Docker.
- Always run `docker compose build` after code changes before testing — do not test against stale images.
- Run commands from the correct workspace directory (check with `pwd` before executing).
- Use the correct env passwords from `.env` files, not defaults.

## Project Defaults

Primary stack: TypeScript, YAML, Shell. When creating new files, default to TypeScript (the project already uses TypeScript throughout).

Before implementing non-trivial features, use a task agent to investigate: (1) current state of the system/service, (2) exact API limits or format requirements, (3) existing configs or files that would conflict. Report findings before writing any code.

## Repository Overview

SecondLayer is a monorepo for a Ukrainian legal tech platform. It provides AI-powered legal document analysis, semantic search over court decisions (via EDRSR — state court decision registry), legislation retrieval, parliament data, business registry lookups, consultations, billing, and payments via MCP (Model Context Protocol) servers.

### Workspace Structure

```
SecondLayer/
├── mcp_backend/        # Primary MCP server - court cases, legal docs, consultations, billing
├── mcp_rada/           # Parliament data server (deputies, bills, legislation)
├── mcp_openreyestr/    # State Register server (business entities, beneficiaries, debtors)
├── lexwebapp/          # Web frontend (React 19, Vite, TailwindCSS)
├── packages/shared/    # Shared TypeScript types and utilities (@secondlayer/shared)
├── platform/           # Platform service (separate frontend)
├── mobile/             # Mobile app (Flutter)
├── opendata-sync/      # Open data synchronization service
├── terminal-service/   # Terminal service
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
- **External APIs**: EDRSR (state court decision registry), Verkhovna Rada Open Data, data.gov.ua (OpenReyestr)
- **Framework**: Express.js, MCP SDK (`@modelcontextprotocol/sdk`)
- **Frontend**: React 19, Vite, TailwindCSS 3, Zustand (state), TanStack Query (data fetching), Vitest
- **Payments**: Monobank API (dual UAH/USD balance)
- **Mobile**: Flutter (Dart)

### Unified Gateway

Production aggregates all services behind a single endpoint (`ENABLE_UNIFIED_GATEWAY=true`):
- **Backend tools** (no prefix) - court cases, semantic search, legislation, patterns, citations, vault
- **RADA tools** (`rada_*`) - deputies, bills, legislation, voting
- **OpenReyestr tools** (`openreyestr_*`) - entity search, beneficiaries, debtors

Tool registry: `mcp_backend/src/api/tool-registry.ts` maps tool names to handler classes.

### Shared Package (`@secondlayer/shared`)

Key exports used across all services:
- `getOpenAIManager` / `getAnthropicManager` - LLM client singletons
- `LLMManager` - Unified interface for OpenAI/Anthropic with fallback
- `ModelSelector` - Budget-aware, multi-provider model selection. Provider order via `LLM_PROVIDER_STRATEGY` (prod = `bedrock-first`). Prod tiers (Bedrock, eu-central-1): quick → Claude Haiku 4.5, standard → Claude Sonnet 4.6, deep → Claude Opus 4.6; throttle fallback → Amazon Nova (micro/pro). OpenAI fallback tiers: quick → gpt-5-nano, standard → gpt-5-mini, deep → gpt-5.1
- `logger` - Winston-based structured logging
- `BaseDatabase` - PostgreSQL connection pool management
- `CostTracker` / `CostCalculator` - Per-request API cost tracking
- `SSEHandler` - Server-Sent Events streaming
- `AuthenticatedRequest` - Express request type with auth context

Build shared before other services: `cd packages/shared && npm run build`

### Service Initialization (Factory Pattern)

- `mcp_backend/src/factories/core-services.ts` → `createBackendCoreServices()` composes all backend services
- `mcp_backend/src/factories/app-services.ts` → application-level services (auth, billing, etc.)
- `mcp_backend/src/factories/billing-services.ts` → billing and payment services
- `mcp_rada/src/factories/rada-services.ts` → composes RADA services
- Factories wire up database, Redis, Qdrant, embedding service, cost tracker

### Key Services (mcp_backend/src/services/)

- **QueryPlanner** - Classifies user intent, selects search strategy
- **DocumentService** - Document retrieval and caching
- **EmbeddingService** - Vector embeddings via OpenAI text-embedding-ada-002
- **SemanticSectionizer** - Breaks documents into logical sections (articles, parts)
- **ChatService** - Chat orchestration with intent classification and context building
- **ConsultationService** - Legal consultation management with E2EE
- **BillingService** - Subscription and credit management
- **MonobankService** - Payment processing via Monobank API
- **CostTracker** - Tracks OpenAI/Anthropic/RADA API costs per request
- **LegislationService** - Legislation text retrieval with intelligent sectioning
- **VaultService** - Secure document storage and retrieval
- **DiiaService** - Diia digital identity integration
- **AuthentikService** - OIDC authentication via Authentik
- **EdsrFtsService** - Full-text search over EDRSR court decisions
- **EdsrCacheService** - Caching layer for EDRSR data

### Adapter Pattern (mcp_backend/src/adapters/)

- **EDRSRLocalAdapter** - Local EDRSR court decision registry adapter
- **RadaLegislationAdapter** - Fetches legislation from Verkhovna Rada API (zakon.rada.gov.ua)
- **ZOAdapter** - Legacy adapter (ZakonOnline API is deprecated and being removed)

### Frontend Architecture (lexwebapp/)

- **State**: Zustand stores (`src/stores/`) for auth, documents, UI state
- **Data fetching**: TanStack React Query (`src/lib/react-query.ts`) with configured stale times
- **Services**: API client layer (`src/services/`) wrapping backend HTTP endpoints
- **Routing**: React Router with protected routes
- **UI**: TailwindCSS + custom component library (`src/components/ui/`)
- **Build**: Vite with production config

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
npm run sync:registries   # Sync all NAIS registries
npm run build && npm test
```

### Frontend (lexwebapp)

```bash
cd lexwebapp
npm run dev            # Vite dev server
npm run build          # Production build
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
- Local: `localhost:3000` / `https://local.legal.org.ua`
- Prod: `https://legal.org.ua`

## Environment Variables

Each service has `.env.example` with all required variables. Key vars:
- `DATABASE_URL` / `POSTGRES_*` - PostgreSQL connection
- `REDIS_HOST`, `REDIS_PORT` - Redis cache
- `QDRANT_URL` - Vector database
- `OPENAI_API_KEY` - AI embeddings and analysis
- `SECONDARY_LAYER_KEYS` - API authentication tokens (comma-separated)
- `OPENAI_MODEL_QUICK/STANDARD/DEEP` - Budget-aware model selection
- `JWT_SECRET` - JWT authentication secret
- `ENABLE_UNIFIED_GATEWAY` - Enable unified gateway mode
- `MONOBANK_TOKEN` - Monobank payment API token
- `PUBLIC_URL` - Public URL for payment callbacks

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

# Status
./manage-gateway.sh status
./manage-gateway.sh health
```

Dockerfiles: `Dockerfile.mono-backend`, `Dockerfile.mono-rada`, `Dockerfile.mono-openreyestr`, `Dockerfile.document-service`, `Dockerfile.opendata-sync`, `Dockerfile.terminal-service`

## CI/CD Pipeline

Two GitHub Actions workflows on self-hosted runner:

1. **`ci-local-deploy.yml`** (on push to main):
   - Detects which services changed
   - Builds shared package, then changed services
   - Runs unit tests (Jest for backend, Vitest for frontend)
   - Deploys to local Docker environment
   - Health checks all deployed services
   - Self-heals build failures via Claude Code agent (creates autofix PRs)

2. **`deploy-prod.yml`** (after successful local CI, or manual trigger):
   - Pre-deploy tests (build + test changed services)
   - Blue-green deploy: builds inactive color on prod via SSH, runs migrations, starts new containers
   - Preview phase: new version accessible alongside old one
   - Switch phase: updates nginx upstreams to point to new color
   - Tags releases with semantic versioning (backend: `v*`, frontend: `fe-v*`)
   - Self-heals test failures via Claude Code agent

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

1. Create tool handler file in `mcp_backend/src/api/tools/`
2. Implement handler method extending the tool pattern
3. Register in `src/api/tool-registry.ts`
4. Add HTTP route in `http-server.ts` if needed
5. Write tests in `src/api/__tests__/`

### Working with legislation

LegislationService fetches full text from RADA API, splits into logical sections (articles, parts, chapters), stores in PostgreSQL. Requesting "Constitution Article 124" returns just that article, not the whole document.

Aliases recognized: "constitution", "цивільний кодекс", "кримінальний кодекс", etc.

### Cost tracking

Every tool execution tracks: OpenAI tokens (prompt + completion), model/tier, execution time, external API calls. Stored in `cost_tracking` table, aggregated in `monthly_api_usage`.

## HTTP Server Structure (all services)

Express app with:
- **Auth**: Bearer token (`SECONDARY_LAYER_KEYS`) + JWT/OAuth/OIDC/Diia/WebAuthn
- **Tool execution**: `POST /api/tools/:toolName`
- **SSE streaming**: `POST /api/tools/:toolName/stream`
- **Batch**: `POST /api/tools/batch`
- **Health**: `GET /health`

## Important Notes

- **Cache TTLs**: Deputies 7d, Bills 1d, Laws 30d (RADA server)
- **Model selection**: `ModelSelector` from shared package for budget-aware choice
- **SSE streaming**: For long-running ops, use SSE endpoints (works through gateway)
- **Multi-auth**: Bearer token (API clients) + JWT/OAuth/OIDC/Diia/password/WebAuthn (web users)
- **Monobank payments**: Live with dual UAH/USD balance system, PUBLIC_URL required for callbacks
- **Blue-green prod**: Check `.active-colors` in deployment/ for current active color per service

## Scripts

- `scripts/deploy/` - Deployment automation
- `scripts/rada/` - RADA data sync and import (deputies, laws)
- `scripts/edrsr/` - Court registry (EDRSR) data: download, import, sync
- `scripts/opendata/` - Open data imports (NIPO patents/trademarks, etc.)
- `scripts/testing/` - Test runner scripts for various scenarios
- `scripts/utilities/` - File conversion (DOCX/PDF to text), MinIO cleanup

## Remote Servers

- SSH to prod as `ubuntu` user: `ssh prod` (key at `~/.ssh/secondlayer-prod`).
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

## Task Management

- Task management is via Nextcloud (Deck boards). Linear is fully deprecated.

## Frontend Conventions

- UI text should be in Ukrainian (uk-UA) unless specified otherwise.

### UI Display Rules

Search results, documents, and evidence MUST render in the right side panel — never in the chat window. When implementing features that return structured data, always verify the rendering target matches the design intent.

## Database Operations

- For large PostgreSQL operations (migrations, bulk imports, index creation), always: 1) Set appropriate `statement_timeout`, 2) Use bulk INSERT strategies over batch DELETE+INSERT, 3) Account for competing queries and locks, 4) Use screen/tmux with reconnection plans.
- For production DB operations on large tables (millions of rows), prefer `CREATE INDEX CONCURRENTLY`, partition-based strategies, and off-peak scheduling.

## Data Import & Scraping

- When scraping external APIs (spending.gov.ua, Rada, UIPV), expect rate limiting and global throttling. Design scripts with: configurable concurrency, per-IP rate limits, resume capability, and graceful error handling from the start.
- Always implement checkpoint/resume logic so interrupted imports can continue without re-downloading.
- Test with a small batch first to discover rate limits and schema issues before scaling up.

## Code Patterns

- When writing SQL in JavaScript string literals, use double-dollar quoting ($$) or parameterized queries instead of single quotes to avoid JS string escaping issues.
- For PostgreSQL migrations, always use `IF NOT EXISTS` / `CREATE OR REPLACE` / `DO $$ BEGIN ... EXCEPTION WHEN ... END $$` patterns to make migrations idempotent.
