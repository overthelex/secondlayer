# MCP Streaming Integration Guide

**Version:** 1.0.0
**Date:** 2026-02-06
**Author:** SecondLayer Team

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Quick Start](#quick-start)
4. [Core Components](#core-components)
5. [Usage Examples](#usage-examples)
6. [Configuration](#configuration)
7. [API Reference](#api-reference)
8. [Testing](#testing)
9. [Troubleshooting](#troubleshooting)
10. [Migration Guide](#migration-guide)

---

## Overview

This integration provides real-time Server-Sent Events (SSE) streaming support for all 43 MCP tools in the lexwebapp frontend. It enables progressive rendering of AI thinking steps, similar to ChatGPT's streaming interface.

### Features

- ✅ **Real-time Streaming** - Progressive thinking steps and incremental updates
- ✅ **43 MCP Tools** - Full support for all backend, RADA, and OpenReyestr tools
- ✅ **Type-Safe** - Complete TypeScript coverage with auto-completion
- ✅ **Error Handling** - Automatic retry with exponential backoff
- ✅ **Stream Control** - Cancel streams, pause/resume support
- ✅ **Fallback Mode** - Graceful degradation to synchronous API calls
- ✅ **Unified API** - Single hook works across all components

### Supported Tools

| Category | Tools | Count |
|----------|-------|-------|
| Search & Analysis | classify_intent, search_legal_precedents, search_court_cases, etc. | 11 |
| Documents | get_document_text, parse_document, compare_documents, etc. | 7 |
| Legislation | search_legislation, get_legislation_article, etc. | 5 |
| Complex Operations | get_legal_advice, packaged_lawyer_answer, validate_citations, etc. | 10+ |
| RADA | search_deputies, get_deputy_info, search_bills, etc. | 4 |
| OpenReyestr | search_entities, get_beneficiaries, etc. | 5 |
| **TOTAL** | | **43** |

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend                             │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │  ChatPage  │  │ ChatLayout   │  │ Other Pages  │        │
│  └─────┬──────┘  └──────┬───────┘  └──────┬───────┘        │
│        │                │                  │                 │
│        └────────────────┴──────────────────┘                 │
│                         │                                    │
│                  ┌──────▼────────┐                          │
│                  │  useMCPTool   │  ◄── Shared Hook         │
│                  └──────┬────────┘                          │
│                         │                                    │
│        ┌────────────────┴────────────────┐                  │
│        │                                 │                  │
│  ┌─────▼──────┐                  ┌──────▼────────┐         │
│  │ MCPService │                  │  chatStore    │         │
│  └─────┬──────┘                  │  (Zustand)    │         │
│        │                         └───────────────┘         │
│  ┌─────▼──────┐                                            │
│  │ SSEClient  │                                            │
│  └─────┬──────┘                                            │
└────────┼────────────────────────────────────────────────────┘
         │
    ┌────▼─────┐
    │  Fetch   │
    │  Stream  │
    └────┬─────┘
         │
┌────────▼────────────────────────────────────────────────────┐
│                    Backend (MCP Server)                      │
│  POST /api/tools/{toolName}/stream                          │
│  ↓                                                           │
│  event: connected                                           │
│  event: progress (step 1, 2, 3...)                         │
│  event: complete (final result)                            │
│  event: end                                                 │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **User Input** → Component (ChatPage/ChatLayout)
2. **Component** → `useMCPTool` hook
3. **Hook** → `MCPService.streamTool()`
4. **MCPService** → `SSEClient.streamTool()`
5. **SSEClient** → Backend POST /api/tools/{toolName}/stream
6. **Backend** → SSE events stream
7. **SSEClient** → Parse events → Callbacks
8. **Callbacks** → Update Zustand store
9. **Store Update** → React re-render
10. **UI** → Display thinking steps + final result

---

## Quick Start

### 1. Install Dependencies

```bash
cd lexwebapp
npm install
```

### 2. Configure Environment

Create or update `.env.staging`:

```bash
VITE_API_URL=https://stage.legal.org.ua/api
VITE_API_KEY=your-api-key-here
VITE_ENABLE_SSE_STREAMING=true
VITE_ENABLE_ALL_MCP_TOOLS=true
```

### 3. Use in Components

```typescript
import { useMCPTool } from '../hooks/useMCPTool';

export function MyComponent() {
  const { executeTool } = useMCPTool('get_legal_advice');

  const handleQuery = async () => {
    await executeTool({
      query: 'Як стягнути борг?',
      max_precedents: 5,
    });
  };

  return (
    <button onClick={handleQuery}>
      Отримати консультацію
    </button>
  );
}
```

### 4. Build and Run

```bash
# Development
npm run dev

# Production build
npm run build:staging

# Preview
npm run preview:staging
```

---

## Core Components

### 1. SSEClient

**File:** `src/services/api/SSEClient.ts`

Universal client for Server-Sent Events streaming.

**Key Features:**
- Uses Fetch API + ReadableStream (better than EventSource)
- Automatic retry with exponential backoff (3 attempts)
- AbortController support for cancellation
- Type-safe event parsing

**Methods:**
```typescript
class SSEClient {
  constructor(apiUrl: string, apiKey: string)

  async streamTool(
    toolName: string,
    params: any,
    handlers: StreamingCallbacks
  ): Promise<AbortController>

  async streamToolWithRetry(
    toolName: string,
    params: any,
    handlers: StreamingCallbacks,
    retryCount?: number
  ): Promise<AbortController>
}
```

**Event Types:**
- `connected` - Stream connection established
- `progress` - Thinking step update
- `complete` - Final result received
- `error` - Error occurred
- `end` - Stream ended

### 2. MCPService

**File:** `src/services/api/MCPService.ts`

Service for calling all 43 MCP tools.

**Key Features:**
- Universal `callTool()` and `streamTool()` methods
- Type-safe wrappers for popular tools
- Intelligent response parsing
- Fallback to sync mode

**Methods:**
```typescript
class MCPService {
  // Universal methods
  async callTool(toolName: string, params: any): Promise<any>
  async streamTool(toolName: string, params: any, callbacks: StreamingCallbacks): Promise<AbortController>

  // Type-safe wrappers
  async getLegalAdvice(params: GetLegalAdviceParams): Promise<Message>
  async getLegalAdviceStreaming(params: GetLegalAdviceParams, callbacks: StreamingCallbacks): Promise<AbortController>

  async searchCourtCases(params: SearchCourtCasesParams): Promise<any>
  async searchCourtCasesStreaming(params: SearchCourtCasesParams, callbacks: StreamingCallbacks): Promise<AbortController>

  // Utility
  async listAvailableTools(): Promise<Tool[]>
  transformToolResultToMessage(toolName: string, result: any): Message
}
```

**Singleton Instance:**
```typescript
import { mcpService } from '../services';
```

### 3. useMCPTool Hook

**File:** `src/hooks/useMCPTool.ts`

Shared React hook for using MCP tools with streaming.

**Signature:**
```typescript
function useMCPTool(
  toolName: string,
  options?: UseMCPToolOptions
): { executeTool: (params: any) => Promise<void> }

interface UseMCPToolOptions {
  enableStreaming?: boolean;
  onSuccess?: (result: any) => void;
  onError?: (error: Error) => void;
}
```

**Specialized Hooks:**
```typescript
useGetLegalAdvice(options?)
useSearchCourtCases(options?)
useSearchLegislation(options?)
useSearchDeputies(options?)
useSearchEntities(options?)
```

**What It Does:**
1. Adds user message to chat
2. Creates placeholder for assistant message
3. Calls MCPService with streaming
4. Updates message incrementally as events arrive
5. Handles errors and displays toasts
6. Updates Zustand store

### 4. chatStore (Extended)

**File:** `src/stores/chatStore.ts`

Zustand store with streaming support.

**New State:**
```typescript
interface ChatState {
  // Existing
  messages: Message[];
  isStreaming: boolean;
  currentSessionId: string | null;

  // NEW
  streamController: AbortController | null;
  currentTool: string | null;
}
```

**New Actions:**
```typescript
updateMessage(messageId: string, updates: Partial<Message>): void
addThinkingStep(messageId: string, step: ThinkingStep): void
setStreamController(controller: AbortController | null): void
setCurrentTool(toolName: string | null): void
cancelStream(): void
```

---

## Usage Examples

### Example 1: Basic Legal Advice

```typescript
import { useGetLegalAdvice } from '../hooks/useMCPTool';

export function LegalConsultation() {
  const { executeTool } = useGetLegalAdvice();

  const handleSubmit = async (query: string) => {
    await executeTool({
      query,
      max_precedents: 5,
      include_reasoning: true,
    });
  };

  return <ChatInput onSend={handleSubmit} />;
}
```

### Example 2: Search Court Cases with Custom Callbacks

```typescript
import { useMCPTool } from '../hooks/useMCPTool';
import { useState } from 'react';

export function CourtCaseSearch() {
  const [isLoading, setIsLoading] = useState(false);

  const { executeTool } = useMCPTool('search_court_cases', {
    onSuccess: (result) => {
      console.log('Found cases:', result);
      setIsLoading(false);
    },
    onError: (error) => {
      console.error('Search failed:', error);
      setIsLoading(false);
    },
  });

  const handleSearch = async (query: string) => {
    setIsLoading(true);
    await executeTool({
      query,
      limit: 10,
      offset: 0,
    });
  };

  return (
    <div>
      <SearchInput onSubmit={handleSearch} />
      {isLoading && <Spinner />}
    </div>
  );
}
```

### Example 3: Multiple Tools with Tool Selector

```typescript
import { useMCPTool } from '../hooks/useMCPTool';
import { useState } from 'react';

export function MultiToolChat() {
  const [selectedTool, setSelectedTool] = useState('get_legal_advice');
  const { executeTool } = useMCPTool(selectedTool);

  const handleSend = async (content: string) => {
    const params = parseParams(selectedTool, content);
    await executeTool(params);
  };

  return (
    <div>
      <ToolSelector
        value={selectedTool}
        onChange={setSelectedTool}
      />
      <ChatInput onSend={handleSend} />
    </div>
  );
}

function parseParams(toolName: string, content: string) {
  switch (toolName) {
    case 'get_legal_advice':
      return { query: content, max_precedents: 5 };
    case 'search_court_cases':
      return { query: content, limit: 10 };
    case 'search_legislation':
      return { query: content, limit: 5 };
    default:
      return { query: content };
  }
}
```

### Example 4: Direct MCPService Usage (Advanced)

```typescript
import { mcpService } from '../services';

export async function customToolCall() {
  // Synchronous call
  const result = await mcpService.callTool('classify_intent', {
    query: 'Позов про розірвання договору',
  });

  console.log('Intent:', result.intent);
  console.log('Domain:', result.domain);
}

export async function customStreamingCall() {
  // Streaming call
  const controller = await mcpService.streamTool(
    'analyze_case_pattern',
    { case_description: 'Справа про борги...' },
    {
      onProgress: (data) => {
        console.log(`Step ${data.step}: ${data.message}`);
      },
      onComplete: (data) => {
        console.log('Pattern:', data.pattern);
        console.log('Recommendations:', data.recommendations);
      },
      onError: (error) => {
        console.error('Error:', error.message);
      },
    }
  );

  // Cancel after 5 seconds
  setTimeout(() => controller.abort(), 5000);
}
```

### Example 5: Stream Cancellation

```typescript
import { useChatStore } from '../stores';

export function CancelButton() {
  const { isStreaming, cancelStream } = useChatStore();

  if (!isStreaming) return null;

  return (
    <button onClick={cancelStream}>
      🛑 Зупинити
    </button>
  );
}
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | Yes | - | Backend API URL (e.g., `https://stage.legal.org.ua/api`) |
| `VITE_API_KEY` | Yes | - | API authentication key |
| `VITE_ENABLE_SSE_STREAMING` | No | `true` | Enable/disable SSE streaming |
| `VITE_ENABLE_ALL_MCP_TOOLS` | No | `true` | Enable all 43 tools |
| `VITE_SHOW_TOOL_SELECTOR` | No | `false` | Show tool selector UI (future) |
| `VITE_ENABLE_THINKING_STEPS` | No | `true` | Display thinking steps |
| `VITE_AUTO_EXPAND_THINKING` | No | `false` | Auto-expand thinking steps during streaming |

### Example Configurations

**Development (.env.development):**
```bash
VITE_API_URL=http://localhost:3000/api
VITE_API_KEY=dev-key-123
VITE_ENABLE_SSE_STREAMING=true
```

**Staging (.env.staging):**
```bash
VITE_API_URL=https://stage.legal.org.ua/api
VITE_API_KEY=REDACTED_SL_KEY_STAGE
VITE_ENABLE_SSE_STREAMING=true
VITE_ENABLE_ALL_MCP_TOOLS=true
```

**Production (.env.production):**
```bash
VITE_API_URL=https://legal.org.ua/api
VITE_API_KEY=${VITE_API_KEY} # Set in CI/CD
VITE_ENABLE_SSE_STREAMING=true
```

### Disable Streaming (Fallback Mode)

To disable streaming and use synchronous API calls:

```bash
VITE_ENABLE_SSE_STREAMING=false
```

The application will automatically fall back to regular POST requests without SSE.

---

## API Reference

### SSE Event Format

**Event: connected**
```json
{
  "event": "connected",
  "data": {
    "message": "Stream connected",
    "toolName": "get_legal_advice"
  }
}
```

**Event: progress**
```json
{
  "event": "progress",
  "data": {
    "step": 1,
    "action": "Analyzing query",
    "message": "Classifying legal intent...",
    "progress": 0.2,
    "result": { "intent": "debt_collection" }
  }
}
```

**Event: complete**
```json
{
  "event": "complete",
  "data": {
    "summary": "Для стягнення боргу за договором...",
    "reasoning_chain": [...],
    "precedent_chunks": [...],
    "source_attribution": [...]
  }
}
```

**Event: error**
```json
{
  "event": "error",
  "data": {
    "message": "Query classification failed",
    "error": { ... },
    "code": "QUERY_ERROR"
  }
}
```

**Event: end**
```json
{
  "event": "end",
  "data": {}
}
```

### Message Model

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  thinkingSteps?: ThinkingStep[];
  decisions?: Decision[];
  citations?: Citation[];
}

interface ThinkingStep {
  id: string;
  title: string;
  content: string;
  isComplete: boolean;
}

interface Decision {
  id: string;
  number: string;
  court: string;
  date: string;
  summary: string;
  relevance: number;
  status: 'active' | 'inactive';
}

interface Citation {
  text: string;
  source: string;
}
```

---

## Testing

See `lexwebapp/src/__tests__/` for unit tests.

**Run tests:**
```bash
npm test
npm run test:watch
npm run test:coverage
```

**Example test:**
```typescript
import { render, screen } from '@testing-library/react';
import { useMCPTool } from '../hooks/useMCPTool';

test('useMCPTool executes tool and updates store', async () => {
  const { executeTool } = useMCPTool('get_legal_advice');

  await executeTool({ query: 'Test query' });

  expect(screen.getByText(/Test query/)).toBeInTheDocument();
});
```

---

## Troubleshooting

### Issue: Streaming not working

**Symptoms:** No thinking steps appear, messages appear all at once

**Solutions:**
1. Check `VITE_ENABLE_SSE_STREAMING=true` in `.env`
2. Verify backend SSE endpoint: `POST /api/tools/{toolName}/stream`
3. Check browser console for SSE errors
4. Test with curl:
   ```bash
   curl -N -X POST https://stage.legal.org.ua/api/tools/get_legal_advice/stream \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_KEY" \
     -d '{"query":"test"}'
   ```

### Issue: CORS errors

**Symptoms:** `Access-Control-Allow-Origin` errors in console

**Solutions:**
1. Backend must include CORS headers for SSE
2. Check `ALLOWED_ORIGINS` in backend `.env`
3. For development, use proxy in `vite.config.ts`:
   ```typescript
   server: {
     proxy: {
       '/api': 'https://stage.legal.org.ua',
     },
   }
   ```

### Issue: Messages duplicated

**Symptoms:** Same message appears multiple times

**Solutions:**
1. Ensure `useMCPTool` is not called in render
2. Check React StrictMode (development only)
3. Verify no duplicate event listeners

### Issue: Stream hangs/never completes

**Symptoms:** Thinking steps show but no final result

**Solutions:**
1. Check backend logs for errors
2. Verify backend sends `complete` and `end` events
3. Check network tab for incomplete responses
4. Increase timeout if needed

### Issue: TypeScript errors

**Symptoms:** Type errors when calling tools

**Solutions:**
1. Import types from `'../../types/api/mcp-tools'`
2. Use type-safe wrappers: `useGetLegalAdvice()` instead of `useMCPTool('get_legal_advice')`
3. Check `tsconfig.json` includes `src/types`

---

## Migration Guide

### From React Query to useMCPTool

**Before:**
```typescript
import { useGetLegalAdvice } from '../../hooks/queries';

const { mutateAsync: getLegalAdvice } = useGetLegalAdvice();

const handleSend = async (content: string) => {
  const result = await getLegalAdvice({
    query: content,
    max_precedents: 5,
  });
  addMessage(result);
};
```

**After:**
```typescript
import { useMCPTool } from '../../hooks/useMCPTool';

const { executeTool } = useMCPTool('get_legal_advice');

const handleSend = async (content: string) => {
  await executeTool({
    query: content,
    max_precedents: 5,
  });
  // Message automatically added to store
};
```

### From Inline Fetch to MCPService

**Before:**
```typescript
const response = await fetch(`${API_URL}/tools/get_legal_advice`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({ query: content }),
});
const data = await response.json();
```

**After:**
```typescript
import { mcpService } from '../services';

const data = await mcpService.callTool('get_legal_advice', {
  query: content,
});
```

### Enabling Streaming for Existing Components

1. Replace direct API calls with `useMCPTool`
2. Remove manual message state management
3. Use Zustand store for messages
4. Add thinking steps display if not present

---

## Performance Optimization

### 1. Lazy Load Components

```typescript
const ChatPage = lazy(() => import('./pages/ChatPage'));
```

### 2. Memoize Callbacks

```typescript
const handleSend = useCallback(async (content: string) => {
  await executeTool({ query: content });
}, [executeTool]);
```

### 3. Debounce Input

```typescript
const debouncedExecute = useMemo(
  () => debounce(executeTool, 300),
  [executeTool]
);
```

### 4. Virtual Scrolling for Long Conversations

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 200,
});
```

---

## Security Considerations

### 1. API Key Protection

- Never commit API keys to Git
- Use environment variables
- Rotate keys regularly
- Use different keys for dev/staging/prod

### 2. Input Validation

```typescript
const handleSend = async (content: string) => {
  if (!content.trim()) return;
  if (content.length > 5000) {
    showToast.error('Query too long');
    return;
  }

  await executeTool({ query: content.trim() });
};
```

### 3. Rate Limiting

Backend already implements rate limiting. Frontend should:
- Show user-friendly error messages
- Implement client-side debouncing
- Display rate limit warnings

### 4. XSS Prevention

All content is sanitized through React's default escaping. For raw HTML:

```typescript
import DOMPurify from 'dompurify';

const sanitized = DOMPurify.sanitize(content);
```

---

## Best Practices

### 1. Error Handling

Always wrap tool calls in try-catch:

```typescript
try {
  await executeTool(params);
} catch (error) {
  console.error('Tool execution failed:', error);
  showToast.error(error.message);
}
```

### 2. Loading States

Use `isStreaming` from store:

```typescript
const { isStreaming } = useChatStore();

<ChatInput disabled={isStreaming} />
```

### 3. Type Safety

Use TypeScript types for all tool calls:

```typescript
import { GetLegalAdviceParams } from '../../types/api/mcp-tools';

const params: GetLegalAdviceParams = {
  query: content,
  max_precedents: 5,
  include_reasoning: true,
};
```

### 4. Accessibility

- Announce streaming status to screen readers
- Provide keyboard shortcuts for stream control
- Use semantic HTML

```typescript
<div role="status" aria-live="polite">
  {isStreaming && 'Обробка запиту...'}
</div>
```

---

## Future Enhancements

### Planned Features

1. **Tool Selector UI** - Visual interface for choosing MCP tools
2. **Token-by-token streaming** - Character-by-character rendering
3. **Voice integration** - Speech-to-text input, TTS output
4. **Offline support** - Service Worker + IndexedDB caching
5. **Multi-tool workflows** - Chain multiple tool calls
6. **Analytics dashboard** - Usage statistics and insights
7. **Custom tool creation** - User-defined tool compositions

---

## Support

- **Documentation:** `/docs/MCP_CLIENT_INTEGRATION_GUIDE.md`
- **API Explorer:** `/mcp_backend/docs/api-explorer.html`
- **Issues:** https://github.com/anthropics/claude-code/issues
- **Email:** support@legal.org.ua

---

**Last Updated:** 2026-02-06
**Version:** 1.0.0
**License:** MIT
