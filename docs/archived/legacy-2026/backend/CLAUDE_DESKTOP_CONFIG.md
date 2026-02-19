# Claude Desktop Configuration for SecondLayer MCP

## ✅ Updated Configuration (Using Local Proxy)

Since Claude Desktop requires a `command` field, we use a local stdio proxy that connects to your remote HTTPS server.

### Configuration File

**File:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "SecondLayerMCP": {
      "command": "node",
      "args": [
        "/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/scripts/mcp-stdio-proxy.js"
      ],
      "env": {
        "MCP_REMOTE_URL": "https://mcp.legal.org.ua",
        "MCP_JWT_TOKEN": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbGF1ZGUtZGVza3RvcCIsImlhdCI6MTc2ODc2NDIxOSwiZXhwIjoxODAwMzAwMjE5LCJpc3MiOiJzZWNvbmRsYXllci1tY3AifQ.r8VbMPM6bLxQjnLIlqUMW8sTIs-Zw_K-KqAgI8WQvEw"
      }
    }
  }
}
```

### How It Works

```
Claude Desktop
    ↓ (stdio/JSON-RPC)
Local Proxy Script (mcp-stdio-proxy.js)
    ↓ (HTTPS with JWT)
Remote MCP Server (https://mcp.legal.org.ua)
    ↓
10 Legal Analysis Tools
```

The local proxy:
- ✅ Speaks MCP protocol via stdio (what Claude Desktop expects)
- ✅ Forwards requests to remote HTTPS API
- ✅ Adds JWT authentication automatically
- ✅ Translates responses back to MCP format

---

## 🧪 Testing the Proxy

Test the proxy script manually:

```bash
cd /Users/vovkes/ZOMCP/SecondLayer/mcp_backend

# Test with a sample request
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node scripts/mcp-stdio-proxy.js

# Should see initialization response
```

---

## 🔄 Alternative: Direct SSE Config (If Supported)

Some newer versions of Claude Desktop may support direct SSE connections. If so, try:

```json
{
  "mcpServers": {
    "SecondLayerMCP": {
      "url": "https://mcp.legal.org.ua/v1/sse",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbGF1ZGUtZGVza3RvcCIsImlhdCI6MTc2ODc2NDIxOSwiZXhwIjoxODAwMzAwMjE5LCJpc3MiOiJzZWNvbmRsYXllci1tY3AifQ.r8VbMPM6bLxQjnLIlqUMW8sTIs-Zw_K-KqAgI8WQvEw"
      },
      "transport": "sse"
    }
  }
}
```

If you get the `command` field required error, stick with the stdio proxy config above.

---

## 📋 Step-by-Step Setup

1. **Open Claude Desktop config:**
   ```bash
   open ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```

2. **Paste the configuration** from the top of this file

3. **Verify the script path** is correct:
   ```bash
   ls -la /Users/vovkes/ZOMCP/SecondLayer/mcp_backend/scripts/mcp-stdio-proxy.js
   ```

4. **Restart Claude Desktop** completely (quit and reopen)

5. **Verify connection** - You should see "SecondLayerMCP" in available tools

---

## 🔍 Troubleshooting

### "Cannot find module 'axios'"

```bash
cd /Users/vovkes/ZOMCP/SecondLayer/mcp_backend
npm install axios
```

### "Command not found: node"

Make sure Node.js is in PATH:
```bash
which node
# Should return: /usr/local/bin/node or similar
```

If not found, use full path in config:
```json
"command": "/usr/local/bin/node"
```

### "ECONNREFUSED" or connection errors

1. Check remote server is running:
   ```bash
   curl https://mcp.legal.org.ua/health
   ```

2. Check JWT token is valid:
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" https://mcp.legal.org.ua/api/tools
   ```

### Check Proxy Logs

Claude Desktop writes logs to `~/Library/Logs/Claude/`:

```bash
tail -f ~/Library/Logs/Claude/mcp*.log
```

Look for lines containing `[MCP Proxy]`

---

## 🎯 Next Steps

1. Copy the config above
2. Paste into `claude_desktop_config.json`
3. Restart Claude Desktop
4. Test: "Use SecondLayerMCP to search for cases about military service"

---

## 📊 Available Tools

Once connected, you'll have access to:

1. search_legal_precedents
2. analyze_case_pattern
3. get_similar_reasoning
4. extract_document_sections
5. count_cases_by_party
6. find_relevant_law_articles
7. check_precedent_status
8. load_full_texts
9. get_citation_graph
10. get_legal_advice

---

**Your remote MCP server is now accessible via Claude Desktop! 🚀**
