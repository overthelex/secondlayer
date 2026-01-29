# SSE (Server-Sent Events) Tests

Comprehensive test suite for SSE endpoints in the mcp_backend project.

## Test Coverage

### Test Files Created

1. **mcp-sse-server.test.ts** (19 unit tests)
   - MCPSSEServer class unit tests
   - getAllTools(), handleSSEConnection(), session management
   - MCP protocol methods (initialize, tools/list, tools/call, ping, prompts/list, resources/list)

2. **sse-mcp-protocol.test.ts** (Integration tests)
   - MCP JSON-RPC protocol over SSE
   - Protocol handshake and version negotiation
   - Tools discovery and execution
   - Authentication and error handling

3. **sse-streaming-tool.test.ts** (Integration tests)
   - Direct streaming endpoint `/api/tools/:toolName/stream`
   - Event sequence validation (connected → progress → complete → end)
   - Non-streaming tool fallback
   - Concurrent streaming

4. **sse-content-negotiation.test.ts** (Integration tests)
   - Accept header content negotiation
   - SSE vs JSON response selection
   - All tools support content negotiation

5. **sse-authentication.test.ts** (Integration tests)
   - API key authentication
   - JWT token authentication
   - Anonymous access for /sse endpoint
   - Authentication context and session tracking

6. **sse-error-handling.test.ts** (Integration tests)
   - Invalid JSON-RPC requests
   - Unknown methods and tools
   - Tool execution errors
   - Network and timeout handling
   - Response consistency

### Test Utilities

- **sse-event-collector.ts** - Utility for collecting and parsing SSE events from EventSource
- **mock-sse-response.ts** - Mock Express Response for unit testing SSE

## Prerequisites

### For Unit Tests
- No server required
- All dependencies mocked

### For Integration Tests
- HTTP server must be running on `TEST_BASE_URL` (default: http://localhost:3000)
- Valid API key in `TEST_API_KEY` (default: test-key-123)
- External services (OpenAI, ZakonOnline) should be available

## Running Tests

### Run All SSE Tests

```bash
cd mcp_backend

# Run all SSE tests (unit + integration)
npm test -- src/api/__tests__/sse/

# Run with coverage
npm test -- --coverage src/api/__tests__/sse/
```

### Run Specific Test Files

```bash
# Unit tests only
npm test -- src/api/__tests__/mcp-sse-server.test.ts

# MCP protocol tests
npm test -- sse-mcp-protocol.test.ts

# Streaming tests
npm test -- sse-streaming-tool.test.ts

# Content negotiation
npm test -- sse-content-negotiation.test.ts

# Authentication
npm test -- sse-authentication.test.ts

# Error handling
npm test -- sse-error-handling.test.ts
```

### Run Against Different Environments

```bash
# Test against dev environment
TEST_BASE_URL=https://dev.mcp.legal.org.ua npm test -- src/api/__tests__/sse/

# Test against production
TEST_BASE_URL=https://mcp.legal.org.ua npm test -- src/api/__tests__/sse/

# Test with different API key
TEST_API_KEY=your-key-here npm test -- src/api/__tests__/sse/
```

### Watch Mode

```bash
# Watch mode for development
npm run test:watch -- sse-mcp-protocol.test.ts
```

## Test Organization

```
mcp_backend/src/
├── __tests__/
│   └── helpers/
│       ├── sse-event-collector.ts       # SSE event collection utility
│       └── mock-sse-response.ts         # Mock Response for unit tests
└── api/
    └── __tests__/
        ├── mcp-sse-server.test.ts       # Unit tests (19 tests)
        └── sse/
            ├── README.md                 # This file
            ├── sse-mcp-protocol.test.ts  # MCP protocol integration tests
            ├── sse-streaming-tool.test.ts # Streaming endpoint tests
            ├── sse-content-negotiation.test.ts # Accept header tests
            ├── sse-authentication.test.ts # Auth flow tests
            └── sse-error-handling.test.ts # Error scenario tests
```

## SSE Endpoints Tested

### 1. POST /sse
- MCP JSON-RPC protocol over SSE
- Used for ChatGPT web integration
- Supports: initialize, tools/list, tools/call, ping, prompts/list, resources/list
- Optional authentication (JWT or API key)

### 2. POST /api/tools/:toolName/stream
- Direct streaming endpoint for any tool
- Requires authentication (Bearer token)
- Returns SSE events: connected → progress → complete → end

### 3. POST /api/tools/:toolName with Accept: text/event-stream
- Content negotiation via Accept header
- Switches between JSON and SSE response
- All tools support this

## Key Test Scenarios

### Protocol Compliance
- ✅ MCP JSON-RPC 2.0 format
- ✅ Protocol version negotiation (2024-11-05, 2025-11-05, 2025-03-26, 2025-11-25)
- ✅ Tools discovery (41+ tools)
- ✅ Tool execution via tools/call

### Event Streaming
- ✅ Event sequence: connected → progress → complete → end
- ✅ Event IDs (connection, step-1, step-2, ..., final, end)
- ✅ SSE format compliance (id, event, data fields)
- ✅ Progress events for get_legal_advice (7 steps)

### Authentication
- ✅ API key authentication
- ✅ JWT token authentication
- ✅ Anonymous access for /sse endpoint
- ✅ 401 Unauthorized for protected endpoints

### Error Handling
- ✅ Invalid JSON-RPC requests
- ✅ Unknown methods (-32601 error)
- ✅ Non-existent tools
- ✅ Missing required arguments
- ✅ Always sends 'end' event even on error

### Content Negotiation
- ✅ Accept: text/event-stream → SSE response
- ✅ Accept: application/json → JSON response
- ✅ No Accept header → JSON response (default)
- ✅ Priority handling for multiple Accept values

## Coverage Goals

Target: **90%+ code coverage** for SSE-related code

Key files to cover:
- `src/api/mcp-sse-server.ts` (MCPSSEServer class)
- `src/http-server.ts` (handleStreamingToolCall, sendSSEEvent methods)
- `src/api/mcp-query-api.ts` (getLegalAdviceStream method)

## Troubleshooting

### Tests fail with connection errors
- Ensure HTTP server is running: `npm run dev:http`
- Check TEST_BASE_URL is correct: `echo $TEST_BASE_URL`

### Tests timeout
- Increase timeout for slow tools: adjust timeout in test (default: 60s)
- Check external services (OpenAI, ZakonOnline) are available

### Authentication errors
- Verify TEST_API_KEY matches SECONDARY_LAYER_KEYS in .env
- For JWT tests, ensure JWT_SECRET is configured

### Integration tests skip
- Some tests may skip if server is not running
- Run unit tests independently: `npm test -- mcp-sse-server.test.ts`

## CI/CD Integration

### GitHub Actions Example

```yaml
name: SSE Tests

on: [push, pull_request]

jobs:
  sse-tests:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test

      redis:
        image: redis:7

    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Start HTTP server
        run: npm run dev:http &
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test

      - name: Wait for server
        run: sleep 10

      - name: Run SSE tests
        run: npm test -- src/api/__tests__/sse/
        env:
          TEST_BASE_URL: http://localhost:3000
          TEST_API_KEY: test-key-123

      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

## Manual Testing with curl

### Test /sse endpoint

```bash
# Initialize
curl -N -X POST https://dev.mcp.legal.org.ua/sse \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-05","clientInfo":{"name":"test","version":"1.0"}}}'

# List tools
curl -N -X POST https://dev.mcp.legal.org.ua/sse \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call tool
curl -N -X POST https://dev.mcp.legal.org.ua/sse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key-123" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"classify_intent","arguments":{"query":"тест"}}}'
```

### Test /stream endpoint

```bash
# Streaming tool call
curl -N -X POST https://dev.mcp.legal.org.ua/api/tools/classify_intent/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key-123" \
  -d '{"arguments":{"query":"Хочу оскаржити рішення суду"}}'
```

### Test content negotiation

```bash
# Request SSE via Accept header
curl -N -X POST https://dev.mcp.legal.org.ua/api/tools/classify_intent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key-123" \
  -H "Accept: text/event-stream" \
  -d '{"arguments":{"query":"тест"}}'

# Request JSON (default)
curl -X POST https://dev.mcp.legal.org.ua/api/tools/classify_intent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key-123" \
  -d '{"arguments":{"query":"тест"}}'
```

## Next Steps

1. **Run integration tests** against dev.mcp.legal.org.ua
2. **Generate coverage report** and verify 90%+ coverage
3. **Add to CI/CD pipeline** for automated testing
4. **Monitor test results** in production deployments

## Resources

- [SSE Specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [MCP Protocol Documentation](https://platform.openai.com/docs/mcp)
- [EventSource API](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
