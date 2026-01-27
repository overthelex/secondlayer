# Local Development Guide

Quick start guide for running SecondLayer on your local development machine.

## Overview

The local environment is optimized for developer productivity with:
- **Standard ports**: PostgreSQL (5432), Redis (6379), Backend (3000), Frontend (5173)
- **Hot reload**: Frontend runs with Vite dev server for instant updates
- **Simplified config**: Minimal setup, sensible defaults
- **No gateway**: Direct access to services, no nginx proxy needed
- **Debug mode**: Verbose logging for troubleshooting

## Quick Start (5 minutes)

### 1. Prerequisites

```bash
# Check you have Docker installed
docker --version
docker compose version

# Check Node.js version (20+ required)
node --version
npm --version
```

### 2. Configure Environment

```bash
cd deployment

# Copy environment template
cp .env.local.example .env.local

# Edit and add your API keys (REQUIRED)
nano .env.local  # or use your favorite editor
```

**Minimum required configuration:**
- `OPENAI_API_KEY` - Your OpenAI API key
- `ZAKONONLINE_API_TOKEN` - Your ZakonOnline API token

### 3. Start Services

```bash
# Start all backend services (PostgreSQL, Redis, Qdrant, Backend API)
./manage-gateway.sh start local

# Wait ~30 seconds for services to initialize
# Check status
./manage-gateway.sh status
```

### 4. Start Frontend (separate terminal)

```bash
cd frontend

# Install dependencies (first time only)
npm install

# Start Vite dev server with hot reload
npm run dev
```

### 5. Access Application

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3000
- **Health Check**: http://localhost:3000/health
- **PostgreSQL**: localhost:5432
- **Redis**: localhost:6379
- **Qdrant**: http://localhost:6333

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Local Development Environment                          │
└─────────────────────────────────────────────────────────┘

Frontend (Vite Dev Server)          Backend Services (Docker)
┌──────────────────────┐            ┌────────────────────────┐
│  http://localhost:5173│            │ secondlayer-app-local  │
│  React + Hot Reload  │◄───────────│ http://localhost:3000  │
└──────────────────────┘   API      └────────────────────────┘
                           Calls              │
                                              ├─► PostgreSQL (5432)
                                              ├─► Redis (6379)
                                              └─► Qdrant (6333)
```

## Port Reference

| Service | Port | Container Name | URL |
|---------|------|----------------|-----|
| Frontend (Dev) | 5173 | (host process) | http://localhost:5173 |
| Backend API | 3000 | secondlayer-app-local | http://localhost:3000 |
| PostgreSQL | 5432 | secondlayer-postgres-local | postgresql://localhost:5432 |
| Redis | 6379 | secondlayer-redis-local | redis://localhost:6379 |
| Qdrant HTTP | 6333 | secondlayer-qdrant-local | http://localhost:6333 |
| Qdrant gRPC | 6334 | secondlayer-qdrant-local | - |

## Common Commands

### Environment Management

```bash
cd deployment

# Start local environment
./manage-gateway.sh start local

# Stop local environment
./manage-gateway.sh stop local

# Restart local environment
./manage-gateway.sh restart local

# View logs (all services)
./manage-gateway.sh logs local

# View specific service logs
docker logs -f secondlayer-app-local      # Backend
docker logs -f secondlayer-postgres-local # Database
docker logs -f secondlayer-redis-local    # Cache
docker logs -f secondlayer-qdrant-local   # Vector DB

# Check status
./manage-gateway.sh status

# Health check
curl http://localhost:3000/health
```

### Database Operations

```bash
# Connect to PostgreSQL
PGPASSWORD=local_dev_password psql -h localhost -U secondlayer -d secondlayer_local

# Run migrations (if needed)
cd ../mcp_backend
npm run migrate

# View tables
docker exec -it secondlayer-postgres-local psql -U secondlayer -d secondlayer_local -c "\dt"
```

### Frontend Development

```bash
cd frontend

# Start dev server (hot reload)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint
npm run lint

# Type check
npm run type-check
```

### Backend Development

```bash
cd mcp_backend

# Build TypeScript
npm run build

# Run in dev mode (with nodemon)
npm run dev:http

# Run tests
npm test

# Run tests in watch mode
npm test:watch

# Lint
npm run lint
```

## Environment Variables

### Essential Configuration

Copy `.env.local.example` to `.env.local` and configure:

```bash
# OpenAI API (REQUIRED)
OPENAI_API_KEY=sk-proj-your-key-here
OPENAI_API_KEY2=sk-proj-fallback-key  # Optional

# ZakonOnline API (REQUIRED)
ZAKONONLINE_API_TOKEN=your-token-here
ZAKONONLINE_API_TOKEN2=fallback-token  # Optional

# Database (has sensible defaults)
POSTGRES_PASSWORD=local_dev_password_CHANGE_ME

# JWT Secret (has default, change for security)
JWT_SECRET=your-64-char-secret-here
```

### Optional Configuration

```bash
# Anthropic/Claude (for multi-provider support)
ANTHROPIC_API_KEY=sk-ant-your-key-here
LLM_PROVIDER_STRATEGY=openai-first  # or anthropic-first

# Google OAuth (optional for local dev)
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

# Model selection (cost optimization)
OPENAI_MODEL_QUICK=gpt-4o-mini       # $0.15/1M tokens
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o             # $2.50/1M tokens
```

## Development Workflow

### Making Changes to Backend

1. **Edit code** in `mcp_backend/src/`
2. **Build TypeScript**: `cd mcp_backend && npm run build`
3. **Restart container**: `cd ../deployment && ./manage-gateway.sh restart local`
4. **View logs**: `./manage-gateway.sh logs local`

### Making Changes to Frontend

1. **Edit code** in `frontend/src/`
2. **Hot reload**: Vite automatically reloads (no manual restart needed)
3. **View in browser**: http://localhost:5173

### Database Changes

1. **Create migration** in `mcp_backend/src/migrations/NNN_description.sql`
2. **Run migration**: `cd mcp_backend && npm run migrate`
3. **Restart backend**: `cd ../deployment && ./manage-gateway.sh restart local`

## Troubleshooting

### Port Already in Use

```bash
# Check what's using a port
lsof -i :3000   # Backend
lsof -i :5432   # PostgreSQL
lsof -i :6379   # Redis
lsof -i :6333   # Qdrant

# Kill process on port
kill -9 $(lsof -t -i:3000)
```

### Services Not Starting

```bash
# View detailed logs
docker logs secondlayer-app-local

# Check if containers are running
docker ps | grep secondlayer-.*-local

# Check if services are healthy
docker ps --format "table {{.Names}}\t{{.Status}}"

# Restart specific service
docker restart secondlayer-app-local
```

### Database Connection Issues

```bash
# Check if PostgreSQL is ready
docker exec secondlayer-postgres-local pg_isready -U secondlayer

# View PostgreSQL logs
docker logs secondlayer-postgres-local

# Reset database (WARNING: deletes all data)
./manage-gateway.sh stop local
docker volume rm deployment_postgres_local_data
./manage-gateway.sh start local
```

### Frontend 401 Errors

**Problem**: API calls return 401 Unauthorized

**Solution 1**: Check API key configuration
```bash
# In frontend/.env
VITE_SECONDARY_LAYER_KEY=local-dev-key

# In deployment/.env.local
SECONDARY_LAYER_KEYS=local-dev-key,test-key-123
```

**Solution 2**: Verify backend is running
```bash
curl http://localhost:3000/health
```

**Solution 3**: Check CORS settings in `.env.local`
```bash
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
```

### Qdrant Not Ready

**Problem**: "Qdrant is not ready" errors

**Solution**: Qdrant takes ~20-30s to start
```bash
# Wait for Qdrant to be ready
curl http://localhost:6333/

# If it times out, check logs
docker logs secondlayer-qdrant-local

# Restart Qdrant
docker restart secondlayer-qdrant-local
```

### Hot Reload Not Working (Frontend)

```bash
# Clear Vite cache
cd frontend
rm -rf node_modules/.vite

# Reinstall dependencies
npm install

# Restart dev server
npm run dev
```

## Clean Slate Reset

If you want to start fresh with a clean environment:

```bash
cd deployment

# Stop all local services
./manage-gateway.sh stop local

# Remove all local volumes (WARNING: deletes all data!)
docker volume rm deployment_postgres_local_data
docker volume rm deployment_redis_local_data
docker volume rm deployment_qdrant_local_data
docker volume rm deployment_app_local_data

# Start fresh
./manage-gateway.sh start local
```

## Best Practices

### 1. Keep Frontend Running with Hot Reload

- Run frontend with `npm run dev` (not in Docker) for instant updates
- Docker is only for backend services (PostgreSQL, Redis, Qdrant, API)

### 2. Use Different Databases per Environment

- Local: `secondlayer_local`
- Dev: `secondlayer_dev`
- Stage: `secondlayer_stage`
- Prod: `secondlayer_db`

### 3. Use Cost-Optimized Models

Default configuration uses `gpt-4o-mini` for most tasks to save costs:
- Quick tasks: `gpt-4o-mini` ($0.15/1M tokens)
- Standard tasks: `gpt-4o-mini`
- Deep analysis: `gpt-4o` ($2.50/1M tokens)

### 4. Don't Commit Secrets

Never commit these files:
- `.env.local`
- `.env.prod`
- `.env.stage`
- `.env.dev`

They are already in `.gitignore`.

### 5. Use API Keys for Local Auth

For local development, skip OAuth and use API keys:
```bash
# In deployment/.env.local
SECONDARY_LAYER_KEYS=local-dev-key

# In frontend/.env
VITE_SECONDARY_LAYER_KEY=local-dev-key
```

## Switching to Other Environments

### From Local to Dev/Stage/Prod

```bash
# Stop local
./manage-gateway.sh stop local

# Start gateway environments (requires gate server access)
./manage-gateway.sh start dev    # Development on gate server
./manage-gateway.sh start stage  # Staging on gate server
./manage-gateway.sh start prod   # Production on gate server

# Or start all gateway environments
./manage-gateway.sh start all
./manage-gateway.sh gateway start
```

### Environment Comparison

| Feature | Local | Dev | Stage | Prod |
|---------|-------|-----|-------|------|
| **Location** | Your machine | Gate server | Gate server | Gate server |
| **Port** | 3000 | 3003 | 3002 | 3001 |
| **URL** | localhost:3000 | legal.org.ua/development | legal.org.ua/staging | legal.org.ua |
| **Gateway** | No | Yes | Yes | Yes |
| **Hot Reload** | Yes (frontend) | No | No | No |
| **OAuth** | Optional | Yes | Yes | Yes |
| **Database** | secondlayer_local | secondlayer_dev | secondlayer_stage | secondlayer_db |

## Next Steps

After setting up local environment:

1. **Explore the codebase**
   - Backend: `mcp_backend/src/`
   - Frontend: `frontend/src/`
   - Documentation: `docs/`

2. **Try MCP tools**
   - See `docs/MCP_TOOLS_LIST.md` for available tools
   - Test with: `curl -X POST http://localhost:3000/api/tools/get_legal_advice -H "Authorization: Bearer local-dev-key" -H "Content-Type: application/json" -d '{"query":"test"}'`

3. **Read architecture docs**
   - `CLAUDE.md` - Project overview
   - `deployment/ARCHITECTURE.md` - System architecture
   - `docs/MODEL_SELECTION_GUIDE.md` - LLM model selection

4. **Deploy to gateway environments**
   - `deployment/QUICK_START.md` - 5-minute deployment guide
   - `deployment/GATEWAY_SETUP.md` - Complete setup guide

## Support

**Documentation**:
- This guide: `deployment/LOCAL_DEVELOPMENT.md`
- Quick start: `deployment/QUICK_START.md`
- Full guide: `deployment/GATEWAY_SETUP.md`

**Common Issues**:
- Port conflicts: See "Port Already in Use" above
- Database issues: See "Database Connection Issues" above
- Frontend errors: See "Frontend 401 Errors" above

**Check logs**:
```bash
# All services
./manage-gateway.sh logs local

# Specific service
docker logs -f secondlayer-app-local
```

---

**Happy coding! 🚀**
