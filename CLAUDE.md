# CLAUDE.md

This file provides guidance to Claude Code when working with the SecondLayer project.

## Project Overview

**SecondLayer** is a legal documents analysis platform for Ukrainian court cases from Zakononline. It uses MCP (Model Context Protocol) for AI-powered semantic analysis and includes a web admin panel.

## Architecture

```
SecondLayer/
├── mcp_backend/     # MCP server (TypeScript + Express)
├── frontend/        # Admin panel (React + Refine + Ant Design)
├── .env             # Root configuration
└── package.json     # Monorepo with npm workspaces
```

### Backend (mcp_backend/)

TypeScript MCP server providing:
- Court case search via Zakononline API
- Semantic document analysis
- Legal pattern recognition
- Citation validation
- Hallucination detection

**Key Services** (`src/services/`):
| Service | Purpose |
|---------|---------|
| `document-service.ts` | Document storage and retrieval |
| `query-planner.ts` | Query planning and optimization |
| `semantic-sectionizer.ts` | Document section analysis |
| `embedding-service.ts` | Vector embeddings (OpenAI) |
| `legal-pattern-store.ts` | Legal pattern storage |
| `citation-validator.ts` | Citation verification |
| `hallucination-guard.ts` | AI response validation |

**Infrastructure:**
- PostgreSQL - primary database
- Redis - caching
- Qdrant - vector database for semantic search
- OpenAI API - embeddings and analysis

### Frontend (frontend/)

React admin panel built with:
- Refine - admin framework
- Ant Design 5 - UI components
- Vite - build tool
- Lucide React - icons

**Pages** (`src/pages/`):
- `dashboard/` - Overview and statistics
- `documents/` - Document management
- `patterns/` - Legal pattern management
- `queries/` - Query history

## Common Commands

```bash
# Install all dependencies (from root)
npm run install:all

# Start backend (port 3000)
npm run backend
# or: cd mcp_backend && npm run dev:http

# Start frontend (port 5173)
npm run frontend
# or: cd frontend && npm run dev

# Build
npm run backend:build
npm run frontend:build

# Database
cd mcp_backend
npm run db:setup      # Create DB and run migrations
npm run migrate       # Run migrations only

# Tests
cd mcp_backend && npm test
```

## Environment Variables

### Root `.env`
```bash
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456
```

### `mcp_backend/.env`
```bash
DATABASE_URL=postgresql://user:password@localhost:5432/secondlayer
REDIS_HOST=localhost
QDRANT_URL=http://localhost:6333
OPENAI_API_KEY=your-key
ZAKONONLINE_API_TOKEN=your-token
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456
```

### `frontend/.env`
```bash
VITE_API_URL=http://localhost:3000/api
VITE_SECONDARY_LAYER_KEY=test-key-123
```

## API Endpoints

All endpoints except `/health` require `Authorization: Bearer <SECONDARY_LAYER_KEY>` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (no auth) |
| GET | `/api/tools` | List available MCP tools |
| POST | `/api/search` | Search documents |
| POST | `/api/analyze` | Analyze document |
| POST | `/api/call-tool` | Execute MCP tool |

## Docker

```bash
cd mcp_backend
docker-compose up -d          # Start services
docker-compose up -d --build  # Rebuild and start
```

## Key Files

| File | Purpose |
|------|---------|
| `mcp_backend/src/http-server.ts` | HTTP server entry point |
| `mcp_backend/src/index.ts` | MCP stdio entry point |
| `mcp_backend/src/api/mcp-query-api.ts` | MCP tools API |
| `mcp_backend/src/adapters/zo-adapter.ts` | Zakononline API adapter |
| `frontend/src/App.tsx` | React app entry |
| `frontend/src/providers/` | Data providers for Refine |

## Development Notes

- Backend uses `.js` extensions in imports (TypeScript with ESM)
- Frontend uses Vite with React plugin
- Authentication uses bearer tokens from `SECONDARY_LAYER_KEYS`
- Monorepo managed with npm workspaces

## Related Projects

This project is part of the ZOMCP ecosystem:
- `indexesdownload/` - Index downloading utilities
- `simple_legalmcp/` - Simplified legal MCP
- `vovkescase/` - Case management tools
