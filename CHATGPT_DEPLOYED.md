# ChatGPT Web Integration - Deployed

## Deployment Status: ✅ COMPLETE

The SecondLayer MCP backend has been successfully deployed to the production server with full ChatGPT web integration support.

---

## Server Information

**MCP Server URL:** `https://mcp.legal.org.ua/sse`

**Discovery Endpoint:** `https://mcp.legal.org.ua/mcp`

**Health Check:** `https://mcp.legal.org.ua/health`

**Protocol Version:** `MCP 2024-11-05`

**Available Tools:** 34 legal research tools

---

## ChatGPT Configuration

### Step 1: Add Custom MCP Server in ChatGPT

1. Go to ChatGPT web interface (https://chatgpt.com)
2. Open Settings → Beta Features
3. Enable "Model Context Protocol (MCP)" if not already enabled
4. Go to Settings → MCP Servers
5. Click "Add Server"

### Step 2: Configure Server Details

**Server Name:** `SecondLayer Legal Ukraine`

**Server URL:** `https://mcp.legal.org.ua/sse`

**Authentication Type:** `Bearer Token`

**Bearer Token:** Use one of these production API keys:
- `REDACTED_SL_KEY_PROD_1`
- `REDACTED_SL_KEY_PROD_2`

### Step 3: Verify Connection

After adding the server, ChatGPT will:
1. Connect to `https://mcp.legal.org.ua/sse`
2. Authenticate using the Bearer token
3. Receive the list of 34 available tools
4. Display them in the Tools panel

---

## Available Tools (34)

### Query Classification & Planning
- `classify_intent` - Classify user query intent
- `retrieve_legal_sources` - Retrieve relevant legal sources
- `analyze_legal_patterns` - Analyze legal patterns
- `validate_response` - Validate AI response against sources

### Court Cases & Precedents
- `search_legal_precedents` - Search court precedents
- `analyze_case_pattern` - Analyze case patterns
- `get_similar_reasoning` - Find similar legal reasoning
- `extract_document_sections` - Extract specific document sections
- `count_cases_by_party` - Count cases by party name
- `find_relevant_law_articles` - Find relevant law articles
- `check_precedent_status` - Check precedent status
- `load_full_texts` - Load full text of documents
- `get_court_decision` - Get specific court decision
- `get_case_text` - Get case text content

### Legal Analysis
- `bulk_ingest_court_decisions` - Bulk ingest court decisions
- `get_citation_graph` - Get citation graph
- `search_procedural_norms` - Search procedural norms
- `search_supreme_court_practice` - Search Supreme Court practice
- `compare_practice_pro_contra` - Compare practice pro/contra
- `find_similar_fact_pattern_cases` - Find cases with similar facts

### Legislation
- `search_legislation` - Search Ukrainian legislation
- `get_legislation_section` - Get specific legislation section
- `get_legislation_article` - Get specific article
- `find_law_by_alias` - Find law by common name

### Document Analysis
- `analyze_uploaded_document` - Analyze uploaded legal documents
- `extract_key_provisions` - Extract key provisions
- `identify_legal_issues` - Identify legal issues in document
- `generate_document_summary` - Generate document summary

### Complete Workflows
- `packaged_lawyer_answer` - Complete legal analysis workflow
- `get_legal_advice` - Get comprehensive legal advice
- `research_legal_question` - Research legal question
- `validate_citations` - Validate legal citations

### Cost Tracking
- `track_usage_cost` - Track API usage and costs
- `get_monthly_usage` - Get monthly usage statistics

---

## Testing the Integration

### Test 1: Health Check
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

### Test 2: MCP Discovery
```bash
curl https://mcp.legal.org.ua/mcp
```

Expected response includes:
- Server info
- Protocol version (2024-11-05)
- List of 34 tools with descriptions

### Test 3: SSE Connection
```bash
curl -X POST https://mcp.legal.org.ua/sse \
  -H "Authorization: Bearer REDACTED_SL_KEY_PROD_1" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream"
```

Expected: SSE stream with server initialization message

---

## Architecture

### Components Deployed

1. **Backend Application**
   - Container: `secondlayer-app-prod`
   - Port: 3001
   - Image: `secondlayer-app:latest`
   - Status: ✅ Running

2. **PostgreSQL Database**
   - Container: `secondlayer-postgres-prod`
   - Port: 5432
   - Database: `secondlayer_prod`
   - Status: ✅ Running

3. **Redis Cache**
   - Container: `secondlayer-redis-prod`
   - Port: 6379
   - Status: ✅ Running

4. **Qdrant Vector DB**
   - Container: `secondlayer-qdrant-prod`
   - Ports: 6333-6334
   - Status: ✅ Running

5. **Nginx Reverse Proxy**
   - Domain: mcp.legal.org.ua
   - SSL: Let's Encrypt
   - SSE Support: ✅ Configured

### MCP Protocol Flow

```
ChatGPT → HTTPS → Nginx (mcp.legal.org.ua) → Backend (port 3001) → MCP SSE Server
                                                                      ↓
                                                    Tools: MCPQueryAPI + LegislationTools + DocumentAnalysisTools
                                                                      ↓
                                                    Services: ZakonOnline + RADA + OpenAI + Anthropic
```

---

## Environment Configuration

All production settings configured in `/home/vovkes/SecondLayer/deployment/.env.prod`:

### Database
- Database: `secondlayer_prod`
- User: `secondlayer`
- Strong password configured

### AI Models
- OpenAI: GPT-4o, GPT-4o-mini
- Anthropic: Claude Opus 4.5, Sonnet 4.5, Haiku 4.5
- Provider Strategy: `openai-first`

### External APIs
- ZakonOnline: 2 API tokens configured
- Verkhovna Rada: Open Data API

### Security
- JWT Secret: Production secret configured
- API Keys: 2 production keys for access
- Google OAuth: Configured for https://legal.org.ua
- CORS: Allows https://legal.org.ua and https://chatgpt.com

---

## Monitoring

### Check Container Status
```bash
ssh vovkes@gate.lexapp.co.ua "docker ps --filter 'name=secondlayer-'"
```

### View Application Logs
```bash
ssh vovkes@gate.lexapp.co.ua "docker logs secondlayer-app-prod -f"
```

### View Nginx Logs
```bash
ssh vovkes@gate.lexapp.co.ua "sudo tail -f /var/log/nginx/mcp.legal.org.ua.access.log"
```

### Check Database
```bash
ssh vovkes@gate.lexapp.co.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -c 'SELECT version();'"
```

---

## Next Steps

1. **Add Server in ChatGPT**
   - Follow configuration steps above
   - Use one of the production API keys

2. **Test Tools in ChatGPT**
   - Ask: "Search for Ukrainian court cases about labor disputes"
   - Ask: "What does Constitution Article 124 say?"
   - Ask: "Analyze this legal document" (upload PDF)

3. **Monitor Usage**
   - Check logs for requests
   - Monitor API costs in database (`cost_tracking` table)
   - Check monthly usage stats

4. **Documentation**
   - Full integration guide: `/home/vovkes/SecondLayer/mcp_backend/CHATGPT_SETUP_INSTRUCTIONS.md`
   - Quick start: `/home/vovkes/SecondLayer/mcp_backend/CHATGPT_QUICKSTART.md`
   - Examples: `/home/vovkes/SecondLayer/mcp_backend/EXAMPLES_CHATGPT.md`

---

## Troubleshooting

### ChatGPT Can't Connect

1. Check server health: `curl https://mcp.legal.org.ua/health`
2. Verify API key is correct
3. Check nginx logs: `sudo tail /var/log/nginx/mcp.legal.org.ua.error.log`
4. Check container: `docker logs secondlayer-app-prod --tail 50`

### Tools Not Showing

1. Check MCP discovery: `curl https://mcp.legal.org.ua/mcp | jq '.tools | length'`
2. Should show 34 tools
3. If not, check application logs

### Authentication Errors

1. Verify Bearer token format: `Authorization: Bearer <API_KEY>`
2. Check that API key is in `.env.prod` SECONDARY_LAYER_KEYS
3. Try alternate production key

---

## Contact & Support

- Server: gate.lexapp.co.ua
- User: vovkes
- Working Directory: /home/vovkes/SecondLayer
- Deployment Directory: /home/vovkes/SecondLayer/deployment

---

**Status:** ✅ DEPLOYED AND READY FOR CHATGPT INTEGRATION

**Date:** January 27, 2026

**Last Update:** January 27, 2026 21:40 CET - Fixed SSE Content-Type header

**Deployment verified and tested successfully.**

---

## Recent Updates

### January 27, 2026 21:40 CET - SSE Content-Type Fix

**Issue:** ChatGPT reported: "Expected response header Content-Type to contain 'text/event-stream', got 'application/json'"

**Root Cause:** Express `express.json()` middleware was applying to all routes including `/sse`, setting default Content-Type to `application/json`

**Fix Applied:**
- Modified `mcp_backend/src/http-server.ts` to set SSE headers explicitly in the route handler BEFORE calling `handleSSEConnection`
- Headers now set correctly: `Content-Type: text/event-stream`
- Rebuilt Docker image and redeployed to production

**Verification:**
```bash
curl -X POST https://mcp.legal.org.ua/sse \
  -H "Authorization: Bearer REDACTED_SL_KEY_PROD_1" \
  -H "Accept: text/event-stream"

# Response headers:
# content-type: text/event-stream ✅
# cache-control: no-cache, no-transform
# connection: keep-alive
```

**Status:** ✅ RESOLVED - SSE endpoint now returns correct Content-Type
