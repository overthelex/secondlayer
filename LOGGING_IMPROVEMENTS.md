# MCP Tools Logging Improvements

## Overview
Added comprehensive info-level logging to all MCP tools to track tool usage, execution, and performance.

## Changes Made

### 1. Main MCP Query API (`mcp_backend/src/api/mcp-query-api.ts`)

#### Enhanced `handleToolCall` method:
- **Start logging**: Logs tool name when execution begins
- **Duration tracking**: Measures execution time in milliseconds
- **Completion logging**: Logs successful completion with duration
- **Error logging**: Enhanced error logs with tool name and duration

**Log format:**
```
[MCP] Tool call initiated { toolName: 'search_supreme_court_practice' }
[MCP] Tool call completed { toolName: 'search_supreme_court_practice', durationMs: 1234 }
[MCP] Tool call failed { toolName: 'get_court_decision', durationMs: 567, error: '...' }
```

#### Individual tool methods enhanced:
- `classify_intent` - Logs query (first 100 chars) and budget level
- `search_supreme_court_practice` - Logs procedure code, query, limit, court level, section focus
- `get_court_decision` - Logs doc ID, case number, depth, budget
- `get_legal_advice` - Logs query, budget, and context presence

**Example:**
```
[MCP Tool] classify_intent started { query: 'Чи можна оскаржити...', budget: 'standard' }
[MCP Tool] search_supreme_court_practice started { procedureCode: 'cpc', query: 'строк апеляції...', limit: 10, courtLevel: 'SC', sectionFocus: ['COURT_REASONING'] }
[MCP Tool] get_court_decision started { docId: 123456, caseNumber: '', depth: 2, budget: 'standard' }
[MCP Tool] get_legal_advice started { query: 'Як розрахувати строк...', budget: 'standard', hasAdditionalContext: false }
```

### 2. Legislation Tools (`mcp_backend/src/api/legislation-tools.ts`)

Enhanced logging for:
- `get_legislation_article` - Logs RADA ID, article number, HTML inclusion
- `get_legislation_section` - Logs resolved RADA ID, article, query origin
- `get_legislation_articles` - Logs RADA ID, article count, article list
- `search_legislation` - Logs search query and limit

**Example:**
```
[MCP Tool] get_legislation_article started { rada_id: '1618-15', article_number: '625', include_html: true }
[MCP Tool] get_legislation_section started { rada_id: '435-15', article_number: '124', from_query: true, query: 'ст. 124 Конституції' }
[MCP Tool] search_legislation started { query: 'строк позовної давності', limit: 10 }
```

### 3. Document Analysis Tools (`mcp_backend/src/api/document-analysis-tools.ts`)

Enhanced logging for:
- `parse_document` - Logs filename, MIME type, file size
- `extract_key_clauses` - Logs text length, document ID, clause count, risk count
- `summarize_document` - Logs text length, detail level, summary stats
- `compare_documents` - Logs document lengths, change counts by importance

**Example:**
```
[MCP Tool] parse_document started { filename: 'contract.pdf', mimeType: 'application/pdf', sizeBytes: 524288 }
[MCP Tool] parse_document completed { textLength: 45123, pageCount: 12, source: 'pdf-native' }

[MCP Tool] extract_key_clauses started { textLength: 45123, documentId: 'doc_123' }
[MCP Tool] extract_key_clauses completed { clauseCount: 15, highRiskCount: 2 }

[MCP Tool] summarize_document started { textLength: 45123, detailLevel: 'deep' }
[MCP Tool] summarize_document completed { executiveLength: 512, partiesCount: 2, datesCount: 5 }

[MCP Tool] compare_documents started { oldLength: 45123, newLength: 46890 }
[MCP Tool] compare_documents completed { totalChanges: 23, criticalChanges: 3, significantChanges: 7 }
```

## Benefits

1. **Monitoring**: Easy to track which tools are being used and how often
2. **Performance**: Duration metrics help identify slow operations
3. **Debugging**: Detailed parameter logging aids in troubleshooting
4. **Analytics**: Can aggregate logs to understand usage patterns
5. **Audit Trail**: Complete record of tool executions for compliance

## Log Filtering

To filter MCP tool logs:

```bash
# All MCP tool activity
grep "\[MCP" logs/app.log

# Specific tool
grep "\[MCP Tool\] search_supreme_court_practice" logs/app.log

# Tool completions only
grep "\[MCP Tool\].*completed" logs/app.log

# Failed tools
grep "\[MCP\] Tool call failed" logs/app.log

# Performance (tools > 5 seconds)
grep "durationMs" logs/app.log | awk '$NF > 5000'
```

## Testing

To verify logging works:

```bash
# Start backend
cd mcp_backend
npm run dev:http

# In another terminal, call a tool
curl -X POST http://localhost:3000/api/tools/classify_intent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"query":"Чи можна оскаржити рішення?"}'

# Check logs
docker logs secondlayer-app-dev | grep "\[MCP"
```

Expected output:
```
[MCP] Tool call initiated { toolName: 'classify_intent' }
[MCP Tool] classify_intent started { query: 'Чи можна оскаржити рішення?', budget: 'standard' }
[MCP] Tool call completed { toolName: 'classify_intent', durationMs: 234 }
```
