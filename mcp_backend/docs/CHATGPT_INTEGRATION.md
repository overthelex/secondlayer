# ChatGPT Web Integration Guide

This guide explains how to connect the SecondLayer MCP backend to ChatGPT web interface using the Model Context Protocol (MCP).

## Overview

The SecondLayer MCP backend implements the Model Context Protocol over Server-Sent Events (SSE), allowing ChatGPT to access Ukrainian legal research tools directly from the web interface.

**Base URL**: `https://mcp.legal.org.ua`

## Integration Steps

### 1. Access ChatGPT Developer Mode

1. Go to [ChatGPT](https://chat.openai.com)
2. Navigate to Settings → Beta Features
3. Enable "Developer Mode" or "Custom MCP Servers"

### 2. Add MCP Server

In the ChatGPT interface, add a new MCP server with the following configuration:

**Basic Configuration:**
- **Name**: SecondLayer Legal Research
- **Description**: Ukrainian legal research and document analysis platform with 40+ specialized tools for court cases, legislation, and legal patterns.
- **MCP Server URL**: `https://mcp.legal.org.ua/sse`

**Authentication** (Optional):
- **Type**: OAuth 2.0 or Bearer Token
- **OAuth Client ID**: (if using OAuth - contact admin)
- **OAuth Client Secret**: (if using OAuth - contact admin)

For Bearer token authentication:
- **Type**: Bearer Token
- **Token**: Your `SECONDARY_LAYER_KEY`

### 3. Available Tools (41 total)

The MCP server exposes all tools from `lexconfig/mcp_tools.txt`:

#### Core Query Pipeline (4 tools)
1. `classify_intent` - Query classification and routing
2. `retrieve_legal_sources` - RAG retrieval of cases/laws
3. `analyze_legal_patterns` - Extract success arguments and risk factors
4. `validate_response` - Trust layer for anti-hallucination

#### Legal Research & Precedent Search (6 tools)
5. `search_legal_precedents` - Semantic search for court cases
6. `analyze_case_pattern` - Court practice patterns and statistics
7. `get_similar_reasoning` - Find similar court reasoning
8. `search_supreme_court_practice` - Supreme Court practice search
9. `compare_practice_pro_contra` - Pro/contra practice collection
10. `find_similar_fact_pattern_cases` - Search by similar facts

#### Document Analysis (3 tools)
11. `extract_document_sections` - Extract structured sections (FACTS/REASONING/DECISION)
12. `get_court_decision` - Load full text of court decision
13. `get_case_text` - Alias for get_court_decision

#### Party & Citation Analysis (2 tools)
14. `count_cases_by_party` - Count cases by party name
15. `get_citation_graph` - Build citation graph between cases

#### Legislation Tools (7 tools)
16. `get_legislation_article` - Get specific legislation article
17. `get_legislation_section` - Get exact fragment by reference
18. `get_legislation_articles` - Get multiple articles at once
19. `search_legislation` - Semantic search for legislation
20. `get_legislation_structure` - Get structure of legislative act
21. `find_relevant_law_articles` - Find articles frequently applied
22. `search_procedural_norms` - Smart search for procedural norms

#### Document Processing (4 tools)
23. `parse_document` - Parse PDF/DOCX/HTML with OCR
24. `extract_key_clauses` - Extract key provisions from contracts
25. `summarize_document` - Create document summary
26. `compare_documents` - Semantic comparison of documents

#### Document Vault Tools (4 tools)
27. `store_document` - Store document with auto-processing
28. `get_document` - Get document from Vault by ID
29. `list_documents` - List documents with filtering
30. `semantic_search` - Semantic search across vault

#### Due Diligence Tools (3 tools)
31. `bulk_review_runner` - Batch document review orchestration
32. `risk_scoring` - Calculate risk scores
33. `generate_dd_report` - Generate formatted DD report

#### Procedural & Calculation (4 tools)
34. `check_precedent_status` - Check precedent validity
35. `calculate_procedural_deadlines` - Deadline calculator
36. `build_procedural_checklist` - Procedural checklist builder
37. `calculate_monetary_claims` - Monetary claims calculator

#### Bulk Operations (2 tools)
38. `load_full_texts` - Load full texts of court decisions
39. `bulk_ingest_court_decisions` - Bulk find and index decisions

#### Advanced Analysis (2 tools)
40. `format_answer_pack` - Structure results in norm/position/conclusion/risks
41. `get_legal_advice` - Comprehensive legal analysis with source validation

## Testing the Connection

### 1. Check Server Status

```bash
curl https://mcp.legal.org.ua/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "secondlayer-mcp-http",
  "version": "1.0.0"
}
```

### 2. Check MCP Discovery

```bash
curl https://mcp.legal.org.ua/mcp
```

Expected response:
```json
{
  "protocolVersion": "2024-11-05",
  "serverInfo": {
    "name": "SecondLayer Legal MCP Server",
    "version": "1.0.0",
    "description": "Ukrainian legal research and document analysis platform"
  },
  "capabilities": {
    "tools": {
      "count": 41,
      "listChanged": false
    }
  },
  "endpoints": {
    "sse": "/sse",
    "http": "/api/tools"
  },
  "tools": [...]
}
```

### 3. Test MCP SSE Connection

```bash
curl -X POST https://mcp.legal.org.ua/sse \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    }
  }'
```

Expected SSE stream:
```
data: {"jsonrpc":"2.0","method":"server/initialized","params":{...}}

data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

### 4. Test Tool Execution

```bash
curl -X POST https://mcp.legal.org.ua/sse \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "search_legislation",
      "arguments": {
        "query": "строки апеляційного оскарження"
      }
    }
  }'
```

## Example Usage in ChatGPT

Once connected, you can use the tools naturally in conversation:

**User**: "Find recent Supreme Court cases about appeal deadlines"

ChatGPT will automatically call:
- `search_supreme_court_practice` with query="строки апеляції"
- `get_court_decision` to retrieve full text
- `analyze_case_pattern` to extract patterns

**User**: "Check article 354 of the Civil Procedure Code"

ChatGPT will call:
- `get_legislation_section` with query="ст. 354 ЦПК"

## Authentication Options

### Option 1: No Authentication (Development)

For development/testing, you can temporarily disable authentication by setting:

```bash
DISABLE_MCP_AUTH=true
```

### Option 2: Bearer Token

1. Get your API key from environment variable `SECONDARY_LAYER_KEYS`
2. Use as Bearer token in ChatGPT configuration

### Option 3: OAuth 2.0 (Recommended for Production)

1. Configure Google OAuth in environment:
```bash
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-secret
GOOGLE_CALLBACK_URL=https://mcp.legal.org.ua/auth/google/callback
```

2. Use OAuth in ChatGPT:
   - Client ID: from `GOOGLE_CLIENT_ID`
   - Client Secret: from `GOOGLE_CLIENT_SECRET`
   - Authorization URL: `https://accounts.google.com/o/oauth2/v2/auth`
   - Token URL: `https://oauth2.googleapis.com/token`

## Nginx Configuration

Make sure your nginx config allows SSE:

```nginx
location /sse {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Accel-Buffering no;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location /mcp {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
}
```

## Troubleshooting

### Connection Issues

1. **Check server is running**:
   ```bash
   curl https://mcp.legal.org.ua/health
   ```

2. **Check nginx logs**:
   ```bash
   tail -f /var/log/nginx/access.log
   tail -f /var/log/nginx/error.log
   ```

3. **Check backend logs**:
   ```bash
   cd /home/vovkes/SecondLayer/mcp_backend
   tail -f logs/combined.log
   ```

### SSE Not Streaming

- Verify nginx has `proxy_buffering off`
- Check `X-Accel-Buffering: no` header is set
- Ensure `Connection: keep-alive` is maintained

### Tools Not Appearing

1. Check tool count:
   ```bash
   curl https://mcp.legal.org.ua/mcp | jq '.capabilities.tools.count'
   ```

2. List all tools:
   ```bash
   curl https://mcp.legal.org.ua/mcp | jq '.tools[].name'
   ```

### Authentication Errors

1. Verify Bearer token:
   ```bash
   curl -H "Authorization: Bearer your-key" \
     https://mcp.legal.org.ua/api/tools
   ```

2. Check OAuth configuration in `.env`

## Cost Tracking

All tool executions are automatically tracked with costs. View in admin panel or query directly:

```sql
SELECT
  tool_name,
  COUNT(*) as executions,
  AVG(total_cost_usd) as avg_cost,
  SUM(total_cost_usd) as total_cost
FROM cost_tracking
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY tool_name
ORDER BY total_cost DESC;
```

## Support

For issues or questions:
- GitHub: https://github.com/anthropics/claude-code/issues
- Email: support@legal.org.ua
- Docs: https://mcp.legal.org.ua/docs

## References

- [OpenAI MCP Documentation](https://platform.openai.com/docs/mcp)
- [Model Context Protocol Spec](https://modelcontextprotocol.io)
- [SecondLayer API Documentation](./CLIENT_INTEGRATION.md)
- [Tool List](../lexconfig/mcp_tools.txt)
