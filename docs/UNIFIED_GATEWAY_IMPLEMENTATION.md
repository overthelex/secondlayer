# Unified MCP Gateway Implementation

## Overview

The Unified MCP Gateway consolidates all 45 MCP tools from three separate services (mcp_backend, mcp_rada, mcp_openreyestr) into a single HTTP endpoint at `https://stage.legal.org.ua/api/tools`.

## Architecture

```
Client (ChatGPT, Claude Desktop, Web UI)
    ↓
    ↓ Authorization: Bearer <api-key>
    ↓
┌───────────────────────────────────────────────────────┐
│  mcp_backend (UNIFIED GATEWAY)                        │
│  Port: 3004 (stage)                                   │
│                                                        │
│  GET /api/tools → Returns ALL 45 tools               │
│  POST /api/tools/:toolName → Routes to service       │
│                                                        │
│  Tool Routing:                                        │
│  - No prefix → mcp_backend (local, 36 tools)         │
│  - rada_* → proxy to mcp_rada (4 tools)              │
│  - openreyestr_* → proxy to mcp_openreyestr (5)      │
│                                                        │
│  Authentication: Dual-auth (API key/JWT)             │
│  Billing: Phase 2 credits (single deduction point)   │
│  Cost Tracking: Aggregates from all services         │
└──────────┬─────────────┬──────────────┬──────────────┘
           │             │              │
     (local)      (HTTP proxy)   (HTTP proxy)
           │             │              │
           ▼             ▼              ▼
    ┌──────────┐  ┌───────────┐  ┌──────────────┐
    │ Backend  │  │ mcp_rada  │  │ mcp_openrey. │
    │ 36 tools │  │ 4 tools   │  │ 5 tools      │
    │          │  │ Port 3001 │  │ Port 3005    │
    │ Direct   │  │ (internal)│  │ (internal)   │
    └──────────┘  └───────────┘  └──────────────┘
```

## Implementation Details

### 1. New Files Created

#### `/mcp_backend/src/types/gateway.ts`
- Defines `ServiceType`, `ToolRoute`, `ServiceConfig`, and `GatewayConfig` types
- Provides type safety for gateway routing logic

#### `/mcp_backend/src/api/tool-registry.ts`
- Central registry mapping all 45 tools to their respective services
- Maps client-facing tool names (with prefixes) to service-specific names
- Fetches tool definitions from remote services dynamically
- Provides tool counts and availability information

Tool naming convention:
- **Backend tools** (35): No prefix (e.g., `search_legal_precedents`)
- **RADA tools** (4): Prefix `rada_` (e.g., `rada_search_parliament_bills`)
- **OpenReyestr tools** (5): Prefix `openreyestr_` (e.g., `openreyestr_search_entities`)

#### `/mcp_backend/src/services/service-proxy.ts`
- HTTP proxy client for calling remote services (RADA, OpenReyestr)
- Handles both JSON and SSE streaming responses
- Extracts and records cost tracking from remote responses
- Validates service availability before proxying

### 2. Modified Files

#### `/mcp_backend/src/http-server.ts`
Major changes:
1. **Imports**: Added `ToolRegistry`, `ServiceProxy`, and `ServiceType`
2. **Constructor**: Initialize gateway components
3. **GET /api/tools**: Updated to fetch tools from all services when gateway is enabled
4. **POST /api/tools/:toolName**: Added routing logic to proxy to remote services
5. **New method**: `handleStreamingProxyCall()` for SSE proxying

Key routing logic:
```typescript
const gatewayEnabled = process.env.ENABLE_UNIFIED_GATEWAY === 'true';
const route = gatewayEnabled ? this.toolRegistry.getRoute(toolName) : null;

if (gatewayEnabled && route && !route.local) {
  // Proxy to remote service (RADA or OpenReyestr)
  const remoteResult = await this.serviceProxy.callRemoteService({...});
} else {
  // Execute locally (backend tools)
  result = await requestContext.run(...);
}
```

#### `/mcp_backend/src/services/cost-tracker.ts`
Added method:
- `recordRemoteServiceCall()`: Records costs from proxied remote service calls
- Aggregates remote costs into the master tracking record
- Stores details of each remote call for audit trail

#### `/deployment/docker-compose.stage.yml`
Changes:
1. **app-stage service**: Added `ENABLE_UNIFIED_GATEWAY=true` environment variable
2. **app-stage service**: Updated RADA and OpenReyestr URLs to Docker internal network
3. **rada-mcp-app-stage service**: Removed external port mapping (3006:3001)
4. **app-openreyestr-stage service**: Removed external port mapping (3007:3005)

#### `/deployment/.env.stage`
Added:
```bash
# Unified Gateway Configuration
ENABLE_UNIFIED_GATEWAY=true
```

## Port Configuration

**Stage Environment:**
- ✅ **3004** → Unified gateway (public, all 45 tools)
- ❌ **3006** → RADA (removed, now internal only)
- ❌ **3007** → OpenReyestr (removed, now internal only)

**Internal Docker Network:**
- `http://app-stage:3000` → Backend (mcp_backend)
- `http://rada-mcp-app-stage:3001` → RADA service
- `http://app-openreyestr-stage:3005` → OpenReyestr service

## Tool List (All 45 Tools)

### Backend Tools (36)
1. classify_intent
2. search_legal_precedents
3. get_court_decision
4. get_document_text
5. semantic_search
6. find_legal_patterns
7. validate_citations
8. packaged_lawyer_answer
9. get_legal_advice
10. search_by_category
11. search_by_court
12. search_by_judge
13. search_by_date_range
14. get_case_metadata
15. get_related_cases
16. analyze_judicial_reasoning
17. extract_legal_principles
18. compare_decisions
19. track_precedent_evolution
20. get_citation_network
21. search_court_practice
22. get_practice_document
23. analyze_practice_patterns
24. get_case_documents_chain
25. search_legislation
26. get_legislation_article
27. get_legislation_section
28. get_legislation_articles
29. get_legislation_structure
30. parse_document
31. extract_key_clauses
32. summarize_document
33. compare_documents
34. batch_process_documents
35. get_judge_statistics
36. analyze_court_trends

### RADA Tools (4)
1. rada_search_parliament_bills
2. rada_get_deputy_info
3. rada_search_legislation_text
4. rada_analyze_voting_record

### OpenReyestr Tools (5)
1. openreyestr_search_entities
2. openreyestr_get_entity_details
3. openreyestr_search_beneficiaries
4. openreyestr_get_by_edrpou
5. openreyestr_get_statistics

## Cost Tracking

### How It Works
1. **Master Tracking Record**: Created in `mcp_backend` for each request
2. **Remote Service Costs**: Extracted from remote service responses
3. **Aggregation**: Remote costs added to master record via `recordRemoteServiceCall()`
4. **Billing**: Single deduction point using Phase 2 credits

### Cost Breakdown Example
```json
{
  "request_id": "abc-123",
  "openai": { "total_cost_usd": 0.002 },
  "zakononline": { "total_cost_usd": 0.007 },
  "secondlayer": {
    "total_cost_usd": 0.015,
    "calls": [
      {
        "service": "rada",
        "tool_name": "search_parliament_bills",
        "cost_usd": 0.010,
        "details": {...}
      }
    ]
  },
  "totals": {
    "cost_usd": 0.024
  }
}
```

## Testing

### Local Testing
```bash
# 1. List all tools (should return 44)
curl -H "Authorization: Bearer <api-key>" \
  http://localhost:3004/api/tools | jq '.count'

# 2. Execute backend tool (local)
curl -X POST -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  http://localhost:3004/api/tools/search_legal_precedents \
  -d '{"arguments": {"query": "відшкодування шкоди", "limit": 5}}'

# 3. Execute RADA tool (proxied)
curl -X POST -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  http://localhost:3004/api/tools/rada_get_deputy_info \
  -d '{"arguments": {"name": "Зеленський"}}'

# 4. Execute OpenReyestr tool (proxied)
curl -X POST -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  http://localhost:3004/api/tools/openreyestr_search_entities \
  -d '{"arguments": {"query": "ПриватБанк", "limit": 3}}'
```

### Stage Deployment Testing
```bash
# Deploy to stage
cd deployment
./manage-gateway.sh build
./manage-gateway.sh deploy stage

# Verify external ports
docker ps | grep -E "rada|openreyestr|app-stage"
# Expected: Only 3004 exposed, not 3006/3007

# Test via public URL
curl -H "Authorization: Bearer ${STAGE_API_KEY}" \
  https://stage.legal.org.ua/api/tools | jq '.gateway'
# Expected: {"enabled": true, "services": {"backend": 35, "rada": 4, "openreyestr": 5}}
```

### Cost Tracking Verification
```sql
-- Check cost aggregation in database
SELECT request_id, tool_name, service,
       total_cost_usd, secondlayer_calls
FROM cost_tracking
WHERE tool_name LIKE 'rada_%' OR tool_name LIKE 'openreyestr_%'
ORDER BY created_at DESC
LIMIT 10;
```

## Benefits

1. ✅ **Single Endpoint** - Clients connect to one URL for all 45 tools
2. ✅ **Unified Authentication** - One API key or JWT token for everything
3. ✅ **Single Billing Point** - Phase 2 credits work seamlessly across all services
4. ✅ **Cost Aggregation** - Master tracking record includes all service costs
5. ✅ **SSE Streaming** - Gateway proxies streaming from remote services
6. ✅ **Simplified Deployment** - No new containers, reuses existing infrastructure
7. ✅ **Security** - RADA and OpenReyestr not exposed externally
8. ✅ **Backward Compatible** - Can be disabled via `ENABLE_UNIFIED_GATEWAY=false`

## Configuration

### Environment Variables

**Required:**
- `ENABLE_UNIFIED_GATEWAY=true` - Enable gateway mode
- `RADA_MCP_URL=http://rada-mcp-app-stage:3001` - Internal RADA service URL
- `RADA_API_KEY=<key>` - API key for RADA service
- `OPENREYESTR_MCP_URL=http://app-openreyestr-stage:3005` - Internal OpenReyestr URL
- `OPENREYESTR_API_KEY=<key>` - API key for OpenReyestr service

### Disabling Gateway (Rollback)

To disable the gateway and revert to separate services:

1. Set `ENABLE_UNIFIED_GATEWAY=false` in `.env.stage`
2. Re-expose external ports in `docker-compose.stage.yml`:
   ```yaml
   rada-mcp-app-stage:
     ports:
       - "3006:3001"  # Re-enable

   app-openreyestr-stage:
     ports:
       - "3007:3005"  # Re-enable
   ```
3. Restart services:
   ```bash
   ./manage-gateway.sh restart stage
   ```

## Future Enhancements

1. **Health Checks**: Add health check endpoints for remote services
2. **Circuit Breaker**: Implement circuit breaker pattern for remote calls
3. **Caching**: Cache tool definitions from remote services
4. **Rate Limiting**: Add per-service rate limiting
5. **Metrics**: Track proxy performance and latency
6. **Retry Logic**: Add exponential backoff for failed remote calls

## Documentation Updates

The following documentation files should be updated to reflect the unified gateway:

1. `docs/ALL_MCP_TOOLS.md` - Update with gateway information
2. `docs/MCP_CLIENT_INTEGRATION_GUIDE.md` - Single endpoint configuration
3. `mcp_backend/docs/CLIENT_INTEGRATION.md` - Gateway setup instructions
4. `CLAUDE.md` - Update port allocation and gateway notes
