# MCP Tools User Interface

**Date:** 2026-01-21
**Status:** ✅ Deployed
**Environment:** Development (dev.legal.org.ua)

---

## Overview

Replaced the "Court Decisions Search" page with a comprehensive **MCP Tools Interface** that allows users to discover and execute all available MCP (Model Context Protocol) tools directly from the web interface.

---

## What Changed

### Previous Implementation
- **Page:** "Пошук судових рішень" (Court Decisions Search)
- **Functionality:** Specialized search for Ukrainian court decisions via Zakononline API
- **Icon:** Gavel (⚖️)
- **Limitation:** Single-purpose tool, not extensible

### New Implementation
- **Page:** "MCP Інструменти" (MCP Tools)
- **Functionality:** Universal interface for ALL MCP tools
- **Icon:** Settings (⚙️)
- **Features:**
  - 📋 List all available MCP tools
  - 🔍 Search/filter tools by name or description
  - ⚡ Execute any tool with custom parameters
  - 📊 View execution results with JSON formatting
  - 📈 Track execution history with timestamps
  - ⏱️ Display execution time for each call

---

## User Interface

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  MCP Інструменти                               [Close]  │
├──────────────┬──────────────────────────────────────────┤
│              │                                          │
│  Tools List  │  Selected Tool Details & Execution      │
│  (Left 1/3)  │  (Right 2/3)                            │
│              │                                          │
│  [Search]    │  Tool Name & Description                │
│              │  ─────────────────────────────          │
│  Tool 1      │  Parameters Form                        │
│  Tool 2 ✓    │  - param1: [input]                      │
│  Tool 3      │  - param2: [select]                     │
│  ...         │  - param3: [checkbox]                   │
│              │                                          │
│              │  [Execute Button]                       │
│              │                                          │
│              │  Results History (3)                    │
│              │  ✓ Tool 2 - 14:32:15 (2.3s)            │
│              │  ✗ Tool 1 - 14:30:02 (1.8s)            │
│              │  ✓ Tool 2 - 14:25:40 (3.1s)            │
└──────────────┴──────────────────────────────────────────┘
```

### Features

**1. Tools List Panel (Left)**
- Displays all available MCP tools
- Real-time search/filter
- Click to select a tool
- Shows tool name and brief description
- Highlighted selection state

**2. Tool Details Panel (Right)**
- Full tool description
- Dynamic parameter form based on tool schema
- Auto-generates appropriate input types:
  - Text input for strings
  - Number input for integers/floats
  - Dropdown for enums
  - Checkbox for booleans
- Required fields marked with red asterisk (*)
- Parameter descriptions shown as hints

**3. Execution**
- "Виконати" (Execute) button
- Loading state with spinner during execution
- Error handling with user-friendly messages

**4. Results History**
- Shows all previous executions
- Latest results at the top
- Success/failure indicators (✓/✗)
- Timestamp and execution duration
- Expandable JSON view
- Syntax-highlighted JSON output

---

## Available MCP Tools

The interface automatically discovers and displays all tools from the backend. Current tools include:

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `search_legal_precedents` | Search Ukrainian court decisions | query, max_results, reasoning_budget |
| `analyze_case_pattern` | Analyze patterns in judicial practice | topic, date_from, date_to |
| `get_similar_reasoning` | Find similar judicial reasoning | query, section_type |
| `extract_document_sections` | Extract structured sections from cases | document_id, section_types |
| `find_relevant_law_articles` | Find frequently cited law articles | topic, max_articles |
| `check_precedent_status` | Validate precedent status | case_number, check_date |
| `get_citation_graph` | Build citation relationships | case_number, depth |
| `get_legal_advice` | Comprehensive legal analysis with validation | query, context, stream |

---

## How to Use

### 1. Access the Interface

1. Navigate to https://dev.legal.org.ua/
2. Login with Google OAuth
3. Click "MCP Інструменти" (⚙️) in the sidebar

### 2. Execute a Tool

**Example: Search Legal Precedents**

1. Select `search_legal_precedents` from the tools list
2. Fill in parameters:
   - `query`: "позовна давність" (limitation period)
   - `max_results`: 10
   - `reasoning_budget`: "quick" (dropdown)
3. Click "Виконати" (Execute)
4. Wait for results (2-5 seconds)
5. View JSON response with court decisions

**Example: Analyze Case Pattern**

1. Select `analyze_case_pattern` from tools list
2. Fill in parameters:
   - `topic`: "трудові спори" (labor disputes)
   - `date_from`: "2024-01-01"
   - `date_to`: "2024-12-31"
   - `max_cases`: 50
3. Click "Виконати"
4. Review pattern analysis with success/failure arguments

### 3. Review Execution History

- Scroll down to see previous executions
- Click on any result to expand/collapse JSON details
- Copy JSON output for further analysis
- Green checkmark (✓) = Success
- Red X (✗) = Error

---

## Technical Implementation

### New Files Created

**`Lexwebapp/src/components/MCPToolsPage.tsx`** (570 lines)
- Main component for MCP tools interface
- Handles tool listing, selection, parameter input, execution
- Manages results history
- Dynamic form generation based on JSON schema

### Modified Files

**`Lexwebapp/src/components/ChatLayout.tsx`**
- Line 15: Changed import from `DecisionsSearchPage` to `MCPToolsPage`
- Line 193: Changed page title from "Пошук судових рішень" to "MCP Інструменти"
- Line 352: Renders `MCPToolsPage` instead of `DecisionsSearchPage`

**`Lexwebapp/src/components/Sidebar.tsx`**
- Line 20: Added `Settings` icon import
- Line 120: Changed label from "Судові рішення" to "MCP Інструменти"
- Line 121: Changed icon from `Gavel` to `Settings`

### API Integration

The interface uses existing API client methods:

```typescript
// List available tools
const response = await apiClient.listTools();
// Returns: { tools: MCPTool[], count: number }

// Execute a tool
const response = await apiClient.executeTool(toolName, params);
// Returns: { success, data, error, metadata }
```

**Backend Endpoints:**
- `GET /api/tools` - List all available MCP tools
- `POST /api/tools/:toolName` - Execute a specific tool

---

## Benefits

### For Development
- ✅ Test all MCP tools without writing code
- ✅ Quickly validate tool parameters and responses
- ✅ Debug API integration issues visually
- ✅ Prototype new tools and see immediate results

### For End Users (Future Production)
- ✅ Self-service access to AI-powered legal tools
- ✅ No need to understand MCP protocol
- ✅ Visual parameter validation
- ✅ Clear success/error feedback
- ✅ Reusable execution history

### Extensibility
- ✅ Automatically discovers new tools (no code changes needed)
- ✅ Schema-driven UI generation
- ✅ Works with any MCP-compliant backend
- ✅ Easy to add features like:
  - Parameter presets/templates
  - Export results to CSV/PDF
  - Share execution URLs
  - Favorites/bookmarks

---

## Example Screenshots (Text Representation)

### Tool Selection
```
┌─────────────────────────────────────────────┐
│  🔍 [Пошук інструментів...]                 │
├─────────────────────────────────────────────┤
│  [✓] search_legal_precedents                │
│      Search Ukrainian court decisions       │
│                                              │
│  [ ] analyze_case_pattern                   │
│      Analyze patterns in judicial practice  │
│                                              │
│  [ ] get_similar_reasoning                  │
│      Find similar judicial reasoning        │
└─────────────────────────────────────────────┘
```

### Execution Form
```
┌─────────────────────────────────────────────┐
│  search_legal_precedents                    │
│  Search Ukrainian court decisions           │
├─────────────────────────────────────────────┤
│  Параметри                                  │
│                                              │
│  query *                                     │
│  [позовна давність____________]             │
│                                              │
│  max_results                                │
│  [10___]                                    │
│                                              │
│  reasoning_budget                           │
│  [quick ▼]                                  │
│                                              │
│  [▶ Виконати]                               │
└─────────────────────────────────────────────┘
```

### Results
```
┌─────────────────────────────────────────────┐
│  Результати (3)                             │
│                                              │
│  ✓ search_legal_precedents - 16:32:15       │
│    (2.34s)                              [▼] │
│    ┌─────────────────────────────────────┐ │
│    │ {                                   │ │
│    │   "results": [                      │ │
│    │     { "doc_id": 110679112, ... },   │ │
│    │     ...                             │ │
│    │   ],                                │ │
│    │   "total": 10                       │ │
│    │ }                                   │ │
│    └─────────────────────────────────────┘ │
│                                              │
│  ✗ analyze_case_pattern - 16:30:02          │
│    (1.82s)                              [▶] │
│                                              │
│  ✓ search_legal_precedents - 16:25:40       │
│    (3.12s)                              [▶] │
└─────────────────────────────────────────────┘
```

---

## Deployment

### Build
```bash
cd /Users/vovkes/ZOMCP/SecondLayer/Lexwebapp
docker build --platform linux/amd64 -f Dockerfile.dev -t lexwebapp-lexwebapp:dev .
```

**Build Time:** ~19 seconds
**Image Size:** 20MB (compressed)

### Transfer & Deploy
```bash
docker save lexwebapp-lexwebapp:dev | gzip > /tmp/lexwebapp-mcp-tools.tar.gz
scp /tmp/lexwebapp-mcp-tools.tar.gz gate:/tmp/
ssh gate "gunzip -c /tmp/lexwebapp-mcp-tools.tar.gz | docker load && \
  cd /home/vovkes/secondlayer-deployment && \
  docker compose -f docker-compose.dev.yml up -d lexwebapp-dev"
```

**Container:** lexwebapp-dev
**URL:** https://dev.legal.org.ua
**Status:** ✅ Running

---

## Testing Checklist

- [x] Access MCP Tools page from sidebar
- [ ] Search for "search" in tools list
- [ ] Select `search_legal_precedents`
- [ ] Enter query "756/655/23"
- [ ] Execute and verify results appear
- [ ] Expand result to see JSON
- [ ] Execute another tool (e.g., `analyze_case_pattern`)
- [ ] Verify both results appear in history
- [ ] Test error handling (invalid parameters)
- [ ] Test with different parameter types (string, number, boolean, enum)

---

## Future Enhancements

### Short-term
1. **Parameter Presets** - Save and reuse common parameter combinations
2. **Export Results** - Download results as JSON, CSV, or PDF
3. **Favorites** - Bookmark frequently used tools
4. **Tool Categories** - Group tools by domain (search, analysis, validation)

### Medium-term
5. **Execution Templates** - Share pre-configured tool executions via URL
6. **Batch Execution** - Run multiple tools in sequence
7. **Result Comparison** - Compare outputs from different executions
8. **Visual Result Rendering** - Custom UI for common result types (tables, charts)

### Long-term
9. **Tool Chaining** - Use output of one tool as input to another
10. **Scheduled Execution** - Run tools periodically and alert on changes
11. **Collaborative Sharing** - Share results and templates with team
12. **API Key Management** - Per-user API keys for cost tracking

---

## Related Documentation

- Backend API: [docs/SSE_STREAMING.md](./SSE_STREAMING.md)
- MCP Tools List: [docs/MCP_TOOLS_LIST.md](./MCP_TOOLS_LIST.md)
- API Client: [Lexwebapp/src/services/api-client.ts](../Lexwebapp/src/services/api-client.ts)

---

**Status:** ✅ Deployed to Development
**Environment:** dev.legal.org.ua
**Deployment Time:** 2026-01-21 16:59:43 CET
**Container ID:** 2eb03a76bea6
