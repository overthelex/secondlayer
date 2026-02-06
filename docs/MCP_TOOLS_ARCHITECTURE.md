# MCP Tools Architecture Overview

## Summary

**Total MCP Tools: 44** (as of Feb 2026)
- **mcp_backend**: 35 tools (court cases, legal analysis, document parsing)
- **mcp_rada**: 4 tools (parliament data, bills, deputies, voting)
- **mcp_openreyestr**: 5 tools (state registry, beneficiaries, EDRPOU)

## Architecture Types

### Type 1: Direct Integration (mcp_backend)

**35 tools** integrated directly into HTTP server.

**Service**: `mcp_backend` HTTP server
**Ports**:
- Local: 3000
- Stage: 3004
- Prod: 3001

**Access**:
- ✅ MCP protocol (stdio, SSE)
- ✅ HTTP REST API: `GET /api/tools`, `POST /api/tools/:toolName`
- ✅ Available at: `https://stage.legal.org.ua/api/tools`

**Examples**:
- `classify_intent`
- `search_legal_precedents`
- `get_document_text`
- `parse_document` ⭐ (document analysis)
- `extract_key_clauses` ⭐ (document analysis)
- `summarize_document` ⭐ (document analysis)
- `compare_documents` ⭐ (document analysis)
- `search_procedural_norms` (internally calls RADA)
- `get_legal_advice` (main orchestrator)

### Type 2: Separate Microservice (mcp_rada)

**4 tools** exposed via separate HTTP service.

**Service**: `mcp_rada` HTTP server
**Container**: `rada-mcp-app-stage`
**Ports**:
- Local: 3001
- Stage: 3006
- Prod: internal only

**Access**:
- ✅ MCP protocol (stdio, HTTP)
- ✅ HTTP REST API: `GET /api/tools`, `POST /api/tools/:toolName`
- ✅ Available at: `http://rada-mcp-app-stage:3001/api/tools` (internal)
- ❌ **NOT directly accessible** from mcp_backend `/api/tools` endpoint

**Integration with mcp_backend**:
- mcp_backend calls RADA via HTTP client
- Uses `RADA_MCP_URL` environment variable
- Method: `callRadaTool(toolName, args)` in mcp-query-api.ts

**Tools**:
1. `search_parliament_bills` - Search bills with semantic analysis
2. `get_deputy_info` - Get deputy information (bio, committees, faction)
3. `search_legislation_text` - Search in law texts with court citations
4. `analyze_voting_record` - Analyze deputy voting patterns with AI

**Called by mcp_backend tools**:
- `search_procedural_norms` → calls `search_legislation_text`
- Future: Other tools may integrate RADA data

### Type 3: Separate Microservice (mcp_openreyestr)

**5 tools** exposed via separate HTTP service.

**Service**: `mcp_openreyestr` HTTP server
**Container**: `openreyestr-app-stage`
**Ports**:
- Local: 3004
- Stage: 3007
- Prod: internal only

**Access**:
- ✅ MCP protocol (stdio, HTTP)
- ✅ HTTP REST API: `GET /api/tools`, `POST /api/tools/:toolName`
- ✅ Available at: `http://app-openreyestr-stage:3005/api/tools` (internal)
- ❌ **NOT directly accessible** from mcp_backend `/api/tools` endpoint

**Tools**:
1. `search_entities` - Search business entities in state registry
2. `get_entity_details` - Get full entity info (founders, beneficiaries, directors)
3. `search_beneficiaries` - Search beneficial owners
4. `get_by_edrpou` - Quick lookup by EDRPOU code
5. `get_statistics` - Registry statistics

## How to Access All Tools

### Option 1: Access mcp_backend tools (35 tools)

**HTTP API**:
```bash
# List all backend tools
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://stage.legal.org.ua/api/tools

# Call a backend tool
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  https://stage.legal.org.ua/api/tools/parse_document \
  -d '{"fileBase64": "...", "mimeType": "application/pdf"}'
```

**MCP Protocol** (Claude Desktop):
```json
{
  "mcpServers": {
    "secondlayer": {
      "command": "node",
      "args": ["/path/to/mcp_backend/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Option 2: Access mcp_rada tools (4 tools)

**HTTP API** (from within stage network):
```bash
# List RADA tools
curl -H "Authorization: Bearer RADA_API_KEY" \
  http://rada-mcp-app-stage:3001/api/tools

# Call a RADA tool
curl -X POST \
  -H "Authorization: Bearer RADA_API_KEY" \
  -H "Content-Type: application/json" \
  http://rada-mcp-app-stage:3001/api/tools/search_parliament_bills \
  -d '{"query": "судова реформа", "limit": 10}'
```

**MCP Protocol** (Claude Desktop):
```json
{
  "mcpServers": {
    "rada": {
      "command": "node",
      "args": ["/path/to/mcp_rada/dist/index.js"],
      "env": {
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5433",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Option 3: Access mcp_openreyestr tools (5 tools)

**HTTP API** (from within stage network):
```bash
# List OpenReyestr tools
curl -H "Authorization: Bearer OPENREYESTR_API_KEY" \
  http://app-openreyestr-stage:3005/api/tools

# Call an OpenReyestr tool
curl -X POST \
  -H "Authorization: Bearer OPENREYESTR_API_KEY" \
  -H "Content-Type: application/json" \
  http://app-openreyestr-stage:3005/api/tools/search_entities \
  -d '{"query": "Приватбанк", "limit": 5}'
```

**MCP Protocol** (Claude Desktop):
```json
{
  "mcpServers": {
    "openreyestr": {
      "command": "node",
      "args": ["/path/to/mcp_openreyestr/dist/index.js"],
      "env": {
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5435",
        "DATABASE_URL": "postgresql://..."
      }
    }
  }
}
```

## Why Separate Services?

### Benefits of Microservice Architecture (RADA & OpenReyestr)

1. **Independent Scaling**
   - RADA has different load patterns (legislative searches)
   - OpenReyestr handles large registry data
   - Can scale each service independently

2. **Isolation**
   - Separate databases (different schemas/instances)
   - Different API keys and rate limits
   - Failures don't cascade

3. **Data Ownership**
   - RADA: Parliament data (data.rada.gov.ua)
   - OpenReyestr: State registry data (XML imports)
   - Backend: Court cases (ZakonOnline API)

4. **Cache Strategies**
   - RADA: Bills (1 day), Deputies (7 days), Laws (30 days)
   - OpenReyestr: Static registry data
   - Backend: Court decisions, embeddings

### Why Direct Integration (Document Analysis)?

1. **Tight Coupling** with existing services
   - Uses DocumentParser (already in backend)
   - Shares EmbeddingService, PatternStore
   - Integrated cost tracking

2. **Low Latency** requirements
   - OCR processing is CPU-intensive
   - No network hop overhead

3. **Simplified Deployment**
   - One less container to manage
   - Fewer moving parts

## Cross-Service Integration

### mcp_backend → mcp_rada

**Tool**: `search_procedural_norms`

```typescript
// In mcp_backend/src/api/mcp-query-api.ts
private async callRadaTool(toolName: string, args: any) {
  const baseUrl = process.env.RADA_MCP_URL; // http://rada-mcp-app-stage:3001
  const apiKey = process.env.RADA_API_KEY;

  const url = `${baseUrl}/api/tools/${toolName}`;
  const response = await axios.post(url, args, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  return response.data;
}
```

**Usage**:
```typescript
const radaResponse = await this.callRadaTool('search_legislation_text', {
  law_identifier: 'цпк',
  article: '354',
  search_text: 'строки апеляції'
});
```

### mcp_rada → mcp_backend (Optional)

**Tool**: `search_legislation_text` with `include_court_citations: true`

Calls back to mcp_backend to get court decisions that cite specific law articles.

## Deployment Status

### Stage Environment

```yaml
services:
  # Main backend (35 tools)
  app-stage:
    ports: ["3004:3000"]
    image: secondlayer-app:latest

  # RADA MCP (4 tools)
  rada-mcp-app-stage:
    ports: ["3006:3001"]
    image: rada-mcp:latest
    environment:
      SECONDLAYER_URL: http://app-stage:3000
      SECONDLAYER_API_KEY: ${SECONDARY_LAYER_KEYS}

  # OpenReyestr MCP (5 tools)
  app-openreyestr-stage:
    ports: ["3007:3005"]
    image: openreyestr-app:latest
    environment:
      SECONDLAYER_URL: http://app-stage:3000
      SECONDLAYER_API_KEY: ${SECONDARY_LAYER_KEYS}
```

## Tool Count Verification

### Expected Totals

- **Total System**: 44 tools (35 + 4 + 5)
- **mcp_backend**: 35 tools
- **mcp_rada**: 4 tools
- **mcp_openreyestr**: 5 tools

### How to Verify

```bash
# Backend tools
curl -s -H "Authorization: Bearer KEY" \
  https://stage.legal.org.ua/api/tools | jq '.count'
# Expected: 35

# RADA tools (internal network)
curl -s -H "Authorization: Bearer KEY" \
  http://rada-mcp-app-stage:3001/api/tools | jq '.count'
# Expected: 4

# OpenReyestr tools (internal network)
curl -s -H "Authorization: Bearer KEY" \
  http://app-openreyestr-stage:3005/api/tools | jq '.count'
# Expected: 5
```

## Client Integration

### For Claude Desktop (All 44 tools)

**Option 1**: Separate server configs (recommended)
```json
{
  "mcpServers": {
    "secondlayer-backend": {
      "command": "node",
      "args": ["/path/to/mcp_backend/dist/index.js"]
    },
    "secondlayer-rada": {
      "command": "node",
      "args": ["/path/to/mcp_rada/dist/index.js"]
    },
    "secondlayer-openreyestr": {
      "command": "node",
      "args": ["/path/to/mcp_openreyestr/dist/index.js"]
    }
  }
}
```

**Option 2**: HTTP transport (for remote stage)
```json
{
  "mcpServers": {
    "secondlayer-stage": {
      "url": "https://stage.legal.org.ua/mcp/sse",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

**Note**: HTTP transport for RADA/OpenReyestr requires exposing their SSE endpoints publicly (not currently configured).

## Summary

### ✅ Directly Available (35 tools)
All mcp_backend tools including document analysis are accessible at:
- `https://stage.legal.org.ua/api/tools`

### ⚠️ Separate Services (9 tools)
RADA (4) and OpenReyestr (5) tools require:
- Direct connection to their HTTP endpoints (internal network)
- OR separate MCP stdio connections
- OR future: unified gateway/proxy

### 🎯 Recommendation

For **full 44-tool access**, use one of:
1. **Multiple MCP servers** in Claude Desktop (3 stdio connections)
2. **Internal HTTP calls** from within stage network
3. **Future enhancement**: Unified MCP gateway that proxies all 44 tools

## Related Documentation

- `docs/ALL_MCP_TOOLS.md` - Complete tool list with parameters
- `docs/DOCUMENT_ANALYSIS_INTEGRATION.md` - Document analysis architecture
- `mcp_backend/docs/api-explorer.html` - Interactive API explorer
- `CLAUDE.md` - Project overview
