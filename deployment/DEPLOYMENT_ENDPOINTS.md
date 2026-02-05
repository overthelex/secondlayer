# Deployment Endpoints - SecondLayer MCP Servers

## Deployment Target Servers

| Environment | Server | IP/Domain |
|-------------|--------|-----------|
| **Local** | localhost | 127.0.0.1 |
| **Dev** | gate.lexapp.co.ua | Gate Server |
| **Stage** | mail.lexapp.co.ua | Mail Server |
| **Prod** | mail.lexapp.co.ua | Mail Server |

---

## Local Environment (localhost)

**Deployment:** Runs locally via `docker-compose.local.yml`
**Access:** http://localhost

### MCP Backend (`secondlayer-app-local`)
- **Port:** 3000
- **HTTP API:** http://localhost:3000/api/tools
- **Health:** http://localhost:3000/health
- **MCP SSE:** http://localhost:3000/sse
- **MCP Discovery:** http://localhost:3000/mcp

### Frontend (`lexwebapp-local`)
- **Port:** 8080
- **URL:** http://localhost:8080

### Infrastructure
- **PostgreSQL:** localhost:5432
- **Redis:** localhost:6379
- **Qdrant:** localhost:6333

---

## Dev Environment (gate.lexapp.co.ua)

**Deployment:** `./manage-gateway.sh deploy dev` → gate.lexapp.co.ua
**Access:** https://dev.legal.org.ua

### MCP Backend (`secondlayer-app-dev`)
- **Port:** 3003 (internal)
- **HTTP API:** https://dev.legal.org.ua/api/tools
- **Health:** https://dev.legal.org.ua/health
- **MCP SSE (ChatGPT):** https://dev.legal.org.ua/sse
- **MCP SSE (Standard):** https://dev.legal.org.ua/v1/sse
- **MCP Discovery:** https://dev.legal.org.ua/mcp
- **Webhooks:**
  - Stripe: https://dev.legal.org.ua/webhooks/stripe
  - Fondy: https://dev.legal.org.ua/webhooks/fondy

### OpenReyestr MCP (`app-openreyestr-dev`)
- **Port:** 3005 (internal)
- **HTTP API:** https://dev.legal.org.ua:3005/api/tools
- **Health:** https://dev.legal.org.ua:3005/health

### Frontend (`lexwebapp-dev`)
- **Port:** 8091 (internal)
- **URL:** https://dev.legal.org.ua

### Infrastructure
- **PostgreSQL (backend):** gate.lexapp.co.ua:5433
- **PostgreSQL (openreyestr):** gate.lexapp.co.ua:5437
- **Redis:** gate.lexapp.co.ua:6380
- **Qdrant:** gate.lexapp.co.ua:6335-6336

---

## Stage Environment (mail.lexapp.co.ua)

**Deployment:** `./manage-gateway.sh deploy stage` → mail.lexapp.co.ua
**Access:** https://stage.legal.org.ua

### MCP Backend (`secondlayer-app-stage`)
- **Port:** 3004 (internal)
- **HTTP API:** https://stage.legal.org.ua/api/tools
- **Health:** https://stage.legal.org.ua/health
- **MCP SSE (ChatGPT):** https://stage.legal.org.ua/sse
- **MCP SSE (Standard):** https://stage.legal.org.ua/v1/sse
- **MCP Discovery:** https://stage.legal.org.ua/mcp
- **Webhooks:**
  - Stripe: https://stage.legal.org.ua/webhooks/stripe
  - Fondy: https://stage.legal.org.ua/webhooks/fondy

### Frontend (`lexwebapp-stage`)
- **Port:** 8092 (internal)
- **URL:** https://stage.legal.org.ua

### Infrastructure
- **PostgreSQL:** mail.lexapp.co.ua:5434
- **Redis:** mail.lexapp.co.ua:6381
- **Qdrant:** mail.lexapp.co.ua:6337-6338

---

## Prod Environment (mail.lexapp.co.ua)

**Deployment:** `./manage-gateway.sh deploy prod` → mail.lexapp.co.ua
**Access:** https://legal.org.ua

### MCP Backend (`secondlayer-app-prod`)
- **Port:** 3001 (internal)
- **HTTP API:** https://legal.org.ua/api/tools
- **Health:** https://legal.org.ua/health
- **MCP SSE (ChatGPT):** https://legal.org.ua/sse
- **MCP SSE (Standard):** https://legal.org.ua/v1/sse
- **MCP Discovery:** https://legal.org.ua/mcp
- **Webhooks:**
  - Stripe: https://legal.org.ua/webhooks/stripe
  - Fondy: https://legal.org.ua/webhooks/fondy

### Frontend (`lexwebapp-prod`)
- **Port:** 8090 (internal)
- **URL:** https://legal.org.ua

### Infrastructure
- **PostgreSQL:** mail.lexapp.co.ua:5432
- **Redis:** mail.lexapp.co.ua:6379
- **Qdrant:** mail.lexapp.co.ua:6333-6334

---

## MCP Tools Available on All Environments

### mcp_backend (Court Cases & Legal Analysis)
All environments expose 34 tools via HTTP and SSE:

**Search & Discovery:**
- `search_court_cases` - Search ZakonOnline database
- `semantic_search` - Vector similarity search
- `search_legislation` - Search laws and codes
- `classify_intent` - Query classification

**Document Operations:**
- `get_document_text` - Retrieve full court decision
- `get_legislation_section` - Get specific article/section
- `extract_text_from_pdf` - PDF parsing
- `split_document_to_chunks` - Document sectioning

**Analysis:**
- `analyze_legal_document` - AI-powered document analysis
- `find_legal_patterns` - Pattern matching
- `validate_citations` - Citation verification
- `packaged_lawyer_answer` - Complete legal analysis workflow

**And 22 more tools...** (see `/docs/ALL_MCP_TOOLS.md`)

### mcp_openreyestr (State Register - Dev Only)
Available only on **Dev environment**:

- `search_by_edrpou` - Search by business ID
- `search_by_name` - Search by entity name
- `get_entity_beneficiaries` - Get beneficial owners
- `search_fop` - Search individual entrepreneurs
- `get_entity_details` - Get full entity information

---

## Authentication

All MCP endpoints require authentication (Breaking Change - implemented 2026-02-05):

### API Key (Bearer Token)
```bash
curl -X POST https://legal.org.ua/sse \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json"
```

### JWT (Web Users)
```bash
curl -X POST https://legal.org.ua/api/tools/search_court_cases \
  -H "Authorization: Bearer JWT_TOKEN" \
  -H "Content-Type: application/json"
```

---

## Rate Limits

### Public Endpoints (No Auth Required)
- `/health` - 60 requests/minute per IP
- `/mcp` (discovery) - 30 requests/minute per IP
- `/webhooks/*` - 10 requests/minute per IP

### Protected Endpoints (Auth Required)
- `/sse`, `/v1/sse` - No rate limit (authenticated)
- `/api/tools/*` - No rate limit (authenticated)

---

## Deployment Commands

### Deploy to specific environment
```bash
# Dev → gate.lexapp.co.ua
./manage-gateway.sh deploy dev

# Stage → mail.lexapp.co.ua
./manage-gateway.sh deploy stage

# Prod → mail.lexapp.co.ua
./manage-gateway.sh deploy prod

# All remote environments
./manage-gateway.sh deploy all
```

### Local development
```bash
# Start local environment (no deployment needed)
./manage-gateway.sh start local

# Stop local
./manage-gateway.sh stop local
```

---

## Health Checks

### Check all environments
```bash
./manage-gateway.sh health
```

### Manual health checks
```bash
# Local
curl http://localhost:3000/health

# Dev
curl https://dev.legal.org.ua/health

# Stage
curl https://stage.legal.org.ua/health

# Prod
curl https://legal.org.ua/health
```

---

## MCP Client Integration Examples

### LibreChat Configuration

```yaml
# Local
mcpServers:
  secondlayer-local:
    transport: sse
    endpoint: http://localhost:3000/v1/sse

# Dev
mcpServers:
  secondlayer-dev:
    transport: sse
    endpoint: https://dev.legal.org.ua/v1/sse
    headers:
      Authorization: "Bearer ${SECONDLAYER_DEV_KEY}"

# Stage
mcpServers:
  secondlayer-stage:
    transport: sse
    endpoint: https://stage.legal.org.ua/v1/sse
    headers:
      Authorization: "Bearer ${SECONDLAYER_STAGE_KEY}"

# Prod
mcpServers:
  secondlayer-prod:
    transport: sse
    endpoint: https://legal.org.ua/v1/sse
    headers:
      Authorization: "Bearer ${SECONDLAYER_API_KEY}"
```

### ChatGPT Actions (OpenAPI)

```yaml
# Dev
servers:
  - url: https://dev.legal.org.ua

# Stage
servers:
  - url: https://stage.legal.org.ua

# Prod
servers:
  - url: https://legal.org.ua
```

---

## Environment Variables

Each environment requires its own `.env` file:

- **Local:** `.env.local` (optional, uses defaults)
- **Dev:** `.env.dev` (required)
- **Stage:** `.env.stage` (required)
- **Prod:** `.env.prod` (required)

See `.env.*.example` files for configuration templates.

---

## Summary

| Environment | Server | MCP Backend | Frontend | OpenReyestr |
|-------------|--------|-------------|----------|-------------|
| **Local** | localhost | :3000 | :8080 | ❌ |
| **Dev** | gate.lexapp.co.ua | :3003 | :8091 | :3005 ✅ |
| **Stage** | mail.lexapp.co.ua | :3004 | :8092 | ❌ |
| **Prod** | mail.lexapp.co.ua | :3001 | :8090 | ❌ |

**OpenReyestr MCP** is deployed only on Dev environment for testing purposes.
