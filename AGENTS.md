# AGENTS.md — SecondLayer Developer Guide

This file provides guidance for AI coding agents operating in this repository.

## Project Overview

SecondLayer is a Ukrainian legal tech monorepo with 3 MCP backend servers + React frontend:
- `mcp_backend/` — primary server: court cases, legal docs, chat, uploads (port 3000)
- `mcp_rada/` — parliament data: deputies, bills, legislation (port 3001)
- `mcp_openreyestr/` — state register: businesses, beneficiaries (port 3005)
- `lexwebapp/` — React 19 + Vite + TailwindCSS frontend
- `packages/shared/` — shared TypeScript types and utilities
- `deployment/` — Docker Compose configs, nginx, scripts
- `tests/` — Playwright E2E tests

**Tech Stack**: TypeScript 5.3, Node.js 20, Express.js, MCP SDK, React 19, PostgreSQL, Redis, Qdrant

---

## Build / Lint / Test Commands

### Root Commands
```bash
npm run install:all    # Install all dependencies
npm run backend        # Start mcp_backend HTTP (port 3000)
npm run frontend       # Start lexwebapp dev server
```

### mcp_backend (Jest)
```bash
cd mcp_backend
npm run build          # Compile TypeScript
npm run lint           # ESLint
npm run test           # All tests
npm run test:watch     # Watch mode
npx jest --no-cache src/path/to/file.test.ts  # Single test file
npx jest --no-cache src/path/to/file.test.ts -t "test name"  # Single test
npm run dev:http       # Dev HTTP server (port 3000)
npm run dev            # Dev MCP stdio mode
npm run db:setup       # Create DB + run migrations
npm run migrate        # Run migrations only
```

### mcp_rada
```bash
cd mcp_rada
npm run build && npm start:http    # Production HTTP
npm run dev:http                   # Dev HTTP (port 3001)
npm run test                        # Jest tests
npm run lint
npm run db:setup
npm run sync:deputies              # Fetch deputy data
npm run sync:laws                  # Fetch legislation
```

### mcp_openreyestr
```bash
cd mcp_openreyestr
npm run build && npm start:http    # Production HTTP
npm run dev:http                   # Dev HTTP (port 3005)
npm run test
npm run db:setup && npm run migrate
npm run import:entities            # Import legal entities
npm run import:debtors             # Import debtors registry
```

### lexwebapp (Vitest)
```bash
cd lexwebapp
npm run build              # Production build
npm run build:staging      # Staging build
npm run lint               # ESLint
npm run test               # All tests
npm run test:watch         # Watch mode
npm run test:coverage      # With coverage
npx vitest run src/path/to/file.test.ts    # Single test
npx vitest run src/path/to/file.test.ts -t "test name"
npm run dev                # Vite dev server
```

### E2E Tests (Playwright)
```bash
cd tests
npx playwright test                    # All E2E
npx playwright test e2e/test-name      # Single spec
npx playwright test --headed           # Browser UI
npx playwright show-report              # View report
```

### Docker (Local Dev)
```bash
cd deployment
./manage-gateway.sh start local        # Start all services
./manage-gateway.sh logs local         # View logs
docker compose -f docker-compose.local.yml build  # Rebuild after code changes
```

---

## Code Style Guidelines

### General Principles
- **Language**: TypeScript (primary), JavaScript for configs, YAML for configs, Shell for deploy scripts
- **Default to JavaScript** for new files unless project uses TypeScript
- **No comments** unless explicitly requested
- Use existing patterns from neighboring files

### Naming Conventions
- **Files**: kebab-case (`court-decisions.service.ts`)
- **Classes/PascalCase**: `class CourtDecisionService`
- **Functions/camelCase**: `getDocumentById()`, `searchCourtCases()`
- **Constants/UPPER_SNAKE_CASE**: `MAX_BATCH_SIZE`, `API_TIMEOUT_MS`
- **Interfaces**: `interface CourtDecision`, `interface SearchResult`
- **Types**: `type SearchParams`, `type ApiResponse<T>`

### Imports
- **Order**: external → internal/shared → relative
- **Use absolute imports** from workspace packages: `@secondlayer/shared`
- **Relative imports** for local files: `./services/`, `../types/`
- **No barrel exports** (index.ts) unless explicitly needed

### TypeScript
- **Always use explicit types** for function parameters and return values
- **Avoid `any`** — use `unknown` or proper generics
- **Use interfaces** for objects, types for unions/aliases
- **Enable strict null checks**

### Error Handling
- **Use custom error classes** extending `Error` (e.g., `class ApiError extends Error`)
- **Always log errors** with context using the logger: `logger.error('message', { error, params })`
- **Return typed errors** from API endpoints with proper HTTP status codes
- **Never expose internal errors** to clients — log full error, return safe message

### SQL & Database
- **Use parameterized queries** or double-dollar quoting ($$)
- **Always use `IF NOT EXISTS` / `CREATE OR REPLACE`** for idempotent migrations
- **Use transactions** for multi-step operations

### React / Frontend
- **UI Display**: Search results and documents MUST render in the right side panel — never in the chat window
- **State**: Use Zustand stores for global state
- **Data fetching**: Use TanStack React Query with configured stale times
- **Components**: Functional components with hooks, no class components
- **TailwindCSS**: Use utility classes, avoid custom CSS

### Architecture Patterns
- **Factory pattern** for service initialization (e.g., `createBackendCoreServices()`)
- **Adapter pattern** for external APIs (e.g., `ZOAdapter`, `RadaLegislationAdapter`)
- **Service layer** for business logic, keep controllers thin
- **Shared package** (`@secondlayer/shared`) for common types and utilities

### Git & Deployment
- **Branch `main` is protected** — all changes via PR with review
- **Never push directly to main**
- **Commit message**: concise, focus on "why" not "what"
- **After code changes**: rebuild Docker images before testing
- **Use descriptive branch names**: `feature/description` or `fix/description`

---

## Key Files & Locations

### Service Structure
- `src/api/` — HTTP endpoints and MCP tools
- `src/services/` — Business logic
- `src/adapters/` — External API integrations
- `src/factories/` — Service initialization
- `src/migrations/` — Database migrations

### Configuration
- Environment variables in `.env.example` files per service
- Key vars: `DATABASE_URL`, `REDIS_HOST`, `OPENAI_API_KEY`, `SECONDARY_LAYER_KEYS`

### 45 MCP Tools (Unified Gateway)
- **Backend (36)**: search, documents, legislation, analysis, vault
- **RADA (4)**: rada_search_deputies, rada_get_deputy_info, rada_search_bills, rada_get_legislation
- **Registry (5)**: openreyestr_search_entities, openreyestr_get_entity, openreyestr_search_beneficiaries

---

## Important Notes

1. **Backend runs in Docker** — do NOT try to start services locally outside Docker
2. **After code changes**: rebuild with `docker compose build` before testing
3. **Stage URL**: https://stage.legal.org.ua
4. **Local URL**: http://localhost:3000
5. **Dual auth**: Bearer token (API clients) + JWT/OAuth (web users)
