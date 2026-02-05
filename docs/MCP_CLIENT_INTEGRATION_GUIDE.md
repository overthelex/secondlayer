# MCP Client Integration Guide - SecondLayer Servers

## Overview

This guide describes how to connect various LLM chat clients to SecondLayer MCP servers (mcp_backend, mcp_rada, mcp_openreyestr). SecondLayer supports multiple MCP transport protocols:

- **stdio** (stdin/stdout) - For local desktop clients
- **HTTP REST API** - For simple web integrations
- **SSE (Server-Sent Events)** - For streaming responses and legacy remote MCP
- **Streamable HTTP** - Modern MCP standard (2026+)

**Current Status:**
- ✅ stdio mode fully supported
- ✅ HTTP REST API with 41+ tools
- ✅ SSE streaming endpoints
- ⚠️ Streamable HTTP `/mcp` endpoint - planned
- ⚠️ WebSocket support - optional future enhancement

---

## Part 1: Desktop LLM Chat Clients

Desktop clients use **stdio transport** exclusively - they launch the MCP server as a local subprocess and communicate via stdin/stdout. No HTTP endpoints required.

### 1. Claude Desktop

**Description:**
The official MCP client from Anthropic. Considered the "gold standard" for MCP support. Automatically discovers tools, prompts, and resources from connected servers.

**Requirements:**
- Transport: `stdio`
- Node.js installed
- Built MCP server (`npm run build`)

**Configuration:**
Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "secondlayer-backend": {
      "command": "node",
      "args": ["/absolute/path/to/SecondLayer/mcp_backend/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/secondlayer",
        "REDIS_HOST": "localhost",
        "REDIS_PORT": "6379",
        "QDRANT_URL": "http://localhost:6333",
        "OPENAI_API_KEY": "sk-...",
        "ZAKONONLINE_API_TOKEN": "..."
      }
    },
    "secondlayer-rada": {
      "command": "node",
      "args": ["/absolute/path/to/SecondLayer/mcp_rada/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5433/rada",
        "REDIS_HOST": "localhost",
        "REDIS_PORT": "6380",
        "OPENAI_API_KEY": "sk-..."
      }
    },
    "secondlayer-openreyestr": {
      "command": "node",
      "args": ["/absolute/path/to/SecondLayer/mcp_openreyestr/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5435/openreyestr"
      }
    }
  }
}
```

**Testing:**
1. Restart Claude Desktop
2. Look for tool icons in the chat interface
3. Try: "Search for court cases about contract disputes"

---

### 2. Jan AI

**Description:**
Open-source, privacy-focused AI client supporting both local and remote models. MCP support added in v0.7+ (2025). Cross-platform (Windows, macOS, Linux).

**Requirements:**
- Transport: `stdio`
- Jan AI v0.7 or newer
- Node.js and built MCP server

**Configuration:**
Navigate to Settings → Advanced → Model Context Protocol → Add Server:

```json
{
  "name": "SecondLayer Backend",
  "command": "node",
  "args": ["/absolute/path/to/SecondLayer/mcp_backend/dist/index.js"],
  "env": {
    "DATABASE_URL": "postgresql://user:pass@localhost:5432/secondlayer",
    "OPENAI_API_KEY": "sk-...",
    "ZAKONONLINE_API_TOKEN": "..."
  }
}
```

Or manually edit `~/jan/settings/mcp.json`:

```json
{
  "mcpServers": {
    "secondlayer": {
      "command": "node",
      "args": ["/absolute/path/to/SecondLayer/mcp_backend/dist/index.js"],
      "env": { ... }
    }
  }
}
```

**Documentation:** https://www.jan.ai/docs/desktop/mcp

---

### 3. Cherry Studio

**Description:**
Multi-provider AI client with sleek interface. Supports OpenAI, Anthropic, Google, and local models. MCP support for extending functionality.

**Requirements:**
- Transport: `stdio`
- Cherry Studio latest version
- Node.js and built MCP server

**Configuration:**
Settings → Extensions → MCP Servers → Add:

```json
{
  "serverName": "SecondLayer",
  "command": "node",
  "args": ["/absolute/path/to/SecondLayer/mcp_backend/dist/index.js"],
  "env": {
    "DATABASE_URL": "postgresql://...",
    "OPENAI_API_KEY": "sk-..."
  }
}
```

**Features:**
- Visual tool discovery
- Multi-server support
- Cross-platform (Windows/Mac/Linux)

---

### 4. Chat-MCP

**Description:**
Electron-based MCP client specifically designed for MCP protocol. Lightweight, open-source, cross-platform.

**Requirements:**
- Transport: `stdio`
- Chat-MCP installed
- Node.js and built MCP server

**Configuration:**
Create or edit `config.json` in Chat-MCP data directory:

```json
{
  "servers": [
    {
      "name": "SecondLayer Backend",
      "command": "node",
      "args": ["/absolute/path/to/SecondLayer/mcp_backend/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  ]
}
```

**GitHub:** https://github.com/wong2/chat-mcp

---

### 5. BoltAI

**Description:**
All-in-one AI chat client for macOS with dynamic MCP management. Supports multiple AI providers and easy MCP server switching.

**Requirements:**
- Transport: `stdio`
- macOS 12.0+
- Node.js and built MCP server

**Configuration:**
BoltAI → Preferences → MCP Servers → Add Server:

```json
{
  "identifier": "secondlayer",
  "name": "SecondLayer Legal Analysis",
  "command": "node",
  "args": ["/absolute/path/to/SecondLayer/mcp_backend/dist/index.js"],
  "env": {
    "DATABASE_URL": "postgresql://...",
    "OPENAI_API_KEY": "sk-..."
  }
}
```

**Features:**
- Dynamic server loading/unloading
- Visual tool management
- Native macOS integration

---

### Bonus: ChatGPT Desktop

**Description:**
OpenAI's official desktop app with Developer mode (Settings → Developer → Enable MCP).

**Requirements:**
- Transport: `stdio`
- ChatGPT Desktop with Developer mode
- Node.js and built MCP server

**Configuration:**
Similar to Claude Desktop - edit ChatGPT's MCP configuration file.

---

## Part 2: Web LLM Chat Clients

Web clients typically use **HTTP**, **SSE**, or **Streamable HTTP** transports. They connect to remote MCP servers via network protocols.

### 1. LibreChat

**Description:**
First web platform with comprehensive MCP support. Multi-user, multi-model, highly configurable. Supports all 4 MCP transport types.

**Requirements:**
- Transport: `sse`, `streamable-http`, `websocket`, or `stdio` (if on same server)
- SecondLayer HTTP server running
- Authentication configured

**Configuration (YAML):**
Edit `librechat.yaml`:

```yaml
mcpServers:
  secondlayer-backend:
    transport: streamable-http
    endpoint: https://legal.org.ua/mcp
    headers:
      Authorization: "Bearer ${SECONDLAYER_API_KEY}"
    metadata:
      description: "Ukrainian legal analysis with 41+ tools"

  secondlayer-rada:
    transport: sse
    endpoint: https://legal.org.ua:3001/v1/sse
    headers:
      Authorization: "Bearer ${SECONDLAYER_API_KEY}"
```

**Alternative (SSE Legacy):**

```yaml
mcpServers:
  secondlayer:
    transport: sse
    endpoint: https://legal.org.ua/sse
    headers:
      Authorization: "Bearer your-api-key-here"
```

**Endpoints Used:**
- `POST /mcp` - Streamable HTTP (modern)
- `GET /v1/sse` or `POST /v1/sse` - SSE transport
- `POST /sse` - ChatGPT-compatible SSE endpoint

**Documentation:** https://www.librechat.ai/docs/features/mcp

---

### 2. AnythingLLM

**Description:**
Document-focused LLM platform with RAG workflows. Available as desktop app and web server. MCP support for extended capabilities.

**Requirements:**
- Transport: `stdio` (desktop) or `sse`/`streamable-http` (web)
- AnythingLLM v1.5+
- SecondLayer HTTP server

**Configuration:**
Settings → MCP Integrations → Add Server:

**For Web Deployment:**
```json
{
  "name": "SecondLayer",
  "transport": "sse",
  "endpoint": "https://legal.org.ua/v1/sse",
  "headers": {
    "Authorization": "Bearer your-api-key"
  }
}
```

**For Desktop (same machine):**
```json
{
  "name": "SecondLayer",
  "transport": "stdio",
  "command": "node",
  "args": ["/path/to/SecondLayer/mcp_backend/dist/index.js"],
  "env": { ... }
}
```

**Features:**
- Document embedding + MCP tools
- RAG pipeline integration
- Multi-user workspace support

---

### 3. Open WebUI

**Description:**
Feature-rich web UI for LLMs with extensive customization. MCP support requires `mcpo` proxy for protocol translation.

**Requirements:**
- Transport: HTTP via `mcpo` proxy
- Open WebUI latest version
- `mcpo` installed (`npm install -g @modelcontextprotocol/mcpo`)

**Setup:**

1. **Start mcpo proxy:**
```bash
mcpo --server "node /path/to/SecondLayer/mcp_backend/dist/index.js"
```

This creates HTTP proxy at `http://localhost:3100`

2. **Configure Open WebUI:**
Settings → Functions → Add Function → External API:

```json
{
  "name": "SecondLayer Legal",
  "endpoint": "http://localhost:3100/api/tools",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json"
  }
}
```

**Note:** `mcpo` translates between stdio MCP and HTTP REST API.

---

### 4. Chainlit

**Description:**
Python framework for building conversational AI apps with streaming, authentication, and MCP integration.

**Requirements:**
- Transport: Custom HTTP integration
- Chainlit installed (`pip install chainlit`)
- SecondLayer HTTP server running

**Configuration (Python):**

```python
import chainlit as cl
import requests

SECONDLAYER_URL = "https://legal.org.ua"
SECONDLAYER_KEY = "your-api-key"

@cl.on_message
async def main(message: cl.Message):
    # Call SecondLayer MCP tool
    response = requests.post(
        f"{SECONDLAYER_URL}/api/tools/search_court_cases",
        headers={"Authorization": f"Bearer {SECONDLAYER_KEY}"},
        json={
            "query": message.content,
            "limit": 10
        }
    )

    result = response.json()
    await cl.Message(content=str(result)).send()
```

**Endpoints Used:**
- `POST /api/tools/:toolName` - Direct tool execution
- `POST /api/tools/:toolName/stream` - SSE streaming

**Documentation:** https://docs.chainlit.io/

---

### 5. ChatGPT Web (via Custom GPTs + Actions)

**Description:**
OpenAI's ChatGPT with Custom GPTs. Integrate SecondLayer via OpenAPI schema and Actions API.

**Requirements:**
- Transport: HTTP REST API
- ChatGPT Plus or Enterprise
- SecondLayer HTTP server with public HTTPS

**Setup:**

1. **Create Custom GPT:**
   ChatGPT → Explore GPTs → Create a GPT

2. **Configure Actions:**
   Add OpenAPI schema:

```yaml
openapi: 3.1.0
info:
  title: SecondLayer Legal Analysis
  version: 1.0.0
servers:
  - url: https://legal.org.ua/api

paths:
  /tools/search_court_cases:
    post:
      operationId: searchCourtCases
      summary: Search Ukrainian court cases
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                query:
                  type: string
                limit:
                  type: integer
                  default: 10
      responses:
        '200':
          description: Search results
          content:
            application/json:
              schema:
                type: object

  /tools/get_legislation_section:
    post:
      operationId: getLegislation
      summary: Get Ukrainian legislation text
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                legislation_name:
                  type: string
                section_reference:
                  type: string
      responses:
        '200':
          description: Legislation text

components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer

security:
  - BearerAuth: []
```

3. **Configure Authentication:**
   Actions → Authentication → API Key:
   - Auth Type: Bearer
   - API Key: `your-secondlayer-key`

**Endpoints Used:**
- `POST /api/tools/:toolName` for each operation

**Documentation:** https://platform.openai.com/docs/actions

---

## Part 3: MCP Server Endpoints Specification

SecondLayer servers expose multiple endpoint types depending on the client integration method.

### 3.1 Desktop Clients (stdio)

**Entry Point:** `dist/index.js`

Desktop clients don't use HTTP - they spawn the MCP server as a subprocess:

```bash
node /path/to/mcp_backend/dist/index.js
```

**Communication:**
- **Input:** JSON-RPC 2.0 messages via stdin
- **Output:** JSON-RPC 2.0 responses via stdout
- **Protocol:** MCP stdio transport

**No network configuration needed.** Authentication is not required (local process).

---

### 3.2 Web Clients (HTTP REST API)

**Base URL:** `http://localhost:3000` (dev) or `https://legal.org.ua` (prod)

#### Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-05T12:00:00Z",
  "services": {
    "database": "connected",
    "redis": "connected",
    "qdrant": "connected"
  }
}
```

#### List All Tools
```http
GET /api/tools
Authorization: Bearer your-api-key
```

**Response:**
```json
{
  "tools": [
    {
      "name": "search_court_cases",
      "description": "Search Ukrainian court cases by keyword",
      "inputSchema": { ... }
    },
    ...
  ]
}
```

#### Execute Tool
```http
POST /api/tools/:toolName
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "query": "contract disputes",
  "limit": 10
}
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 10 court cases..."
    }
  ],
  "isError": false
}
```

#### Execute Tool with Streaming
```http
POST /api/tools/:toolName/stream
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "query": "constitutional rights"
}
```

**Response:** SSE stream
```
data: {"type":"progress","message":"Searching database..."}

data: {"type":"result","content":[{"type":"text","text":"..."}]}

data: {"type":"done"}
```

#### Batch Tool Execution
```http
POST /api/tools/batch
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "requests": [
    {
      "tool": "search_court_cases",
      "arguments": {"query": "contracts", "limit": 5}
    },
    {
      "tool": "get_legislation_section",
      "arguments": {"legislation_name": "constitution", "section_reference": "Article 124"}
    }
  ]
}
```

---

### 3.3 Remote MCP Clients (SSE Transport - Legacy)

#### Standard MCP SSE Endpoint (GET)
```http
GET /v1/sse?apiKey=your-api-key
Accept: text/event-stream
```

**Used by:** LibreChat (SSE mode), AnythingLLM

**Protocol:**
1. Client sends SSE connection
2. Server responds with `event: endpoint` containing session URL
3. Client sends JSON-RPC messages to session URL
4. Server streams responses via SSE

#### Standard MCP SSE Endpoint (POST)
```http
POST /v1/sse
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "clientInfo": {
      "name": "LibreChat",
      "version": "1.0.0"
    }
  }
}
```

**Response:** SSE stream with JSON-RPC messages

#### ChatGPT-Compatible SSE Endpoint
```http
POST /sse
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "method": "tools/list"
}
```

**Used by:** ChatGPT Custom GPTs with SSE Actions

---

### 3.4 Remote MCP Clients (Streamable HTTP - Modern)

**Status:** ⚠️ Planned (not yet implemented)

#### Unified MCP Endpoint
```http
POST /mcp
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_court_cases",
    "arguments": {
      "query": "contract disputes",
      "limit": 10
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Found 10 court cases..."
      }
    ]
  }
}
```

**Supported Methods:**
- `initialize` - Protocol handshake
- `tools/list` - List available tools
- `tools/call` - Execute a tool
- `prompts/list` - List available prompts
- `resources/list` - List available resources
- `ping` - Keep-alive

**Standard:** MCP Specification 2024-11-05 with Streamable HTTP transport (2026-03-26+)

---

### 3.5 WebSocket Transport (Optional)

**Status:** ⚠️ Not implemented (future consideration)

**Use Case:** Real-time bidirectional communication for clients like LibreChat

**Proposed Endpoint:**
```
wss://legal.org.ua/ws
```

**Protocol:** JSON-RPC 2.0 over WebSocket

---

## Part 4: Authentication & Security

### 4.1 Desktop Clients (stdio)

**Authentication:** Not required
Desktop clients run MCP server as local subprocess with full access to environment variables. Security is managed by OS-level permissions.

### 4.2 Web Clients (HTTP/SSE)

#### Bearer Token Authentication

**Header:**
```http
Authorization: Bearer your-api-key
```

**Configuration:**
Set `SECONDARY_LAYER_KEYS` environment variable:

```bash
SECONDARY_LAYER_KEYS=test-key-123,prod-key-456,client-key-789
```

Multiple keys supported (comma-separated) for different clients.

#### JWT Authentication (Optional)

For user-based web apps with login:

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Configuration:**
```bash
JWT_SECRET=your-64-character-secret-key
```

JWT tokens generated after OAuth/password login.

#### OAuth 2.0 (Optional)

For Google/GitHub login integration:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=https://legal.org.ua/auth/google/callback
```

**Flow:**
1. User clicks "Login with Google"
2. OAuth redirect to Google
3. Callback generates JWT token
4. JWT used for subsequent API calls

### 4.3 API Key Management

**Database Table:** `api_keys`

Create new API key:
```sql
INSERT INTO api_keys (key, name, user_id, permissions)
VALUES (
  'sk-secondlayer-...',
  'LibreChat Production',
  1,
  '["tools:read", "tools:execute"]'
);
```

**Permissions:**
- `tools:read` - List tools
- `tools:execute` - Execute tools
- `admin:all` - Full access

### 4.4 Rate Limiting

**Configuration:**
```bash
RATE_LIMIT_WINDOW_MS=60000      # 1 minute
RATE_LIMIT_MAX_REQUESTS=100     # 100 requests per minute
```

**Headers in Response:**
```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1643723456
```

### 4.5 CORS Configuration

For web clients from different domains:

```bash
CORS_ORIGINS=https://librechat.local,https://chat.example.com
```

**Headers:**
```http
Access-Control-Allow-Origin: https://librechat.local
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
```

---

## Part 5: Configuration Examples

### 5.1 Complete mcp_backend Configuration

**Environment Variables (`.env`):**

```bash
# Database
DATABASE_URL=postgresql://secondlayer:password@localhost:5432/secondlayer
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=secondlayer
POSTGRES_PASSWORD=secure_password
POSTGRES_DB=secondlayer

# Redis Cache
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Qdrant Vector DB
QDRANT_URL=http://localhost:6333

# OpenAI API
OPENAI_API_KEY=sk-proj-...
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002

# Dynamic model selection
OPENAI_MODEL_QUICK=gpt-4o-mini        # Simple tasks
OPENAI_MODEL_STANDARD=gpt-4o-mini     # Moderate complexity
OPENAI_MODEL_DEEP=gpt-4o              # Complex analysis

# External APIs
ZAKONONLINE_API_TOKEN=your-zakononline-token

# Authentication
SECONDARY_LAYER_KEYS=test-key-123,prod-key-456
JWT_SECRET=your-64-character-jwt-secret-key-here-make-it-strong

# OAuth (optional)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=https://legal.org.ua/auth/google/callback

# Server
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# CORS
CORS_ORIGINS=https://librechat.local,https://chat.example.com
```

### 5.2 Complete mcp_rada Configuration

```bash
# Database (different port to avoid conflicts)
DATABASE_URL=postgresql://rada:password@localhost:5433/rada
POSTGRES_PORT=5433

# Redis (different port)
REDIS_PORT=6380

# Qdrant (different port)
QDRANT_URL=http://localhost:6335

# OpenAI (for embeddings/analysis)
OPENAI_API_KEY=sk-proj-...

# SecondLayer Integration (optional)
SECONDLAYER_URL=http://localhost:3000
SECONDLAYER_API_KEY=test-key-123

# Server
PORT=3001

# Authentication
SECONDARY_LAYER_KEYS=rada-key-123,rada-prod-456
```

### 5.3 Complete mcp_openreyestr Configuration

```bash
# Database (different port)
DATABASE_URL=postgresql://openreyestr:password@localhost:5435/openreyestr
POSTGRES_PORT=5435

# Server
PORT=3004

# Authentication
SECONDARY_LAYER_KEYS=openreyestr-key-123
```

### 5.4 Claude Desktop Full Config

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "secondlayer-backend": {
      "command": "node",
      "args": ["/Users/username/SecondLayer/mcp_backend/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://secondlayer:pass@localhost:5432/secondlayer",
        "REDIS_HOST": "localhost",
        "REDIS_PORT": "6379",
        "QDRANT_URL": "http://localhost:6333",
        "OPENAI_API_KEY": "sk-proj-...",
        "ZAKONONLINE_API_TOKEN": "your-token",
        "LOG_LEVEL": "info"
      }
    },
    "secondlayer-rada": {
      "command": "node",
      "args": ["/Users/username/SecondLayer/mcp_rada/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://rada:pass@localhost:5433/rada",
        "REDIS_HOST": "localhost",
        "REDIS_PORT": "6380",
        "QDRANT_URL": "http://localhost:6335",
        "OPENAI_API_KEY": "sk-proj-...",
        "SECONDLAYER_URL": "http://localhost:3000",
        "SECONDLAYER_API_KEY": "test-key-123",
        "LOG_LEVEL": "info"
      }
    },
    "secondlayer-openreyestr": {
      "command": "node",
      "args": ["/Users/username/SecondLayer/mcp_openreyestr/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://openreyestr:pass@localhost:5435/openreyestr",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### 5.5 LibreChat Full Config

`librechat.yaml`:

```yaml
version: 1.1.0

mcpServers:
  secondlayer-backend:
    transport: streamable-http
    endpoint: https://legal.org.ua/mcp
    headers:
      Authorization: "Bearer ${SECONDLAYER_API_KEY}"
    metadata:
      name: "SecondLayer Backend"
      description: "Ukrainian court cases, legal documents, semantic search (41+ tools)"
      icon: "⚖️"

  secondlayer-rada:
    transport: streamable-http
    endpoint: https://legal.org.ua:3001/mcp
    headers:
      Authorization: "Bearer ${SECONDLAYER_RADA_KEY}"
    metadata:
      name: "Verkhovna Rada"
      description: "Ukrainian Parliament data - deputies, bills, legislation (4 tools)"
      icon: "🏛️"

  secondlayer-openreyestr:
    transport: streamable-http
    endpoint: https://legal.org.ua:3004/mcp
    headers:
      Authorization: "Bearer ${SECONDLAYER_OPENREYESTR_KEY}"
    metadata:
      name: "State Register"
      description: "Ukrainian business entities, beneficiaries, EDRPOU lookup (5 tools)"
      icon: "🏢"

# Alternative: SSE transport (legacy)
# mcpServers:
#   secondlayer:
#     transport: sse
#     endpoint: https://legal.org.ua/v1/sse
#     headers:
#       Authorization: "Bearer ${SECONDLAYER_API_KEY}"
```

### 5.6 Docker Compose for Local Development

`docker-compose.local.yml`:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: secondlayer
      POSTGRES_PASSWORD: password
      POSTGRES_DB: secondlayer
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  postgres_rada:
    image: postgres:15
    environment:
      POSTGRES_USER: rada
      POSTGRES_PASSWORD: password
      POSTGRES_DB: rada
    ports:
      - "5433:5432"
    volumes:
      - postgres_rada_data:/var/lib/postgresql/data

  postgres_openreyestr:
    image: postgres:15
    environment:
      POSTGRES_USER: openreyestr
      POSTGRES_PASSWORD: password
      POSTGRES_DB: openreyestr
    ports:
      - "5435:5432"
    volumes:
      - postgres_openreyestr_data:/var/lib/postgresql/data

  redis:
    image: redis:7
    ports:
      - "6379:6379"

  redis_rada:
    image: redis:7
    ports:
      - "6380:6379"

  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage

  qdrant_rada:
    image: qdrant/qdrant:latest
    ports:
      - "6335:6333"
      - "6336:6334"
    volumes:
      - qdrant_rada_data:/qdrant/storage

  mcp_backend:
    build: ./mcp_backend
    environment:
      DATABASE_URL: postgresql://secondlayer:password@postgres:5432/secondlayer
      REDIS_HOST: redis
      REDIS_PORT: 6379
      QDRANT_URL: http://qdrant:6333
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      ZAKONONLINE_API_TOKEN: ${ZAKONONLINE_API_TOKEN}
      SECONDARY_LAYER_KEYS: ${SECONDARY_LAYER_KEYS}
    ports:
      - "3000:3000"
    depends_on:
      - postgres
      - redis
      - qdrant

  mcp_rada:
    build: ./mcp_rada
    environment:
      DATABASE_URL: postgresql://rada:password@postgres_rada:5432/rada
      REDIS_HOST: redis_rada
      REDIS_PORT: 6379
      QDRANT_URL: http://qdrant_rada:6333
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      SECONDLAYER_URL: http://mcp_backend:3000
      SECONDLAYER_API_KEY: ${SECONDARY_LAYER_KEYS}
    ports:
      - "3001:3001"
    depends_on:
      - postgres_rada
      - redis_rada
      - qdrant_rada
      - mcp_backend

  mcp_openreyestr:
    build: ./mcp_openreyestr
    environment:
      DATABASE_URL: postgresql://openreyestr:password@postgres_openreyestr:5432/openreyestr
    ports:
      - "3004:3004"
    depends_on:
      - postgres_openreyestr

volumes:
  postgres_data:
  postgres_rada_data:
  postgres_openreyestr_data:
  qdrant_data:
  qdrant_rada_data:
```

---

## Part 6: Testing & Examples

### 6.1 Testing stdio Mode (Desktop Clients)

**Manual Test:**

```bash
cd mcp_backend
npm run build

# Start server in stdio mode
node dist/index.js

# Send initialize request (paste into stdin):
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}

# Expected response on stdout:
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{...}}}

# List tools:
{"jsonrpc":"2.0","id":2,"method":"tools/list"}

# Call tool:
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_court_cases","arguments":{"query":"contracts","limit":5}}}
```

### 6.2 Testing HTTP API

**curl Examples:**

```bash
# Health check
curl http://localhost:3000/health

# List tools
curl -H "Authorization: Bearer test-key-123" \
  http://localhost:3000/api/tools

# Search court cases
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"query":"contract disputes","limit":10}' \
  http://localhost:3000/api/tools/search_court_cases

# Get legislation section
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"legislation_name":"constitution","section_reference":"Article 124"}' \
  http://localhost:3000/api/tools/get_legislation_section

# Batch execution
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {
        "tool": "search_court_cases",
        "arguments": {"query": "contracts", "limit": 5}
      },
      {
        "tool": "get_legislation_section",
        "arguments": {"legislation_name": "constitution", "section_reference": "Article 124"}
      }
    ]
  }' \
  http://localhost:3000/api/tools/batch
```

### 6.3 Testing SSE Streaming

**curl Example:**

```bash
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"query":"constitutional rights"}' \
  http://localhost:3000/api/tools/search_court_cases/stream
```

**Expected Output:**
```
data: {"type":"progress","message":"Classifying query intent..."}

data: {"type":"progress","message":"Searching court database..."}

data: {"type":"progress","message":"Found 15 cases"}

data: {"type":"result","content":[{"type":"text","text":"Case 1: ..."}]}

data: {"type":"done"}
```

### 6.4 JavaScript Client Example

```javascript
// HTTP API Client
class SecondLayerClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async searchCourtCases(query, limit = 10) {
    const response = await fetch(
      `${this.baseUrl}/api/tools/search_court_cases`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, limit })
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  }

  async getLegislation(legislationName, sectionReference) {
    const response = await fetch(
      `${this.baseUrl}/api/tools/get_legislation_section`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          legislation_name: legislationName,
          section_reference: sectionReference
        })
      }
    );

    return await response.json();
  }

  async *searchStream(query) {
    const response = await fetch(
      `${this.baseUrl}/api/tools/search_court_cases/stream`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
      }
    );

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          yield data;
        }
      }
    }
  }
}

// Usage
const client = new SecondLayerClient(
  'https://legal.org.ua',
  'your-api-key'
);

// Simple request
const cases = await client.searchCourtCases('contract disputes', 10);
console.log(cases);

// Streaming request
for await (const event of client.searchStream('constitutional rights')) {
  console.log(event.type, event.message || event.content);
}
```

### 6.5 Python Client Example

```python
import requests
from typing import Generator, Dict, Any
import json

class SecondLayerClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.api_key = api_key
        self.headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }

    def search_court_cases(self, query: str, limit: int = 10) -> Dict[str, Any]:
        """Search Ukrainian court cases"""
        response = requests.post(
            f'{self.base_url}/api/tools/search_court_cases',
            headers=self.headers,
            json={'query': query, 'limit': limit}
        )
        response.raise_for_status()
        return response.json()

    def get_legislation(self, legislation_name: str, section_reference: str) -> Dict[str, Any]:
        """Get legislation section"""
        response = requests.post(
            f'{self.base_url}/api/tools/get_legislation_section',
            headers=self.headers,
            json={
                'legislation_name': legislation_name,
                'section_reference': section_reference
            }
        )
        response.raise_for_status()
        return response.json()

    def search_stream(self, query: str) -> Generator[Dict[str, Any], None, None]:
        """Stream search results via SSE"""
        response = requests.post(
            f'{self.base_url}/api/tools/search_court_cases/stream',
            headers=self.headers,
            json={'query': query},
            stream=True
        )
        response.raise_for_status()

        for line in response.iter_lines():
            if line:
                line = line.decode('utf-8')
                if line.startswith('data: '):
                    data = json.loads(line[6:])
                    yield data

    def batch_execute(self, requests_list: list) -> Dict[str, Any]:
        """Execute multiple tools in batch"""
        response = requests.post(
            f'{self.base_url}/api/tools/batch',
            headers=self.headers,
            json={'requests': requests_list}
        )
        response.raise_for_status()
        return response.json()

# Usage
client = SecondLayerClient('https://legal.org.ua', 'your-api-key')

# Simple request
cases = client.search_court_cases('contract disputes', limit=10)
print(f"Found {len(cases['content'])} cases")

# Get legislation
article = client.get_legislation('constitution', 'Article 124')
print(article['content'][0]['text'])

# Streaming
for event in client.search_stream('constitutional rights'):
    print(event.get('type'), event.get('message', ''))

# Batch execution
results = client.batch_execute([
    {
        'tool': 'search_court_cases',
        'arguments': {'query': 'contracts', 'limit': 5}
    },
    {
        'tool': 'get_legislation_section',
        'arguments': {
            'legislation_name': 'constitution',
            'section_reference': 'Article 124'
        }
    }
])
print(f"Batch completed: {len(results['results'])} results")
```

---

## Part 7: Troubleshooting

### 7.1 Desktop Client Issues

**Problem:** Claude Desktop doesn't show tools

**Solutions:**
1. Check config file path (macOS vs Windows)
2. Ensure `command` uses absolute path
3. Run `npm run build` in mcp_backend
4. Check `dist/index.js` exists
5. Restart Claude Desktop
6. Check logs: `~/Library/Logs/Claude/` (macOS)

**Problem:** stdio server crashes on startup

**Solutions:**
1. Verify all environment variables in `env` section
2. Check database connectivity
3. Ensure PostgreSQL/Redis/Qdrant are running
4. Test manually: `node dist/index.js` and look for errors

### 7.2 Web Client Issues

**Problem:** HTTP 401 Unauthorized

**Solutions:**
1. Check `Authorization: Bearer` header is present
2. Verify API key in `SECONDARY_LAYER_KEYS` env var
3. Check server logs for auth errors
4. Try `curl -H "Authorization: Bearer your-key" http://localhost:3000/health`

**Problem:** HTTP 500 Internal Server Error

**Solutions:**
1. Check server logs: `npm run dev:http`
2. Verify database migrations: `npm run migrate`
3. Check Redis connection: `redis-cli ping`
4. Check Qdrant connection: `curl http://localhost:6333`

**Problem:** SSE stream doesn't work

**Solutions:**
1. Ensure client sends `Accept: text/event-stream` header
2. Check firewall/proxy doesn't block SSE
3. Test with curl first
4. Verify streaming endpoint: `/api/tools/:toolName/stream`

### 7.3 LibreChat Integration Issues

**Problem:** MCP server not appearing in LibreChat

**Solutions:**
1. Check `librechat.yaml` syntax
2. Restart LibreChat after config changes
3. Check LibreChat logs for MCP errors
4. Verify endpoint URL is correct
5. Test endpoint manually with curl

**Problem:** Streamable HTTP not working

**Solutions:**
1. Verify `/mcp` endpoint exists (currently planned)
2. Fall back to SSE transport temporarily
3. Check MCP protocol version compatibility

### 7.4 Authentication Issues

**Problem:** API key rejected

**Solutions:**
1. Check `SECONDARY_LAYER_KEYS` has your key
2. Verify no extra spaces in env var
3. Use comma separator for multiple keys
4. Restart server after changing env vars

**Problem:** JWT token expired

**Solutions:**
1. Re-authenticate via OAuth flow
2. Check `JWT_SECRET` is set correctly
3. Verify token expiration time (default 24h)

### 7.5 Performance Issues

**Problem:** Slow responses

**Solutions:**
1. Check Redis cache hit rate
2. Verify Qdrant vector search performance
3. Check OpenAI API latency
4. Use `OPENAI_MODEL_QUICK` for simple queries
5. Enable query result caching

**Problem:** High API costs

**Solutions:**
1. Check cost tracking: `SELECT * FROM monthly_api_usage`
2. Use cheaper models for classification: `gpt-4o-mini`
3. Implement query caching
4. Reduce embedding dimensions
5. Set token limits in prompts

---

## Part 8: Migration from Legacy Systems

### 8.1 Migrating from REST API to MCP

If you currently use raw REST API, migrate to MCP for better integration:

**Before (REST):**
```javascript
const response = await fetch('https://legal.org.ua/api/search', {
  method: 'POST',
  body: JSON.stringify({ query: 'contracts' })
});
```

**After (MCP HTTP):**
```javascript
const response = await fetch('https://legal.org.ua/api/tools/search_court_cases', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer key' },
  body: JSON.stringify({ query: 'contracts', limit: 10 })
});
```

**Benefits:**
- Standardized tool discovery
- Automatic schema validation
- Better error handling
- Streaming support

### 8.2 Migrating from SSE to Streamable HTTP

Once `/mcp` endpoint is implemented:

**Before (SSE):**
```yaml
mcpServers:
  secondlayer:
    transport: sse
    endpoint: https://legal.org.ua/v1/sse
```

**After (Streamable HTTP):**
```yaml
mcpServers:
  secondlayer:
    transport: streamable-http
    endpoint: https://legal.org.ua/mcp
```

**Benefits:**
- Standard JSON-RPC 2.0 format
- Better error handling
- Simpler client implementation
- No SSE connection management

---

## Part 9: Advanced Topics

### 9.1 Custom Tool Development

Add new MCP tool to SecondLayer:

1. **Define tool schema** (`mcp_backend/src/api/mcp-query-api.ts`):

```typescript
{
  name: "my_custom_tool",
  description: "Description of what this tool does",
  inputSchema: {
    type: "object",
    properties: {
      param1: {
        type: "string",
        description: "Parameter description"
      }
    },
    required: ["param1"]
  }
}
```

2. **Implement handler:**

```typescript
async handleMyCustomTool(args: { param1: string }): Promise<McpToolResponse> {
  // Your logic here
  return {
    content: [
      {
        type: "text",
        text: "Result text"
      }
    ]
  };
}
```

3. **Register in `callTool()` method:**

```typescript
case "my_custom_tool":
  return await this.handleMyCustomTool(args);
```

4. **Rebuild and test:**

```bash
npm run build
npm test
```

### 9.2 Multi-Server Orchestration

Use multiple MCP servers in one client:

**Claude Desktop:**
```json
{
  "mcpServers": {
    "court-cases": { ... },
    "parliament": { ... },
    "state-registry": { ... }
  }
}
```

**LibreChat:**
```yaml
mcpServers:
  court-cases: { ... }
  parliament: { ... }
  state-registry: { ... }
```

**Cross-server queries:**
```
User: "Find court cases about Deputy Ivanov's company 12345678"

1. RADA server → get_deputy_info → "Ivanov"
2. OpenReyestr → search_by_edrpou → "12345678" → Company name
3. Backend → search_court_cases → Query with company name
```

### 9.3 Rate Limiting & Quotas

Implement per-key quotas:

```sql
ALTER TABLE api_keys ADD COLUMN daily_quota INTEGER DEFAULT 1000;
ALTER TABLE api_keys ADD COLUMN requests_today INTEGER DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN quota_reset_date DATE DEFAULT CURRENT_DATE;
```

Middleware check:

```typescript
if (apiKey.requests_today >= apiKey.daily_quota) {
  return res.status(429).json({
    error: 'Daily quota exceeded',
    reset_at: apiKey.quota_reset_date
  });
}
```

### 9.4 Webhook Notifications

Notify external systems when tools complete:

```typescript
// After tool execution
if (result && webhookUrl) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool: toolName,
      status: 'completed',
      result: result,
      timestamp: new Date().toISOString()
    })
  });
}
```

---

## References

### Official Documentation

- **MCP Specification:** https://modelcontextprotocol.io/
- **MCP Clients List:** https://modelcontextprotocol.io/clients
- **Anthropic MCP Docs:** https://docs.anthropic.com/claude/docs/mcp
- **OpenAI Actions (MCP):** https://platform.openai.com/docs/mcp

### Client Documentation

- **Claude Desktop:** https://claude.ai/download
- **Jan AI:** https://www.jan.ai/docs/desktop/mcp
- **LibreChat:** https://www.librechat.ai/docs/features/mcp
- **Cherry Studio:** https://github.com/kangfenmao/cherry-studio
- **Chat-MCP:** https://github.com/wong2/chat-mcp
- **BoltAI:** https://boltai.com/
- **AnythingLLM:** https://anythingllm.com/
- **Open WebUI:** https://openwebui.com/
- **Chainlit:** https://docs.chainlit.io/

### SecondLayer Documentation

- **Main Documentation Hub:** `/mcp_backend/docs/index.html`
- **All MCP Tools:** `/docs/ALL_MCP_TOOLS.md`
- **API Explorer:** `/mcp_backend/docs/api-explorer.html`
- **Client Integration:** `/mcp_backend/docs/CLIENT_INTEGRATION.md`
- **SSE Streaming:** `/mcp_backend/docs/SSE_STREAMING.md`
- **ChatGPT Integration:** `/mcp_backend/docs/CHATGPT_INTEGRATION.md`
- **Deployment Guide:** `/mcp_backend/docs/DEPLOYMENT_CHATGPT.md`
- **Database Setup:** `/mcp_backend/docs/DATABASE_SETUP.md`

### Articles & Tutorials

- **ClickHouse MCP Article:** https://clickhouse.com/blog/llm-chat-mcp-support
- **MCP Transport Protocols:** https://modelcontextprotocol.io/docs/concepts/transports
- **Building MCP Servers:** https://modelcontextprotocol.io/docs/tools/building-servers

### Community Resources

- **MCP GitHub:** https://github.com/modelcontextprotocol
- **MCP Discord:** https://discord.gg/mcp (community support)
- **SecondLayer Issues:** https://github.com/yourorg/SecondLayer/issues

---

## Appendix A: Complete Endpoint Matrix

| Client Type | Transport | Endpoints Used | Auth Method |
|------------|-----------|----------------|-------------|
| **Desktop Clients** | | | |
| Claude Desktop | stdio | `dist/index.js` | None (local) |
| Jan AI | stdio | `dist/index.js` | None (local) |
| Cherry Studio | stdio | `dist/index.js` | None (local) |
| Chat-MCP | stdio | `dist/index.js` | None (local) |
| BoltAI | stdio | `dist/index.js` | None (local) |
| ChatGPT Desktop | stdio | `dist/index.js` | None (local) |
| **Web Clients** | | | |
| LibreChat | Streamable HTTP | `POST /mcp` | Bearer token |
| LibreChat (legacy) | SSE | `GET/POST /v1/sse` | Bearer token |
| AnythingLLM | SSE | `GET/POST /v1/sse` | Bearer token |
| Open WebUI | HTTP (via mcpo) | `POST /api/tools/:name` | Bearer token |
| Chainlit | HTTP | `POST /api/tools/:name` | Bearer token |
| ChatGPT Web | HTTP | `POST /api/tools/:name` | Bearer token |
| **Direct API** | | | |
| curl/scripts | HTTP | All `/api/*` endpoints | Bearer token |
| Custom clients | HTTP | All `/api/*` endpoints | Bearer/JWT |

## Appendix B: Port Reference

| Service | Default Port | Purpose |
|---------|-------------|---------|
| mcp_backend HTTP | 3000 | Main legal analysis server |
| mcp_rada HTTP | 3001 | Parliament data server |
| mcp_openreyestr HTTP | 3004 | State registry server |
| PostgreSQL (backend) | 5432 | Main database |
| PostgreSQL (rada) | 5433 | Parliament database |
| PostgreSQL (openreyestr) | 5435 | Registry database |
| Redis (backend) | 6379 | Main cache |
| Redis (rada) | 6380 | Parliament cache |
| Qdrant (backend) | 6333-6334 | Main vector DB |
| Qdrant (rada) | 6335-6336 | Parliament vector DB |

## Appendix C: Tool Count by Server

| Server | Tool Count | Main Categories |
|--------|-----------|-----------------|
| mcp_backend | 34 | Court cases, legal analysis, documents, semantic search, citations |
| mcp_rada | 4 | Deputies, bills, legislation, parliament sessions |
| mcp_openreyestr | 5 | Business entities, beneficiaries, EDRPOU lookup |
| **Total** | **43** | Complete legal research platform |

---

**Document Version:** 1.0
**Last Updated:** 2026-02-05
**Maintained by:** SecondLayer Team
**License:** Internal documentation
