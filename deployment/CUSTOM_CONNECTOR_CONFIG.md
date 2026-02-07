# Custom Connector Configuration for Claude AI
## SecondLayer Legal AI - Stage Environment

Generated: 2026-02-07
Environment: Stage (https://stage.legal.org.ua)
MCP Tools: 45 (36 backend + 4 RADA + 5 OpenReyestr)

---

## 📋 User Credentials

```
Email:         vovkes@legal.org.ua
Password:      REDACTED_USER_PASSWORD
User ID:       b30aa26e-b4c5-4965-a69d-38ed12621a8e
Balance:       1000 credits ($1000 USD)
Daily Limit:   $1000
Monthly Limit: $10,000
```

---

## 🔐 OAuth 2.0 Configuration

### OAuth Client Credentials

```
Client ID:      chatgpt_mcp_client
Client Secret:  REDACTED_OAUTH_CLIENT_SECRET
```

### OAuth Endpoints

```
Authorization URL:  https://stage.legal.org.ua/oauth/authorize
Token URL:          https://stage.legal.org.ua/oauth/token
Revoke URL:         https://stage.legal.org.ua/oauth/revoke
Scopes:             mcp
```

### Allowed Redirect URIs

```json
[
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/aip/callback",
  "http://localhost:3000/callback"
]
```

---

## 🌐 MCP Server Configuration

### Remote MCP Server URL (SSE)

```
https://stage.legal.org.ua/sse
```

### Alternative HTTP API Endpoint

```
https://stage.legal.org.ua/api/tools/{toolName}
```

---

## 🛠️ Custom Connector Configuration

### For Anthropic Custom Connector (claude.ai)

Go to: **Settings → Integrations → Custom Integrations**

Click **"Add Integration"** and fill in:

#### Basic Information

```yaml
Name: SecondLayer Legal AI
Description: Ukrainian legal AI with 45 MCP tools for court cases, legislation, Parliament data, and State Register queries
```

#### Server Configuration

```yaml
Server Type: Remote MCP
Protocol: SSE (Server-Sent Events)
Server URL: https://stage.legal.org.ua/sse
```

#### Authentication

```yaml
Authentication Type: OAuth 2.0
OAuth Configuration:
  Client ID: chatgpt_mcp_client
  Client Secret: REDACTED_OAUTH_CLIENT_SECRET
  Authorization URL: https://stage.legal.org.ua/oauth/authorize
  Token URL: https://stage.legal.org.ua/oauth/token
  Scopes: mcp
  Redirect URI: [Auto-configured by Claude]
```

#### Login Credentials (when OAuth flow starts)

```
Email:    vovkes@legal.org.ua
Password: REDACTED_USER_PASSWORD
```

---

## 📦 Available MCP Tools (45 total)

### Main Backend Tools (36)
- `classify_intent` - Classify user query intent
- `search_court_cases` - Search ZakonOnline court database
- `get_document_text` - Retrieve full court decision
- `semantic_search` - Vector similarity search
- `find_legal_patterns` - Pattern matching
- `validate_citations` - Citation verification
- `packaged_lawyer_answer` - Complete legal analysis workflow
- `search_legislation` - Search Ukrainian laws/codes
- `get_legislation_section` - Retrieve specific article/section
- `search_supreme_court_practice` - Search Supreme Court decisions
- And 26 more...

### RADA Tools (4)
- `rada_search_deputies` - Search Parliament deputies
- `rada_get_deputy_profile` - Get deputy profile
- `rada_search_bills` - Search legislative bills
- `rada_search_laws` - Search adopted laws

### OpenReyestr Tools (5)
- `openreyestr_search_entities` - Search business entities
- `openreyestr_get_entity_details` - Get full entity info
- `openreyestr_search_by_edrpou` - Search by tax ID
- `openreyestr_get_beneficiaries` - Get beneficial owners
- `openreyestr_search_by_name` - Search by company name

Complete documentation: https://stage.legal.org.ua/docs/api-explorer.html

---

## 🧪 Testing the Integration

### 1. Test OAuth Flow (Browser)

Visit this URL to test authorization:

```
https://stage.legal.org.ua/oauth/authorize?response_type=code&client_id=chatgpt_mcp_client&redirect_uri=https://chatgpt.com/aip/callback&scope=mcp
```

You should see a login page. Login with:
- Email: `vovkes@legal.org.ua`
- Password: `REDACTED_USER_PASSWORD`

### 2. Test Token Exchange (cURL)

After getting an authorization code from step 1:

```bash
curl -X POST "https://stage.legal.org.ua/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "YOUR_AUTH_CODE_HERE",
    "redirect_uri": "https://chatgpt.com/aip/callback",
    "client_id": "chatgpt_mcp_client",
    "client_secret": "REDACTED_OAUTH_CLIENT_SECRET"
  }'
```

Expected response:
```json
{
  "access_token": "mcp_token_...",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "mcp"
}
```

### 3. Test SSE Connection (cURL)

```bash
curl -N "https://stage.legal.org.ua/sse" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Accept: text/event-stream"
```

Expected: Stream of SSE events with MCP protocol messages

### 4. Test MCP Tool Call

After connecting via SSE, test a simple tool:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search_court_cases",
    "arguments": {
      "query": "позовна давність",
      "limit": 5
    }
  },
  "id": 1
}
```

---

## 📊 Billing & Cost Tracking

### Current Balance Status

```sql
-- Check balance in database
SELECT
  u.email,
  uc.balance as credits,
  ub.balance_usd,
  ub.daily_limit_usd,
  ub.monthly_limit_usd,
  ub.total_spent_usd
FROM users u
JOIN user_credits uc ON u.id = uc.user_id
JOIN user_billing ub ON u.id = ub.user_id
WHERE u.email = 'vovkes@legal.org.ua';
```

### Cost per Tool

| Tool Category | Cost (Credits) | USD Equivalent |
|--------------|----------------|----------------|
| Simple Search | 1 | $1.00 |
| Document Retrieval | 1 | $1.00 |
| Pattern Matching | 2 | $2.00 |
| Legal Analysis | 3 | $3.00 |

Your $1000 balance allows for:
- 1000+ simple searches
- 500+ pattern matching operations
- 333+ complete legal analysis workflows

---

## 🔒 Security Notes

⚠️ **IMPORTANT: Keep these credentials secure!**

- Client Secret cannot be retrieved later (only reset)
- OAuth tokens expire after 30 days
- Change password in production environment
- Store credentials in secure password manager

---

## 🚀 Quick Start Guide

1. **Add Custom Integration in Claude**
   - Go to Settings → Integrations → Custom Integrations
   - Click "Add Integration"
   - Choose "Remote MCP Server"

2. **Configure Server**
   - Name: `SecondLayer Legal AI`
   - URL: `https://stage.legal.org.ua/sse`
   - Auth: `OAuth 2.0`

3. **Enter OAuth Credentials**
   - Client ID: `chatgpt_mcp_client`
   - Client Secret: `REDACTED_OAUTH_CLIENT_SECRET`
   - Authorization URL: `https://stage.legal.org.ua/oauth/authorize`
   - Token URL: `https://stage.legal.org.ua/oauth/token`
   - Scopes: `mcp`

4. **Authorize**
   - Click "Connect"
   - Login with `vovkes@legal.org.ua` / `REDACTED_USER_PASSWORD`
   - Grant permissions

5. **Start Using Tools**
   - In Claude chat: "Search for court cases about statute of limitations"
   - Claude will automatically use `search_court_cases` tool

---

## 📞 Support & Documentation

- **API Explorer**: https://stage.legal.org.ua/docs/api-explorer.html
- **Full Documentation**: `/home/vovkes/SecondLayer/docs/`
- **MCP Tools Guide**: `/home/vovkes/SecondLayer/docs/ALL_MCP_TOOLS.md`
- **Integration Guide**: `/home/vovkes/SecondLayer/docs/MCP_CLIENT_INTEGRATION_GUIDE.md`

---

## 🎉 You're Ready!

Your account is configured and ready to use with:
- ✅ User created: vovkes@legal.org.ua
- ✅ Balance added: 1000 credits ($1000)
- ✅ OAuth configured: chatgpt_mcp_client
- ✅ MCP server ready: https://stage.legal.org.ua/sse
- ✅ 45 tools available: All legal AI tools

**Next Step**: Add the custom integration in Claude and start using legal AI tools!

---

*Generated on: 2026-02-07 02:35 UTC*
*Environment: Stage (https://stage.legal.org.ua)*
*MCP Protocol: SSE (Server-Sent Events)*
