# Frontend Unit Tests

This directory contains unit tests for the MCP Streaming Integration.

## Overview

Tests are written using:
- **Vitest** - Fast unit test framework for Vite projects
- **React Testing Library** - React component testing
- **jsdom** - DOM simulation for Node.js

## Test Coverage

### Core Services

- **SSEClient.test.ts** - SSE client streaming tests
  - Connection establishment
  - Event parsing (connected, progress, complete, error, end)
  - Stream cancellation
  - Retry logic
  - Error handling

- **MCPService.test.ts** - MCP service tests
  - Synchronous tool calls
  - Streaming tool calls
  - Response transformation
  - Fallback mode
  - Tool listing

### Hooks

- **useMCPTool.test.tsx** - MCP tool hook tests
  - Tool execution
  - Message management
  - Streaming callbacks
  - Error handling
  - Specialized hooks

### Stores

- **chatStore.test.ts** - Chat store tests
  - Message CRUD operations
  - Streaming state management
  - Thinking steps
  - Stream controller management
  - Persistence

## Running Tests

```bash
# Run all tests
npm test

# Watch mode (recommended during development)
npm run test:watch

# UI mode (visual test runner)
npm run test:ui

# Coverage report
npm run test:coverage
```

## Test Structure

```
src/__tests__/
├── setup.ts                           # Global test setup
├── README.md                          # This file
├── services/
│   └── api/
│       ├── SSEClient.test.ts         # SSE client tests
│       └── MCPService.test.ts        # MCP service tests
├── hooks/
│   └── useMCPTool.test.tsx           # Hook tests
└── stores/
    └── chatStore.test.ts             # Store tests
```

## Writing Tests

### Example: Testing a Component

```typescript
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { MyComponent } from '../MyComponent';

test('renders correctly', () => {
  render(<MyComponent />);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});
```

### Example: Testing a Service

```typescript
import { expect, test, vi } from 'vitest';
import { mcpService } from '../services';

test('calls API correctly', async () => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ result: 'success' }),
  });

  const result = await mcpService.callTool('test_tool', {});

  expect(result).toEqual({ result: 'success' });
});
```

### Example: Testing a Hook

```typescript
import { renderHook, act } from '@testing-library/react';
import { expect, test } from 'vitest';
import { useMCPTool } from '../hooks/useMCPTool';

test('executes tool', async () => {
  const { result } = renderHook(() => useMCPTool('get_legal_advice'));

  await act(async () => {
    await result.current.executeTool({ query: 'test' });
  });

  expect(result.current.isLoading).toBe(false);
});
```

## Mocking

### Mocking Services

```typescript
vi.mock('../services', () => ({
  mcpService: {
    streamTool: vi.fn(),
    callTool: vi.fn(),
  },
}));
```

### Mocking Stores

```typescript
import { useChatStore } from '../stores/chatStore';

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    isStreaming: false,
  });
});
```

### Mocking fetch

```typescript
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ data: 'mock' }),
});
```

## Best Practices

1. **Isolate Tests**: Each test should be independent
2. **Clear Setup**: Use beforeEach/afterEach for cleanup
3. **Descriptive Names**: Test names should describe what they test
4. **AAA Pattern**: Arrange, Act, Assert
5. **Mock External Dependencies**: Don't make real API calls
6. **Test Behavior, Not Implementation**: Focus on what, not how

## Coverage Goals

| Component | Target Coverage |
|-----------|----------------|
| Services  | > 80% |
| Hooks     | > 85% |
| Stores    | > 90% |
| Components| > 75% |

## Debugging Tests

### Run specific test file
```bash
npm test SSEClient.test.ts
```

### Run specific test
```bash
npm test -t "should parse progress events"
```

### Debug in VS Code
Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Tests",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["test"],
  "console": "integratedTerminal"
}
```

## CI/CD Integration

Tests run automatically in GitHub Actions:

```yaml
- name: Run tests
  run: npm test -- --coverage
- name: Upload coverage
  uses: codecov/codecov-action@v3
```

## Troubleshooting

### Issue: Tests timeout

**Solution**: Increase timeout
```typescript
test('long running test', async () => {
  // ...
}, 10000); // 10 second timeout
```

### Issue: Async tests failing

**Solution**: Use `await` and `act()`
```typescript
await act(async () => {
  await asyncFunction();
});
```

### Issue: Mock not working

**Solution**: Clear mocks between tests
```typescript
afterEach(() => {
  vi.clearAllMocks();
});
```

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [Testing Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)

---

**Last Updated:** 2026-02-06
