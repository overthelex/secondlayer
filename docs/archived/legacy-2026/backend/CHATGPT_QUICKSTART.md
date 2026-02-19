# ChatGPT Integration - Quick Start

5-minute guide to connect SecondLayer MCP server to ChatGPT.

## Prerequisites

✅ Server running at `https://mcp.legal.org.ua`
✅ SSL certificate configured
✅ Backend running on port 3000

## Step 1: Verify Server (1 min)

Test health check:
```bash
curl https://mcp.legal.org.ua/health
```

Should return:
```json
{"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}
```

Test MCP discovery:
```bash
curl https://mcp.legal.org.ua/mcp | jq '.capabilities.tools.count'
```

Should return: `41` (number of available tools)

## Step 2: Configure ChatGPT (2 min)

1. Open [ChatGPT](https://chat.openai.com)
2. Go to Settings → Beta Features → Enable "Developer Mode"
3. Click **"New App"** button
4. Fill in the form:

```
┌─────────────────────────────────────────────────┐
│ Icon: [+] (optional)                            │
│                                                 │
│ Name:                                           │
│ SecondLayer Legal Research                      │
│                                                 │
│ Description:                                    │
│ Ukrainian legal research and document analysis  │
│ platform with 40+ specialized tools for court   │
│ cases, legislation, and legal patterns          │
│                                                 │
│ MCP Server URL:                                 │
│ https://mcp.legal.org.ua/sse                    │
│                                                 │
│ Authentication:                                 │
│ [x] OAuth                                       │
│                                                 │
│ OAuth Client ID (Optional):                     │
│ [leave empty for now]                           │
│                                                 │
│ OAuth Client Secret (Optional):                 │
│ [leave empty for now]                           │
│                                                 │
│ [✓] I understand and want to continue           │
└─────────────────────────────────────────────────┘

[Create]  [Cancel]
```

5. Click **"Create"**

## Step 3: Test Integration (2 min)

Start a new chat and try:

### Test 1: Simple legislation query
```
Check article 354 of the Civil Procedure Code of Ukraine
```

ChatGPT should call `get_legislation_section` and return the article text.

### Test 2: Court case search
```
Find recent Supreme Court cases about appeal deadlines
```

ChatGPT should call `search_supreme_court_practice` and return relevant cases.

### Test 3: Legal analysis
```
What are the grounds for restoring a missed appeal deadline?
```

ChatGPT should call multiple tools:
- `search_legislation`
- `search_legal_precedents`
- `analyze_case_pattern`

## Available Tools (41 total)

### Most Useful for ChatGPT:

1. **`get_legislation_section`** - Get specific legislation articles
   ```
   Example: "Show me article 354 ЦПК"
   ```

2. **`search_legal_precedents`** - Search court cases
   ```
   Example: "Find cases about appeal deadlines"
   ```

3. **`search_supreme_court_practice`** - Supreme Court practice
   ```
   Example: "What does Supreme Court say about procedural violations?"
   ```

4. **`get_court_decision`** - Get full court decision text
   ```
   Example: "Load case 756/655/23"
   ```

5. **`analyze_case_pattern`** - Analyze legal patterns
   ```
   Example: "What are success factors in appeal restoration?"
   ```

6. **`get_legal_advice`** - Comprehensive legal analysis
   ```
   Example: "I missed the appeal deadline, what can I do?"
   ```

See [CHATGPT_INTEGRATION.md](docs/CHATGPT_INTEGRATION.md) for full list of 41 tools.

## Troubleshooting

### ❌ "Server not responding"

Check health:
```bash
curl https://mcp.legal.org.ua/health
```

Check nginx:
```bash
sudo systemctl status nginx
sudo nginx -t
```

Check backend:
```bash
pm2 status
pm2 logs mcp-backend --lines 50
```

### ❌ "Tools not appearing"

Verify tool count:
```bash
curl https://mcp.legal.org.ua/mcp | jq '.capabilities.tools.count'
```

Should be `41`. If `0`, check backend logs:
```bash
pm2 logs mcp-backend | grep "MCP SSE Server initialized"
```

### ❌ "Authentication failed"

For testing, you can disable auth temporarily:
```bash
# Add to .env
echo "DISABLE_MCP_AUTH=true" >> .env

# Restart
pm2 restart mcp-backend
```

For production, set up OAuth or Bearer token - see [DEPLOYMENT_CHATGPT.md](docs/DEPLOYMENT_CHATGPT.md).

## What's Next?

- 📖 Full documentation: [CHATGPT_INTEGRATION.md](docs/CHATGPT_INTEGRATION.md)
- 🚀 Deployment guide: [DEPLOYMENT_CHATGPT.md](docs/DEPLOYMENT_CHATGPT.md)
- 🛠️ All 41 tools: [lexconfig/mcp_tools.txt](../lexconfig/mcp_tools.txt)
- 📊 Monitor usage: Check `cost_tracking` table in PostgreSQL

## Support

- Logs: `pm2 logs mcp-backend`
- Health: `https://mcp.legal.org.ua/health`
- Discovery: `https://mcp.legal.org.ua/mcp`
- Issues: GitHub issues or contact admin

---

✨ **You're all set!** ChatGPT can now access Ukrainian legal research tools.
