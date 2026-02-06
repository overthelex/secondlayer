# ChatGPT Web MCP Configuration for igor@legal.org.ua

## User Details
- **Email**: igor@legal.org.ua
- **Environment**: Stage (mail.lexapp.co.ua)
- **Balance**: $100.00 USD
- **Daily Limit**: $50.00
- **Monthly Limit**: $500.00
- **Pricing Tier**: Startup (10% markup)

---

## ChatGPT Web MCP Configuration

### Option 1: OAuth Authentication (Recommended)

Use this configuration in ChatGPT Web "New App" dialog:

```
Name: SecondLayer Legal AI (Stage)

Description (optional):
Ukrainian legal document analysis with 43 MCP tools: court cases search, legislation lookup, semantic analysis, document parsing, Parliament data (deputies, bills), and State Register queries (businesses, beneficiaries).

MCP Server URL:
https://stage.legal.org.ua/sse

Authentication: OAuth

OAuth Configuration:
  Client ID: REDACTED_GOOGLE_CLIENT_ID
  Client Secret: REDACTED_GOOGLE_CLIENT_SECRET
  Authorization URL: https://stage.legal.org.ua/auth/google
  Token URL: https://stage.legal.org.ua/auth/google/callback
  Scope: openid email profile
```

**Login Credentials**:
- Email: igor@legal.org.ua
- Use your Google account password

---

### Option 2: Bearer Token Authentication (Alternative)

If OAuth doesn't work, use Bearer token authentication:

```
Name: SecondLayer Legal AI (Stage)

Description (optional):
Ukrainian legal document analysis with 43 MCP tools

MCP Server URL:
https://stage.legal.org.ua/sse

Authentication: Custom

Header Name: Authorization
Header Value: Bearer REDACTED_SL_KEY_STAGE_OLD
```

**Alternative Tokens** (any will work):
- `Bearer REDACTED_SL_KEY_STAGE_OLD`
- `Bearer test-key-123`

---

## Available MCP Tools (43 total)

### Main Backend (34 tools)
- **Court Cases**: `search_court_cases`, `get_document_text`, `get_court_case_metadata`
- **Semantic Search**: `semantic_search`, `find_similar_cases`, `compare_documents`
- **Legal Analysis**: `packaged_lawyer_answer`, `validate_citations`, `find_legal_patterns`
- **Legislation**: `search_legislation`, `get_legislation_section`, `parse_legal_reference`
- **Document Processing**: `extract_text_from_image`, `analyze_document_structure`
- **And 20+ more tools...

### Parliament Data - RADA (4 tools)
- `rada_search_deputies` - Search Ukrainian Parliament deputies
- `rada_get_deputy_info` - Get detailed deputy information
- `rada_search_bills` - Search legislative bills
- `rada_get_law_text` - Get legislation full text

### State Register - OpenReyestr (5 tools)
- `openreyestr_search_entities` - Search businesses by name/EDRPOU
- `openreyestr_get_entity_details` - Get company details
- `openreyestr_find_beneficiaries` - Find ultimate beneficial owners
- `openreyestr_search_by_person` - Search companies by person name
- `openreyestr_get_statistics` - Registry statistics

---

## Testing the Connection

### 1. Test Health Endpoint

```bash
curl -X GET "https://stage.legal.org.ua/health" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD"
```

**Expected Response**:
```json
{
  "status": "ok",
  "version": "2.0.0",
  "environment": "staging",
  "timestamp": "2026-02-06T..."
}
```

### 2. Test SSE Connection

```bash
curl -N -X GET "https://stage.legal.org.ua/sse" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD" \
  -H "Accept: text/event-stream"
```

**Expected Output**:
```
event: endpoint
data: /message

event: message
data: {"role":"assistant","content":"SecondLayer MCP Server connected"}
```

### 3. Test MCP Tool Call

```bash
curl -X POST "https://stage.legal.org.ua/api/tools/search_court_cases" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "цивільна справа позов"
  }'
```

### 4. Test Billing Status

```bash
curl -X GET "https://stage.legal.org.ua/api/user/billing" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD"
```

**Expected Response**:
```json
{
  "email": "igor@legal.org.ua",
  "balance_usd": 100.00,
  "daily_limit_usd": 50.00,
  "monthly_limit_usd": 500.00,
  "today_spent_usd": 0.00,
  "month_spent_usd": 0.00,
  "pricing_tier": "startup"
}
```

---

## Pricing Information

### Startup Tier (Current)
- **Base Cost**: OpenAI/Anthropic actual cost
- **Markup**: 10%
- **Example**: $0.10 OpenAI cost → $0.11 charged to you

### Estimated Costs per Request
- Simple query (classification): ~$0.001 - $0.005
- Court case search: ~$0.01 - $0.03
- Full legal analysis: ~$0.05 - $0.15
- Document parsing with OCR: ~$0.10 - $0.30

### Cost Tracking
All requests are tracked in real-time. Check your spending:
```bash
curl -X GET "https://stage.legal.org.ua/api/user/transactions" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD"
```

---

## Executing SQL Script on Remote Server

To create the user on stage environment (if not already done):

```bash
# SSH to stage server
ssh user@mail.lexapp.co.ua

# Navigate to deployment directory
cd /path/to/SecondLayer/deployment

# Execute SQL script in stage PostgreSQL container
docker exec -i secondlayer-postgres-stage psql \
  -U secondlayer \
  -d secondlayer_stage \
  -f create-igor-user-stage-remote.sql

# Or copy and paste SQL directly:
docker exec -i secondlayer-postgres-stage psql \
  -U secondlayer \
  -d secondlayer_stage < create-igor-user-stage-remote.sql
```

---

## Troubleshooting

### Issue: "Unauthorized" or "Invalid API Key"
**Solution**: Verify token format:
- Must start with `Bearer` (with space)
- Use: `Bearer REDACTED_SL_KEY_STAGE_OLD`
- NOT: `REDACTED_SL_KEY_STAGE_OLD` (missing Bearer)

### Issue: OAuth redirect fails
**Solution**: Ensure callback URL matches exactly:
- Must be: `https://stage.legal.org.ua/auth/google/callback`
- Check CORS settings allow your domain

### Issue: "Insufficient balance"
**Solution**: Check current balance:
```bash
curl -X GET "https://stage.legal.org.ua/api/user/billing" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD"
```

### Issue: SSE connection drops
**Solution**:
- Check firewall allows long-lived connections
- Verify nginx timeout settings (should be 3600s for stage)
- Use HTTP/2 if possible

---

## Support & Documentation

- **Full API Docs**: `/home/vovkes/SecondLayer/docs/ALL_MCP_TOOLS.md`
- **Integration Guide**: `/home/vovkes/SecondLayer/docs/MCP_CLIENT_INTEGRATION_GUIDE.md`
- **Deployment Docs**: `/home/vovkes/SecondLayer/deployment/DEPLOYMENT_CHATGPT.md`
- **Interactive Explorer**: Open `mcp_backend/docs/api-explorer.html` in browser

---

## Summary Checklist

- ✅ User `igor@legal.org.ua` created with $100 balance
- ✅ Daily limit: $50, Monthly limit: $500
- ✅ Pricing tier: Startup (10% markup)
- ✅ Two authentication methods available:
  - OAuth (Google): `igor@legal.org.ua`
  - Bearer token: `REDACTED_SL_KEY_STAGE_OLD`
- ✅ Stage MCP endpoint: `https://stage.legal.org.ua/sse`
- ✅ 43 MCP tools available (backend + RADA + OpenReyestr)

**Configuration ready for ChatGPT Web!** 🚀
