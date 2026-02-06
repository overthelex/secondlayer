# Quick Start Guide - MCP Streaming Integration

> Get started with MCP streaming in 5 minutes

## Prerequisites

- Node.js 20+
- npm or yarn
- Access to MCP backend API

## Installation

```bash
cd lexwebapp
npm install
```

## Configuration

Create `.env.staging`:

```bash
VITE_API_URL=https://stage.legal.org.ua/api
VITE_API_KEY=your-api-key-here
VITE_ENABLE_SSE_STREAMING=true
```

## Basic Usage

### 1. Use in a Component

```typescript
import { useMCPTool } from '../hooks/useMCPTool';

export function MyChat() {
  const { executeTool } = useMCPTool('get_legal_advice');

  const handleSend = async (query: string) => {
    await executeTool({
      query,
      max_precedents: 5,
    });
  };

  return <ChatInput onSend={handleSend} />;
}
```

### 2. Access Messages from Store

```typescript
import { useChatStore } from '../stores/chatStore';

export function MessageList() {
  const { messages, isStreaming } = useChatStore();

  return (
    <div>
      {messages.map(msg => (
        <Message key={msg.id} {...msg} />
      ))}
      {isStreaming && <Spinner />}
    </div>
  );
}
```

### 3. Cancel Stream

```typescript
import { useChatStore } from '../stores/chatStore';

export function CancelButton() {
  const { cancelStream, isStreaming } = useChatStore();

  return isStreaming ? (
    <button onClick={cancelStream}>Stop</button>
  ) : null;
}
```

## Available Tools

### Most Popular

```typescript
// Legal advice (most common)
useMCPTool('get_legal_advice')

// Search court cases
useMCPTool('search_court_cases')

// Search legislation
useMCPTool('search_legislation')

// Search deputies
useMCPTool('search_deputies')

// Search entities
useMCPTool('search_entities')
```

### All 43 Tools

See `docs/MCP_STREAMING_INTEGRATION.md` for complete list.

## Development

```bash
# Start dev server
npm run dev

# Run tests
npm test

# Build
npm run build:staging
```

## Docker Deployment

```bash
cd deployment

# Build
docker compose -f docker-compose.stage.yml build lexwebapp-stage

# Deploy
docker compose -f docker-compose.stage.yml up -d lexwebapp-stage

# Check logs
docker logs lexwebapp-stage -f
```

## Debugging

### Enable Debug Logging

```typescript
import { mcpService } from '../services';

// In browser console
localStorage.setItem('debug', 'mcp:*');
```

### Check SSE Connection

```bash
curl -N -X POST https://stage.legal.org.ua/api/tools/get_legal_advice/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"query":"test"}'
```

### Common Issues

**Issue: No streaming**
- Check `VITE_ENABLE_SSE_STREAMING=true`
- Verify backend SSE endpoint
- Check browser console for errors

**Issue: CORS errors**
- Update backend `ALLOWED_ORIGINS`
- Use proxy in development

**Issue: Types not working**
- Run `npm install`
- Restart TypeScript server

## Next Steps

- Read full docs: `docs/MCP_STREAMING_INTEGRATION.md`
- Browse API: `mcp_backend/docs/api-explorer.html`
- See examples: `docs/ALL_MCP_TOOLS.md`
- Run tests: `npm test`

## Support

- Issues: https://github.com/anthropics/claude-code/issues
- Email: support@legal.org.ua
- Docs: `/docs/`

---

**Ready to go!** 🚀
