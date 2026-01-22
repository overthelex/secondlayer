# MCP Client Configuration for SecondLayer

## Valid MCP Server Configurations

### Option 1: Using Old MCP Domain (Recommended for MCP Clients)

```json
{
  "mcpServers": {
    "SecondLayerMCP": {
      "url": "https://mcp.legal.org.ua/v1/sse",
      "headers": {
        "Authorization": "Bearer c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4"
      }
    }
  }
}
```

### Option 2: Using New Domain with Tool-Specific Streaming

```json
{
  "mcpServers": {
    "SecondLayerMCP": {
      "url": "https://legal.org.ua/api/tools/get_legal_advice/stream",
      "headers": {
        "Authorization": "Bearer c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4"
      }
    }
  }
}
```

## Available API Keys

From `mcp_backend/.env`:

```bash
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456,c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4
```

**Valid API Keys**:
- `test-key-123` (development)
- `dev-key-456` (development)
- `c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4` (production)

## Authentication Types

### API Keys (for MCP Clients) ✅
- **Use case**: Claude Desktop, MCP clients, automated tools
- **Format**: Plain string (no dots)
- **Example**: `Bearer c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4`
- **Expiry**: Never expires
- **Access**: MCP tools only (`/api/tools/*`)

### JWT Tokens (for Users) ❌ Don't use for MCP clients!
- **Use case**: Web browser users (Google OAuth)
- **Format**: JWT with dots (header.payload.signature)
- **Example**: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
- **Expiry**: 7 days
- **Access**: Admin panel (`/api/documents`, `/api/patterns`, etc.)

## Why Your Config Was Invalid

Your configuration had:
```json
{
  "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbGF1ZGUtZGVza3RvcCIsImlhdCI6MTc2ODc2NDIxOSwiZXhwIjoxODAwMzAwMjE5LCJpc3MiOiJzZWNvbmRsYXllci1tY3AifQ.r8VbMPM6bLxQjnLIlqUMW8sTIs-Zw_K-KqAgI8WQvEw"
}
```

**Issues**:
1. ❌ **JWT token instead of API key** - MCP clients should use API keys
2. ❌ **Endpoint might be wrong** - Depends on which SSE endpoint is active

## Testing Your Configuration

### Test 1: Verify Endpoint Exists

```bash
# Test old MCP endpoint
curl -I https://mcp.legal.org.ua/v1/sse

# Test new tool streaming endpoint
curl -I https://legal.org.ua/api/tools/get_legal_advice/stream
```

### Test 2: Test Authentication with API Key

```bash
# Test with valid API key
curl -X POST https://legal.org.ua/api/tools/get_legal_advice \
  -H "Authorization: Bearer c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Test query",
    "reasoning_budget": "standard"
  }'
```

Expected response: `200 OK` with tool response

### Test 3: Test with JWT Token (Should Fail for Tools)

```bash
# Test with JWT token (your current token)
curl -X POST https://legal.org.ua/api/tools/get_legal_advice \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Test query"
  }'
```

Expected result: Might work if dual auth is enabled, but API keys are recommended

## Claude Desktop Configuration

For **Claude Desktop** (claude_desktop_config.json):

```json
{
  "mcpServers": {
    "secondlayer": {
      "command": "node",
      "args": [
        "/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/dist/index.js"
      ],
      "env": {
        "DATABASE_URL": "postgresql://secondlayer:secondlayer_password@localhost:5432/secondlayer_db",
        "QDRANT_URL": "http://localhost:6333",
        "REDIS_URL": "redis://localhost:6379",
        "OPENAI_API_KEY": "sk-proj-...",
        "ZAKONONLINE_API_TOKEN": "E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B"
      }
    }
  }
}
```

**OR** for remote SSE connection:

```json
{
  "mcpServers": {
    "secondlayer-remote": {
      "url": "https://mcp.legal.org.ua/v1/sse",
      "headers": {
        "Authorization": "Bearer c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4"
      }
    }
  }
}
```

## Verification Checklist

- [ ] Using **API key** (not JWT token) for MCP clients
- [ ] Correct endpoint URL (check which SSE endpoint is active)
- [ ] API key is in `SECONDARY_LAYER_KEYS` list
- [ ] Header format: `Authorization: Bearer <api-key>`
- [ ] Test with curl before using in MCP client

## Common Errors

### Error: "Invalid token"
**Cause**: Using JWT token instead of API key
**Fix**: Replace JWT with API key from `SECONDARY_LAYER_KEYS`

### Error: "404 Not Found"
**Cause**: Wrong endpoint URL
**Fix**: Check if `/v1/sse` or `/api/tools/*/stream` is the correct endpoint

### Error: "401 Unauthorized"
**Cause**: API key not in allowed list
**Fix**: Verify API key exists in `mcp_backend/.env` `SECONDARY_LAYER_KEYS`

## Generating New API Keys

If you need a new API key:

```bash
# Generate random API key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Add to mcp_backend/.env
SECONDARY_LAYER_KEYS=test-key-123,dev-key-456,<new-key>

# Restart backend
pm2 restart secondlayer
```

## Summary

**Use this for MCP clients**:
```json
{
  "mcpServers": {
    "SecondLayerMCP": {
      "url": "https://mcp.legal.org.ua/v1/sse",
      "headers": {
        "Authorization": "Bearer c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4"
      }
    }
  }
}
```

**Key points**:
- ✅ Use **API keys** for MCP clients
- ✅ Use **JWT tokens** for web browser users (OAuth2)
- ✅ API keys never expire
- ✅ JWT tokens expire in 7 days
