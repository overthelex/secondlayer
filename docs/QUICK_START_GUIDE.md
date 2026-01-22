# Quick Start Guide - LLM RAG MCP Chat

**Time to deploy:** ~30 minutes

---

## Prerequisites Checklist

- [ ] Node.js 20+ installed
- [ ] Docker & Docker Compose installed
- [ ] OpenAI API key obtained
- [ ] Git repository cloned

---

## 5-Minute Local Setup

### 1. Backend Setup (5 min)

```bash
# Navigate to backend
cd mcp_backend

# Install dependencies
npm install

# Create .env file
cat > .env << 'EOF'
DATABASE_URL=postgresql://secondlayer:secondlayer_password@localhost:5432/secondlayer_db
REDIS_HOST=localhost
REDIS_PORT=6379
QDRANT_URL=http://localhost:6333
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002
OPENAI_API_KEY=sk-your-key-here
SECONDARY_LAYER_KEYS=dev-key-123
HTTP_PORT=3000
EOF

# Start infrastructure
docker-compose up -d

# Wait 30 seconds for services to start
sleep 30

# Setup database
npm run db:setup

# Start backend
npm run dev:http
```

**Verify:** Visit http://localhost:3000/health (should return `{"status":"ok"}`)

### 2. Frontend Setup (3 min)

Open new terminal:

```bash
# Navigate to frontend
cd Lexwebapp

# Install dependencies
npm install

# Create .env file
cat > .env << 'EOF'
VITE_API_URL=http://localhost:3000/api
VITE_SECONDARY_LAYER_KEY=dev-key-123
EOF

# Start frontend
npm run dev
```

**Verify:** Visit http://localhost:5173 (should show chat interface)

### 3. Test the System (2 min)

```bash
# Test backend API
curl -H "Authorization: Bearer dev-key-123" \
  http://localhost:3000/api/tools

# Should return list of available MCP tools
```

**In browser:**
1. Open http://localhost:5173
2. Click "Судові рішення" in sidebar
3. Try search query: "756/655/23"
4. Should return legal precedents

---

## Production Deployment (30 min)

### Option A: Docker Compose (Easiest)

```bash
# 1. Build images
cd mcp_backend && docker build -t secondlayer-backend:prod .
cd ../Lexwebapp && docker build -t secondlayer-frontend:prod .

# 2. Create production .env
cat > .env.prod << 'EOF'
POSTGRES_PASSWORD=secure-password-here
OPENAI_API_KEY=sk-your-production-key
SECONDARY_LAYER_KEYS=prod-key-abc123,prod-key-def456
EOF

# 3. Deploy
docker-compose -f docker-compose.prod.yml --env-file .env.prod up -d

# 4. Check status
docker-compose ps
```

**Access:** http://your-server:3000 (backend) and http://your-server:80 (frontend)

### Option B: Remote Server Deployment

```bash
# 1. Build on local machine
cd Lexwebapp
docker build --platform linux/amd64 -t secondlayer-frontend:prod .

# 2. Save and transfer
docker save secondlayer-frontend:prod | gzip > frontend.tar.gz
scp frontend.tar.gz user@your-server:/tmp/

# 3. Deploy on server
ssh user@your-server << 'ENDSSH'
  gunzip -c /tmp/frontend.tar.gz | docker load
  cd /path/to/deployment
  docker-compose up -d
ENDSSH
```

---

## Common Commands

### Backend

```bash
# Start development server
npm run dev:http

# Build for production
npm run build

# Run migrations
npm run migrate

# Run tests
npm test

# View logs
docker logs -f secondlayer-app
```

### Frontend

```bash
# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

### Database

```bash
# Connect to PostgreSQL
psql postgresql://secondlayer:password@localhost:5432/secondlayer_db

# Create backup
pg_dump secondlayer_db > backup.sql

# Restore backup
psql secondlayer_db < backup.sql

# Check Qdrant collections
curl http://localhost:6333/collections
```

---

## Troubleshooting

### "Cannot connect to database"

```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Restart if needed
docker-compose restart postgres

# Verify connection
psql postgresql://secondlayer:password@localhost:5432/secondlayer_db
```

### "401 Unauthorized" errors

```bash
# 1. Check backend has keys
docker exec backend-container env | grep SECONDARY_LAYER_KEYS

# 2. Verify frontend key matches
cat Lexwebapp/.env | grep VITE_SECONDARY_LAYER_KEY

# 3. Restart services after changing keys
```

### "Qdrant not responding"

```bash
# Wait for Qdrant to start (takes 30-60 seconds)
docker logs qdrant-container

# Verify health
curl http://localhost:6333/
```

### Port already in use

```bash
# Find process using port
lsof -i :3000

# Kill process
kill -9 <PID>

# Or change port in .env
HTTP_PORT=3001
```

---

## Next Steps

1. **Read full documentation:** `docs/LLM_RAG_MCP_CHAT_IMPLEMENTATION.md`
2. **Configure models:** Adjust `OPENAI_MODEL_*` for cost optimization
3. **Add more tools:** See `mcp_backend/src/api/mcp-query-api.ts`
4. **Customize UI:** Modify components in `Lexwebapp/src/components/`
5. **Setup monitoring:** Add logging and metrics
6. **Configure SSL:** Setup nginx with Let's Encrypt

---

## Architecture Overview

```
┌─────────────┐
│   Browser   │ ← User interacts with chat
└──────┬──────┘
       │ HTTPS
┌──────▼────────┐
│  Lexwebapp    │ ← React frontend (port 5173/80)
│  (Frontend)   │
└──────┬────────┘
       │ REST/SSE
┌──────▼────────┐
│ mcp_backend   │ ← Express MCP server (port 3000)
│ (Backend)     │
└──┬──┬──┬──┬───┘
   │  │  │  │
   │  │  │  └─→ [OpenAI] GPT-4o, Embeddings
   │  │  └────→ [Qdrant] Vector search
   │  └───────→ [Redis] Cache
   └──────────→ [PostgreSQL] Documents DB
```

---

## Environment Variables Reference

### Backend (.env)

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://user:pass@localhost:5432/db` | PostgreSQL connection |
| `REDIS_HOST` | Yes | `localhost` | Redis hostname |
| `QDRANT_URL` | Yes | `http://localhost:6333` | Qdrant endpoint |
| `OPENAI_API_KEY` | Yes | `sk-proj-...` | OpenAI API key |
| `OPENAI_MODEL_QUICK` | No | `gpt-4o-mini` | Model for simple tasks |
| `OPENAI_MODEL_STANDARD` | No | `gpt-4o-mini` | Model for moderate tasks |
| `OPENAI_MODEL_DEEP` | No | `gpt-4o` | Model for complex tasks |
| `SECONDARY_LAYER_KEYS` | Yes | `key1,key2,key3` | Auth keys (comma-separated) |
| `HTTP_PORT` | No | `3000` | Server port (default: 3000) |

### Frontend (.env)

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | Yes | `http://localhost:3000/api` | Backend API endpoint |
| `VITE_SECONDARY_LAYER_KEY` | Yes | `dev-key-123` | Auth key (must match backend) |

---

## Cost Estimation

Typical costs for 1000 queries/month:

| Service | Usage | Cost |
|---------|-------|------|
| OpenAI (gpt-4o-mini) | ~1M tokens/month | $0.15 |
| OpenAI (gpt-4o) | ~200K tokens/month | $0.50 |
| OpenAI Embeddings | ~500K tokens/month | $0.05 |
| Zakononline API | ~500 calls/month | $3.57 |
| Infrastructure | 4GB RAM VPS | $10-20 |
| **Total** | | **~$15-25/month** |

**Optimization tips:**
- Use `gpt-4o-mini` for 90% of queries
- Cache common searches in Redis
- Batch process documents off-peak

---

## Support

- **Full documentation:** `docs/LLM_RAG_MCP_CHAT_IMPLEMENTATION.md`
- **Issues:** GitHub Issues
- **Questions:** GitHub Discussions

---

**Ready in:** ~30 minutes
**Updated:** 2026-01-21
