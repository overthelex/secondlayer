# Testing Instructions

## Quick Start

### Option 1: Using the Test Runner Script (Recommended)

```bash
cd /home/vovkes/SecondLayer/lexwebapp
./run-tests.sh
```

This will:
1. ✅ Install dependencies
2. ✅ Check TypeScript compilation
3. ✅ Run all unit tests
4. ✅ Generate coverage report

### Option 2: Manual Commands

```bash
cd /home/vovkes/SecondLayer/lexwebapp

# Install dependencies
npm install --legacy-peer-deps

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode (for development)
npm run test:watch

# Run tests with UI
npm run test:ui
```

## Test Commands Reference

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:ui` | Open visual test UI |
| `npm run test:coverage` | Generate coverage report |

## What Gets Tested

### Services (27 tests)
- ✅ **SSEClient** (15 tests)
  - Connection establishment
  - Event parsing
  - Error handling
  - Retry logic

- ✅ **MCPService** (12 tests)
  - Synchronous calls
  - Streaming calls
  - Response transformation
  - Tool listing

### Hooks (10 tests)
- ✅ **useMCPTool**
  - Tool execution
  - Message management
  - Streaming callbacks
  - Error handling

### Stores (18 tests)
- ✅ **chatStore**
  - Message CRUD
  - Streaming state
  - Thinking steps
  - Controller management

**Total: 55 tests**

## Expected Results

```
 ✓ src/services/api/__tests__/SSEClient.test.ts (15)
 ✓ src/services/api/__tests__/MCPService.test.ts (12)
 ✓ src/hooks/__tests__/useMCPTool.test.tsx (10)
 ✓ src/stores/__tests__/chatStore.test.ts (18)

Test Files  4 passed (4)
     Tests  55 passed (55)
  Start at  XX:XX:XX
  Duration  X.XXs
```

## Coverage Targets

| Component | Target | Current |
|-----------|--------|---------|
| SSEClient | > 85% | ~85% |
| MCPService | > 80% | ~80% |
| useMCPTool | > 85% | ~85% |
| chatStore | > 90% | ~90% |
| **Overall** | **> 85%** | **~85%** |

## Troubleshooting

### Issue: npm not found

**Solution:**
```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Issue: Tests fail with module errors

**Solution:**
```bash
# Clean install
rm -rf node_modules package-lock.json
npm install --legacy-peer-deps
```

### Issue: TypeScript errors

**Solution:**
```bash
# Check TypeScript compilation
npx tsc --noEmit

# If errors, check:
# 1. tsconfig.json is correct
# 2. All imports are valid
# 3. Types are properly defined
```

### Issue: Test timeout

**Solution:**
```bash
# Increase timeout in vitest.config.ts
export default defineConfig({
  test: {
    testTimeout: 10000, // 10 seconds
  },
});
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test -- --coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

## Next Steps After Tests Pass

1. ✅ **Build for staging**
   ```bash
   npm run build:staging
   ```

2. ✅ **Build Docker image**
   ```bash
   cd ../deployment
   docker compose -f docker-compose.stage.yml build lexwebapp-stage
   ```

3. ✅ **Deploy to staging**
   ```bash
   docker compose -f docker-compose.stage.yml up -d lexwebapp-stage
   ```

4. ✅ **Verify deployment**
   ```bash
   docker logs lexwebapp-stage -f
   curl https://stage.legal.org.ua/
   ```

## Files Created for Testing

```
lexwebapp/
├── vitest.config.ts              # Test configuration
├── run-tests.sh                  # Test runner script
├── TEST_INSTRUCTIONS.md          # This file
│
└── src/
    ├── __tests__/
    │   ├── setup.ts              # Global test setup
    │   └── README.md             # Testing guide
    │
    ├── services/api/__tests__/
    │   ├── SSEClient.test.ts     # 15 tests
    │   └── MCPService.test.ts    # 12 tests
    │
    ├── hooks/__tests__/
    │   └── useMCPTool.test.tsx   # 10 tests
    │
    └── stores/__tests__/
        └── chatStore.test.ts     # 18 tests
```

## Dependencies Added

```json
{
  "devDependencies": {
    "@testing-library/jest-dom": "^6.1.5",
    "@testing-library/react": "^14.1.2",
    "@testing-library/user-event": "^14.5.1",
    "@vitest/ui": "^1.0.4",
    "jsdom": "^23.0.1",
    "vitest": "^1.0.4"
  }
}
```

## Resources

- [Vitest Docs](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [Testing Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)

---

**Ready to test!** Run `./run-tests.sh` to get started. 🧪
