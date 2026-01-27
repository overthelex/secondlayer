# LLM RAG MCP Chat Implementation Guide

**Date:** 2026-01-21
**Version:** 1.0
**Stack:** React + TypeScript + MCP Server + OpenAI + Qdrant + PostgreSQL

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Backend Setup (MCP Server)](#backend-setup-mcp-server)
4. [Frontend Setup (Chat Interface)](#frontend-setup-chat-interface)
5. [Integration Flow](#integration-flow)
6. [Deployment](#deployment)
7. [Usage Examples](#usage-examples)
8. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

The system implements a **Model Context Protocol (MCP)** based chat interface with **Retrieval-Augmented Generation (RAG)** capabilities for legal document analysis.

```
┌─────────────────────────────────────────────────────────────┐
│                     User Interface                          │
│  Lexwebapp/ (React + TypeScript + Ant Design)              │
│  - Chat interface with streaming support                    │
│  - Tool execution UI                                        │
│  - Document viewer                                          │
└────────────────┬────────────────────────────────────────────┘
                 │ HTTPS/REST API
                 │ SSE Streaming
┌────────────────▼────────────────────────────────────────────┐
│              MCP HTTP Server                                │
│  mcp_backend/ (Node.js + Express + TypeScript)             │
│  - Tool execution engine                                    │
│  - Query planning & classification                          │
│  - Hallucination detection                                  │
└─────┬──────┬──────┬──────┬──────┬────────────────┬─────────┘
      │      │      │      │      │                │
      │      │      │      │      │                │
┌─────▼──┐ ┌─▼────┐ ┌─▼───┐ ┌─▼──┐ ┌─────▼─────┐ ┌──▼─────┐
│OpenAI  │ │Qdrant│ │Redis│ │PG  │ │Zakononline│ │  Other │
│GPT-4o  │ │Vector│ │Cache│ │DB  │ │Legal API  │ │  APIs  │
│Embed   │ │Search│ │      │     │ │           │ │        │
└────────┘ └──────┘ └─────┘ └────┘ └───────────┘ └────────┘
```

### Key Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Frontend** | React 18 + TypeScript + Vite | User interface for chat and tool execution |
| **MCP Server** | Node.js 20 + Express + TypeScript | Backend API and MCP tool orchestration |
| **Vector DB** | Qdrant | Semantic search over document embeddings |
| **Database** | PostgreSQL 15 | Document metadata and structured data |
| **Cache** | Redis 7 | API response caching |
| **LLM** | OpenAI GPT-4o / GPT-4o-mini | Text generation and analysis |
| **Embeddings** | OpenAI text-embedding-ada-002 | Document vectorization |

---

## Prerequisites

### Development Environment

```bash
# Required software
Node.js >= 20.x
npm >= 10.x
Docker >= 24.x
Docker Compose >= 2.x
PostgreSQL 15+
Redis 7+
```

### API Keys

You'll need the following API keys:

1. **OpenAI API Key** - For GPT and embeddings
   - Get from: https://platform.openai.com/api-keys
   - Supports key rotation (OPENAI_API_KEY, OPENAI_API_KEY2)

2. **Zakononline API Token** (or your legal data source)
   - For Ukrainian court decisions
   - Supports token rotation

3. **Secondary Layer Keys** - For frontend-backend authentication
   - Generate: `openssl rand -hex 32`

### System Requirements

- **Development:** 8GB RAM, 4 cores, 20GB disk
- **Production:** 16GB RAM, 8 cores, 100GB disk

---

## Backend Setup (MCP Server)

### 1. Clone and Install

```bash
cd /path/to/your/project
git clone <your-repo>
cd SecondLayer/mcp_backend

# Install dependencies
npm install
```

### 2. Environment Configuration

Create `mcp_backend/.env`:

```bash
# Database
DATABASE_URL=postgresql://secondlayer:secondlayer_password@localhost:5432/secondlayer_db

# Redis Cache
REDIS_HOST=localhost
REDIS_PORT=6379

# Qdrant Vector Database
QDRANT_URL=http://localhost:6333

# OpenAI - Dynamic Model Selection (RECOMMENDED)
# Use different models based on task complexity for cost optimization
OPENAI_MODEL_QUICK=gpt-4o-mini       # Simple tasks ($0.15/1M tokens)
OPENAI_MODEL_STANDARD=gpt-4o-mini    # Moderate tasks ($0.15/1M tokens)
OPENAI_MODEL_DEEP=gpt-4o             # Complex tasks ($2.50/1M tokens)

# Embedding model (MUST stay consistent once you have vectors in DB!)
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002

# API Keys (supports rotation)
OPENAI_API_KEY=sk-proj-your-key-here
OPENAI_API_KEY2=sk-proj-your-backup-key  # Optional fallback

# Legal Data Source API
ZAKONONLINE_API_TOKEN=your-token-here
ZAKONONLINE_API_TOKEN2=your-token-2      # Optional fallback

# HTTP Server Security
SECONDARY_LAYER_KEYS=key1-abc123,key2-def456,key3-ghi789
HTTP_PORT=3000
HTTP_HOST=0.0.0.0

# Optional: Logging
LOG_LEVEL=info
NODE_ENV=development
```

### 3. Database Setup

```bash
# Create database and run migrations
npm run db:setup

# Or manually:
createdb secondlayer_db
npm run migrate
```

**Database Schema:**
- `documents` - Legal document metadata
- `document_sections` - Extracted sections (facts, reasoning, decisions)
- `patterns` - Legal reasoning patterns
- `queries` - User query history
- `migrations` - Schema version tracking

### 4. Start Infrastructure with Docker

```bash
cd mcp_backend

# Start PostgreSQL, Redis, Qdrant
docker-compose up -d

# Verify services
docker-compose ps

# Check Qdrant
curl http://localhost:6333/
# Should return: {"title":"qdrant - vector search engine","version":"..."}

# Check Redis
redis-cli ping
# Should return: PONG
```

### 5. Start MCP Server

```bash
# Development mode with hot reload
npm run dev:http

# Production mode
npm run build
npm start
```

**Server endpoints:**
- `http://localhost:3000/health` - Health check (no auth)
- `http://localhost:3000/api/tools` - List available MCP tools
- `http://localhost:3000/api/tools/:toolName` - Execute tool

### 6. Verify Backend

```bash
# Health check
curl http://localhost:3000/health

# List tools (requires auth)
curl -H "Authorization: Bearer key1-abc123" \
  http://localhost:3000/api/tools

# Execute tool
curl -X POST \
  -H "Authorization: Bearer key1-abc123" \
  -H "Content-Type: application/json" \
  -d '{"query":"test query","max_results":5}' \
  http://localhost:3000/api/tools/search_legal_precedents
```

---

## Frontend Setup (Chat Interface)

### 1. Navigate to Frontend

```bash
cd /path/to/SecondLayer/Lexwebapp
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Configuration

Create `Lexwebapp/.env`:

```bash
# Backend API endpoint
VITE_API_URL=http://localhost:3000/api

# Authentication key (must match backend SECONDARY_LAYER_KEYS)
VITE_SECONDARY_LAYER_KEY=key1-abc123

# Optional: Feature flags
VITE_ENABLE_STREAMING=true
VITE_ENABLE_TOOLS=true
```

### 4. Key Frontend Components

#### **ChatLayout.tsx** - Main Layout
```typescript
// Location: Lexwebapp/src/components/ChatLayout.tsx
// Manages view state, sidebar, chat messages, tool execution
```

#### **Sidebar.tsx** - Navigation Menu
```typescript
// Location: Lexwebapp/src/components/Sidebar.tsx
// Menu items, user profile, tool navigation
```

#### **DecisionsSearchPage.tsx** - Court Precedents Search
```typescript
// Location: Lexwebapp/src/components/DecisionsSearchPage.tsx
// Search interface for legal precedents
```

#### **API Client** - Backend Communication
```typescript
// Location: Lexwebapp/src/services/api-client.ts

class APIClient {
  // List all available MCP tools
  async listTools(): Promise<{ tools: MCPTool[]; count: number }> {
    return this.request('/api/tools');
  }

  // Execute specific MCP tool
  async executeTool<T = any>(
    toolName: string,
    params: any
  ): Promise<ToolResponse<T>> {
    return this.request(`/api/tools/${toolName}`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  // Execute with SSE streaming
  executeToolStream(
    toolName: string,
    params: any,
    onMessage: (event: StreamEvent) => void
  ): EventSource {
    const url = `${this.baseUrl}/api/tools/${toolName}/stream`;
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      onMessage(data);
    };

    return eventSource;
  }
}

export const apiClient = new APIClient();
```

### 5. Start Frontend Development Server

```bash
npm run dev
```

**Access at:** http://localhost:5173

### 6. Build for Production

```bash
npm run build
# Output: dist/ folder

# Preview production build
npm run preview
```

---

## Integration Flow

### 1. User Query Flow

```
User types query in chat
         ↓
Frontend sends to /api/tools/get_legal_advice
         ↓
Backend receives request
         ↓
Query Planner classifies intent (OpenAI)
         ↓
Semantic search in Qdrant (if needed)
         ↓
RAG: Retrieve relevant documents
         ↓
LLM generates response (OpenAI GPT-4o)
         ↓
Hallucination Guard validates against sources
         ↓
Response streamed back via SSE
         ↓
Frontend displays with citations
```

### 2. Tool Execution Example

**Frontend:**
```typescript
import { apiClient } from './services/api-client';

// Execute search tool
const response = await apiClient.executeTool('search_legal_precedents', {
  query: 'позовна давність',
  max_results: 10,
  reasoning_budget: 'standard'
});

console.log(response.data.similar_cases);
```

**Backend Processing:**
```typescript
// mcp_backend/src/api/mcp-query-api.ts

async handleSearchLegalPrecedents(params: any) {
  // 1. Parse query
  const terms = await this.queryPlanner.extractSearchTerms(params.query);

  // 2. Semantic search
  const vectors = await this.embeddingService.embed(terms);
  const similar = await this.qdrant.search(vectors, params.max_results);

  // 3. Enrich results
  const cases = await this.enrichWithMetadata(similar);

  return { similar_cases: cases };
}
```

### 3. Streaming Implementation

**Frontend:**
```typescript
// Subscribe to SSE stream
const eventSource = apiClient.executeToolStream(
  'get_legal_advice',
  { query: 'my question', stream: true },
  (event) => {
    if (event.type === 'progress') {
      updateProgress(event.data.message);
    } else if (event.type === 'result') {
      displayResult(event.data);
    }
  }
);

// Cleanup
eventSource.close();
```

**Backend:**
```typescript
// SSE streaming endpoint
app.post('/api/tools/:toolName/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const callback = (event: StreamEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  await mcpApi.executeToolWithStream(toolName, params, callback);
  res.end();
});
```

---

## Deployment

### Development Environment

**Backend:**
```bash
cd mcp_backend
docker-compose up -d           # Start infrastructure
npm run dev:http               # Start backend with hot reload
```

**Frontend:**
```bash
cd Lexwebapp
npm run dev                    # Start Vite dev server
```

### Production with Docker

**1. Build Docker Images:**

```bash
# Backend
cd mcp_backend
docker build -t secondlayer-backend:prod .

# Frontend
cd ../Lexwebapp
docker build -f Dockerfile -t secondlayer-frontend:prod .
```

**2. Docker Compose Production:**

Create `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: secondlayer_db
      POSTGRES_USER: secondlayer
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - backend

  redis:
    image: redis:7-alpine
    networks:
      - backend

  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - qdrant_data:/qdrant/storage
    networks:
      - backend

  backend:
    image: secondlayer-backend:prod
    environment:
      DATABASE_URL: postgresql://secondlayer:${POSTGRES_PASSWORD}@postgres:5432/secondlayer_db
      REDIS_HOST: redis
      QDRANT_URL: http://qdrant:6333
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      SECONDARY_LAYER_KEYS: ${SECONDARY_LAYER_KEYS}
    depends_on:
      - postgres
      - redis
      - qdrant
    networks:
      - backend
      - frontend
    ports:
      - "3000:3000"

  frontend:
    image: secondlayer-frontend:prod
    environment:
      VITE_API_URL: http://backend:3000/api
    depends_on:
      - backend
    networks:
      - frontend
    ports:
      - "80:80"

networks:
  backend:
  frontend:

volumes:
  postgres_data:
  qdrant_data:
```

**3. Deploy:**

```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Production on Remote Server

**Transfer and Deploy:**

```bash
# Build locally
docker build --platform linux/amd64 -t secondlayer-frontend:prod .
docker save secondlayer-frontend:prod | gzip > frontend.tar.gz

# Transfer to server
scp frontend.tar.gz user@server:/tmp/

# Load and run on server
ssh user@server "gunzip -c /tmp/frontend.tar.gz | docker load"
ssh user@server "cd /path/to/deployment && docker-compose up -d"
```

**Nginx Reverse Proxy:**

```nginx
# /etc/nginx/sites-available/secondlayer

server {
    listen 80;
    server_name yourdomain.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Frontend
    location / {
        proxy_pass http://localhost:8091;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Backend API
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE streaming support
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        chunked_transfer_encoding off;
    }
}
```

---

## Usage Examples

### 1. Search Legal Precedents

```typescript
// Frontend implementation
const searchPrecedents = async (caseNumber: string) => {
  const response = await apiClient.executeTool('search_legal_precedents', {
    query: caseNumber,
    source_case_number: caseNumber,
    max_results: 20,
    reasoning_budget: 'standard'
  });

  return response.data.similar_cases;
};

// Usage
const cases = await searchPrecedents('756/655/23');
console.log(`Found ${cases.length} similar cases`);
```

### 2. Analyze Case Pattern

```typescript
const analyzePattern = async (topic: string) => {
  const response = await apiClient.executeTool('analyze_case_pattern', {
    topic: 'трудові спори',
    date_from: '2024-01-01',
    date_to: '2024-12-31',
    max_cases: 50
  });

  return response.data.pattern_analysis;
};
```

### 3. Get Legal Advice with Streaming

```typescript
const getLegalAdvice = (query: string) => {
  const eventSource = apiClient.executeToolStream(
    'get_legal_advice',
    {
      query: query,
      context: 'Контекст справи...',
      stream: true
    },
    (event) => {
      switch (event.type) {
        case 'progress':
          console.log('Progress:', event.data.message);
          break;
        case 'thinking':
          console.log('Thinking:', event.data.step);
          break;
        case 'result':
          console.log('Result:', event.data);
          eventSource.close();
          break;
        case 'error':
          console.error('Error:', event.data);
          eventSource.close();
          break;
      }
    }
  );

  return eventSource;
};
```

### 4. Extract Document Sections

```typescript
const extractSections = async (documentId: string) => {
  const response = await apiClient.executeTool('extract_document_sections', {
    document_id: documentId,
    section_types: ['FACTS', 'REASONING', 'DECISION']
  });

  return response.data.sections;
};
```

---

## Troubleshooting

### Common Issues

#### 1. Backend Won't Start

**Error:** `Cannot connect to database`

**Solution:**
```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Check connection
psql postgresql://secondlayer:password@localhost:5432/secondlayer_db

# Recreate database
dropdb secondlayer_db
createdb secondlayer_db
npm run migrate
```

#### 2. Qdrant Unhealthy

**Error:** `Connection refused to Qdrant`

**Solution:**
```bash
# Qdrant takes 30-60s to start
docker logs qdrant-container

# Verify
curl http://localhost:6333/

# Restart if needed
docker restart qdrant-container
```

#### 3. Frontend 401 Unauthorized

**Error:** `Unauthorized` on API calls

**Solution:**
```bash
# 1. Check backend has SECONDARY_LAYER_KEYS set
docker exec backend-container env | grep SECONDARY_LAYER_KEYS

# 2. Check frontend VITE_SECONDARY_LAYER_KEY matches
cat Lexwebapp/.env | grep VITE_SECONDARY_LAYER_KEY

# 3. Keys must match exactly
```

#### 4. OpenAI Rate Limits

**Error:** `Rate limit exceeded`

**Solution:**
- Add second API key: `OPENAI_API_KEY2`
- Backend automatically rotates on 429 errors
- Use cheaper model for simple tasks: `OPENAI_MODEL_QUICK=gpt-4o-mini`

#### 5. Slow Searches

**Issue:** Semantic searches take >10 seconds

**Solutions:**
```bash
# 1. Check Qdrant collection size
curl http://localhost:6333/collections/legal_sections

# 2. Add indexes if missing
# 3. Reduce max_results parameter
# 4. Use 'quick' reasoning_budget for simple queries
```

#### 6. Memory Issues

**Error:** `JavaScript heap out of memory`

**Solution:**
```bash
# Increase Node.js memory
NODE_OPTIONS="--max-old-space-size=4096" npm run dev:http

# Or in package.json:
"scripts": {
  "start": "node --max-old-space-size=4096 dist/http-server.js"
}
```

### Debug Mode

**Backend:**
```bash
# Enable debug logging
LOG_LEVEL=debug npm run dev:http

# Trace API calls
DEBUG=express:* npm run dev:http
```

**Frontend:**
```bash
# Enable React DevTools
# Install browser extension
# Open Console -> Components tab
```

### Health Checks

```bash
# Backend
curl http://localhost:3000/health

# PostgreSQL
pg_isready -h localhost -p 5432

# Redis
redis-cli ping

# Qdrant
curl http://localhost:6333/healthz
```

---

## Performance Optimization

### 1. Caching Strategy

```typescript
// Enable Redis caching for expensive operations
const result = await cache.wrap(
  `search:${query}:${maxResults}`,
  () => performExpensiveSearch(query, maxResults),
  { ttl: 3600 } // 1 hour
);
```

### 2. Model Selection

```bash
# Use appropriate models for cost vs quality
OPENAI_MODEL_QUICK=gpt-4o-mini        # $0.15/1M tokens - keyword extraction
OPENAI_MODEL_STANDARD=gpt-4o-mini     # $0.15/1M tokens - classification
OPENAI_MODEL_DEEP=gpt-4o              # $2.50/1M tokens - deep analysis
```

### 3. Batch Processing

```bash
# Process multiple documents in parallel
cd mcp_backend
node scripts/batch-process.sh /path/to/documents
```

### 4. Database Indexes

```sql
-- Add indexes for common queries
CREATE INDEX idx_documents_date ON documents(adjudication_date DESC);
CREATE INDEX idx_documents_court ON documents(court_code);
CREATE INDEX idx_sections_type ON document_sections(section_type);
```

---

## Security Best Practices

### 1. API Key Management

```bash
# Never commit .env files
echo ".env" >> .gitignore

# Use environment variables in production
export OPENAI_API_KEY="sk-..."

# Rotate keys regularly
# Use separate keys for dev/staging/prod
```

### 2. Rate Limiting

```typescript
// Add rate limiting to endpoints
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use('/api/', limiter);
```

### 3. Input Validation

```typescript
// Validate all user inputs
import Joi from 'joi';

const schema = Joi.object({
  query: Joi.string().min(1).max(1000).required(),
  max_results: Joi.number().min(1).max(100).default(10)
});

const { value, error } = schema.validate(req.body);
```

---

## Cost Tracking

The system includes built-in cost tracking:

```typescript
// Response includes cost breakdown
{
  "data": { ... },
  "cost_tracking": {
    "openai": {
      "total_cost_usd": 0.009485,
      "total_tokens": 1505
    },
    "zakononline": {
      "total_calls": 2,
      "total_cost_usd": 0.01428
    },
    "totals": {
      "cost_usd": 0.023765,
      "execution_time_ms": 29062
    }
  }
}
```

Monitor costs with:
```bash
# Query cost history
SELECT
  DATE(created_at) as date,
  SUM(cost_usd) as daily_cost
FROM queries
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

---

## Further Resources

- **MCP Documentation:** https://spec.modelcontextprotocol.io/
- **OpenAI API:** https://platform.openai.com/docs
- **Qdrant Docs:** https://qdrant.tech/documentation/
- **React Best Practices:** https://react.dev/learn
- **TypeScript Handbook:** https://www.typescriptlang.org/docs/

---

## Support & Contributing

- **Issues:** Open issues on GitHub repository
- **Discussions:** Use GitHub Discussions for questions
- **Pull Requests:** Contributions welcome!

---

**Last Updated:** 2026-01-21
**Version:** 1.0
**License:** MIT
