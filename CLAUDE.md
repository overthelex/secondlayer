# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SecondLayer** is a semantic legal analysis platform for Ukrainian court cases from Zakononline. It implements a Model Context Protocol (MCP) server that provides AI-powered analysis of legal documents, including semantic search, pattern recognition, citation validation, and hallucination detection.

## Architecture

### Monorepo Structure

```
SecondLayer/
├── mcp_backend/     # TypeScript MCP server
├── frontend/        # React admin panel
└── package.json     # npm workspaces root
```

### Backend Architecture (mcp_backend/)

The backend operates in two modes:
- **MCP Mode**: stdio-based MCP server for AI assistant integration
- **HTTP Mode**: REST API server with SSE streaming support

**Core Services** (`src/services/`):

| Service | Responsibility |
|---------|---------------|
| `query-planner.ts` | Classifies user intent and builds query parameters using OpenAI |
| `semantic-sectionizer.ts` | Extracts structured sections (facts, reasoning, decision) from court documents |
| `embedding-service.ts` | Generates OpenAI embeddings and manages Qdrant vector storage |
| `legal-pattern-store.ts` | Stores and matches legal reasoning patterns across cases |
| `citation-validator.ts` | Validates precedent citations and builds citation graphs |
| `hallucination-guard.ts` | Validates AI responses against source documents |
| `document-service.ts` | PostgreSQL document CRUD operations |

**Key Adapters** (`src/adapters/`):
- `zo-adapter.ts` - Zakononline API client with token rotation and response normalization

**Infrastructure Dependencies:**
- PostgreSQL - document metadata and structured data
- Qdrant - vector embeddings for semantic search
- Redis - caching layer
- OpenAI API - embeddings (text-embedding-ada-002) and GPT analysis

**Dual Entry Points:**
- `src/index.ts` - MCP stdio server
- `src/http-server.ts` - Express HTTP server with SSE streaming

### Frontend Architecture (frontend/)

React admin panel built with Refine framework:
- **Framework**: Refine v4 (React-based admin framework)
- **UI**: Ant Design 5 with custom cyan theme
- **Data Provider**: Custom REST API provider in `src/providers/data-provider.ts`
- **Pages**: Dashboard, Documents, Patterns, Queries (all with CRUD operations)

## Common Commands

### Development

```bash
# Install all dependencies (monorepo)
npm run install:all

# Start backend HTTP server (port 3000)
npm run backend
# or: cd mcp_backend && npm run dev:http

# Start backend in MCP mode (stdio)
cd mcp_backend && npm run dev

# Start frontend (port 5173)
npm run frontend
# or: cd frontend && npm run dev

# Build for production
npm run backend:build    # Creates dist/ folder
npm run frontend:build   # Creates dist/ folder
```

### Database

```bash
cd mcp_backend

# Create database and run migrations
npm run db:setup

# Run migrations only (requires build first)
npm run migrate

# Create database only
npm run db:create
```

### Testing

```bash
cd mcp_backend

# Run all tests
npm test

# Watch mode
npm test:watch

# Lint TypeScript
npm run lint
```

### Docker

```bash
cd mcp_backend

# Start all services (PostgreSQL, Redis, Qdrant, app)
docker-compose up -d

# Rebuild and start
docker-compose up -d --build

# View logs
docker-compose logs -f app

# Stop all services
docker-compose down
```

## Environment Configuration

### Root `.env`
```bash
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456
```

### `mcp_backend/.env`
```bash
# Database
DATABASE_URL=postgresql://secondlayer:secondlayer_password@localhost:5432/secondlayer_db

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Qdrant Vector Database
QDRANT_URL=http://localhost:6333

# OpenAI (supports key rotation)
OPENAI_API_KEY=sk-...
OPENAI_API_KEY2=sk-...      # Optional fallback key
OPENAI_MODEL=gpt-4o-mini    # Model for analysis tasks

# Zakononline API (supports token rotation)
ZAKONONLINE_API_TOKEN=your-token
ZAKONONLINE_API_TOKEN2=your-token-2  # Optional fallback

# HTTP Server Security
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456
HTTP_PORT=3000
HTTP_HOST=0.0.0.0
```

### `frontend/.env`
```bash
VITE_API_URL=http://localhost:3000/api
VITE_SECONDARY_LAYER_KEY=test-key-123
```

## API Integration

### HTTP Mode Endpoints

All endpoints except `/health` require `Authorization: Bearer <SECONDARY_LAYER_KEY>` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (no auth) |
| GET | `/api/tools` | List available MCP tools |
| POST | `/api/tools/:toolName` | Execute MCP tool (JSON or SSE) |
| POST | `/api/tools/:toolName/stream` | Execute tool with SSE streaming |
| POST | `/api/tools/batch` | Batch tool execution |

**SSE Streaming**: Set `Accept: text/event-stream` header or use `/stream` endpoint for real-time progress events.

### MCP Tools

When running in MCP mode, these tools are available:

1. **search_legal_precedents** - Search court decisions with semantic analysis
   - Supports case number detection (e.g., "756/655/23")
   - Uses AI to extract search terms from source cases
   - Returns similar cases with metadata

2. **analyze_case_pattern** - Analyze patterns in judicial practice
   - Identifies success/failure arguments
   - Calculates risk factors
   - Provides outcome statistics

3. **get_similar_reasoning** - Find similar judicial reasoning by vector similarity

4. **extract_document_sections** - Extract structured sections (FACTS, REASONING, DECISION, etc.)

5. **find_relevant_law_articles** - Find frequently cited law articles for a topic

6. **check_precedent_status** - Validate precedent status (valid, overruled, questioned, etc.)

7. **get_citation_graph** - Build citation relationships between cases

8. **get_legal_advice** - Comprehensive analysis with source validation
   - Supports streaming mode with progress events
   - Includes hallucination detection
   - Provides reasoning chain with confidence scores

## Key Implementation Details

### TypeScript Configuration

- **ES Modules**: Uses `.js` extensions in import statements despite TypeScript sources
- **Target**: ES2020
- **Module**: ESNext with NodeNext resolution
- Configured in `mcp_backend/tsconfig.json`

### API Key Rotation

Both OpenAI and Zakononline adapters support automatic key rotation:
- `OpenAIClientManager` in `utils/openai-client.ts`
- `ZOAdapter` in `adapters/zo-adapter.ts`
- Rotates on 429 (rate limit) and 401/403 (auth errors)

### HTML Parsing

Court decisions from Zakononline come as HTML. The system:
1. Parses HTML using Cheerio (`utils/html-parser.ts`)
2. Extracts text from `#article-container`
3. Identifies sections by Ukrainian keywords (УСТАНОВИВ, ВИРІШИВ)
4. Uses OpenAI to extract search terms for semantic analysis

### Vector Embeddings

- Model: `text-embedding-ada-002` (1536 dimensions)
- Stored in Qdrant with metadata (doc_id, section_type, law_articles)
- Used for semantic similarity search in court reasoning

### Reasoning Budgets

Three levels of analysis depth defined in `src/types/index.ts`:
- `quick`: 1 LLM call, 1000 tokens
- `standard`: 3 LLM calls, 3000 tokens
- `deep`: 5 LLM calls, 5000 tokens

## Development Workflow

### Adding a New MCP Tool

1. Define tool schema in `src/api/mcp-query-api.ts` → `getTools()`
2. Add handler method to `MCPQueryAPI` class
3. Add case to `handleToolCall()` switch statement
4. For streaming: implement `*Stream()` method with `StreamEventCallback`

### Database Migrations

1. Create SQL file in `src/migrations/` with naming: `NNN_description.sql`
2. Run `npm run migrate` from mcp_backend directory
3. Migration tracking stored in `migrations` table

### Testing Strategy

- Tests in `src/api/__tests__/`
- Jest configuration: `jest.config.js`
- Run single test: `npm test -- search-legal-precedents.test.ts`

## Troubleshooting

### Port 3000 Already in Use
Check if backend is already running: `lsof -i :3000`

### Qdrant Unhealthy
Qdrant takes ~30s to start. Check: `curl http://localhost:6333/`

### Frontend 401 Errors
1. Verify backend is running on port 3000
2. Check `VITE_SECONDARY_LAYER_KEY` matches a key in backend's `SECONDARY_LAYER_KEYS`

### TypeScript Build Errors with .js Extensions
This is intentional for ES modules. Don't remove `.js` from imports.

## Related Documentation

- `mcp_backend/docs/SSE_STREAMING.md` - Server-Sent Events implementation
- `mcp_backend/docs/DATABASE_SETUP.md` - Database setup guide
- `frontend/SETUP.md` - Frontend configuration details
- `MIGRATION_SUMMARY.md` - Project migration history
