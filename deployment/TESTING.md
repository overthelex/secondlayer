# Testing Guide for Local Deployment

This guide explains how to run tests for locally deployed SecondLayer services.

## Quick Start

```bash
cd deployment

# Run all tests (recommended)
./run-local-tests.sh

# Run only smoke tests (fast)
./run-local-tests.sh --quick

# Run with detailed output
./run-local-tests.sh --verbose
```

## Prerequisites

1. **Services must be running:**
   ```bash
   ./manage-gateway.sh start local
   ```

2. **For RADA tests, start with profile:**
   ```bash
   docker compose -f docker-compose.local.yml --profile rada up -d
   ```

3. **Check services are healthy:**
   ```bash
   curl http://localhost:3000/health  # Main backend
   curl http://localhost:3002/health  # Document service
   curl http://localhost:3001/health  # RADA MCP (if started)
   ```

## Test Script Options

### `./run-local-tests.sh` - Main test runner

**Options:**
- `--quick` - Run only smoke tests (fastest, ~30 seconds)
- `--backend` - Run only main backend tests
- `--rada` - Run only RADA MCP tests
- `--verbose` - Show detailed test output
- `--no-wait` - Skip waiting for services to be ready
- `-h, --help` - Show help message

**Examples:**

```bash
# Quick smoke tests (30 seconds)
./run-local-tests.sh --quick

# Full backend test suite (5-10 minutes)
./run-local-tests.sh --backend

# Full RADA test suite
./run-local-tests.sh --rada

# All tests with detailed output
./run-local-tests.sh --verbose

# Run without waiting (when services already ready)
./run-local-tests.sh --no-wait
```

## Test Suites

### 1. Main Backend Tests (Port 3000)

**Smoke Tests** (`smoke-test-all-tools.test.ts`):
- Health check
- List all tools
- Basic tool execution
- Authentication checks
- ~30 seconds

**Integration Tests** (`all-tools-integration.test.ts`):
- All MCP tools end-to-end
- Real API calls
- Database integration
- ~5 minutes

**Document Analysis E2E** (`document-analysis-e2e.test.ts`):
- Document parsing
- OCR functionality
- PDF processing
- ~3 minutes

**Due Diligence Tools** (`due-diligence-tools.test.ts`):
- Company verification
- Legal entity checks
- ~2 minutes

**Legal Advice Tests** (`get-legal-advice-cpc-gpc.test.ts`):
- Legal consultation tools
- Code references
- ~2 minutes

**Legal Precedents** (`search-legal-precedents.test.ts`):
- Case search
- Citation validation
- ~2 minutes

**ZO Adapter Tests**:
- ZakonOnline API integration
- Error handling
- Metadata extraction
- ~3 minutes

### 2. Document Service Tests (Port 3002)

Included in main backend test suite.

**Tests:**
- Document upload and processing
- OCR with Google Vision API
- PDF text extraction
- Document metadata extraction

### 3. RADA MCP Tests (Port 3001)

**Smoke Tests** (`smoke-test-rada-tools.test.ts`):
- Health check
- 4 tools validation
- Authentication
- ~30 seconds

**Integration Tests** (`all-rada-tools-integration.test.ts`):
- Parliament bills search
- Deputy information
- Legislation text search
- Voting records analysis
- ~5 minutes

## Running Tests Manually

### Inside Containers

```bash
# Main backend
docker exec -it secondlayer-app-local npm test

# Run specific test
docker exec -it secondlayer-app-local npm test -- smoke-test-all-tools.test.ts

# RADA MCP
docker exec -it rada-mcp-app-local npm test

# Run specific RADA test
docker exec -it rada-mcp-app-local npm test -- smoke-test-rada-tools.test.ts
```

### From Host Machine

```bash
# Main backend
cd mcp_backend
TEST_BASE_URL=http://localhost:3000 \
TEST_API_KEY=test-key-123 \
npm test

# RADA MCP
cd mcp_rada
RADA_TEST_BASE_URL=http://localhost:3001 \
RADA_TEST_API_KEY=test-key-123 \
npm test
```

## Environment Variables

Tests use these environment variables:

```bash
# Main Backend
TEST_BASE_URL=http://localhost:3000
TEST_API_KEY=test-key-123

# RADA MCP
RADA_TEST_BASE_URL=http://localhost:3001
RADA_TEST_API_KEY=test-key-123

# Database (for direct access tests)
DATABASE_URL=postgresql://secondlayer:local_dev_password@localhost:5432/secondlayer_local
```

## Test Configuration

### Jest Configuration

Both services use Jest with TypeScript:

**mcp_backend/jest.config.js:**
```javascript
{
  testTimeout: 120000,  // 2 minutes per test
  maxWorkers: 1,        // Run tests sequentially
  verbose: true         // Show detailed output
}
```

**mcp_rada/jest.config.js:**
```javascript
{
  testTimeout: 120000,
  maxWorkers: 1,
  verbose: true
}
```

## Troubleshooting

### Services Not Running

```bash
# Check which services are running
docker ps | grep -E "(secondlayer|rada)"

# Start services
./manage-gateway.sh start local

# Start with RADA
docker compose -f docker-compose.local.yml --profile rada up -d
```

### Tests Timeout

Increase timeout in jest.config.js or run tests with more time:

```bash
# In jest.config.js
testTimeout: 300000  // 5 minutes
```

### Database Connection Issues

```bash
# Check PostgreSQL is healthy
docker exec secondlayer-postgres-local pg_isready -U secondlayer

# View database logs
docker logs secondlayer-postgres-local
```

### API Key Authentication Errors

Make sure API keys match in `.env.local` and test configuration:

```bash
# In deployment/.env.local
SECONDARY_LAYER_KEYS=local-dev-key,test-key-123
RADA_API_KEYS=test-key-123

# Tests use
TEST_API_KEY=test-key-123
RADA_TEST_API_KEY=test-key-123
```

### View Test Logs

```bash
# Main backend logs
docker logs -f secondlayer-app-local

# RADA MCP logs
docker logs -f rada-mcp-app-local

# Run tests with verbose output
./run-local-tests.sh --verbose
```

## Continuous Integration

For CI/CD pipelines:

```bash
#!/bin/bash
set -e

# Start services
cd deployment
./manage-gateway.sh start local

# Wait for services
sleep 30

# Run tests
./run-local-tests.sh --quick

# Stop services
./manage-gateway.sh stop local
```

## Test Coverage

To generate coverage reports:

```bash
# Main backend
cd mcp_backend
npm test -- --coverage

# RADA MCP
cd mcp_rada
npm test -- --coverage
```

Coverage reports will be generated in `coverage/` directory.

## Best Practices

1. **Always run smoke tests first** - Use `--quick` flag for fast validation
2. **Run full suite before PR** - Ensure all tests pass before committing
3. **Check service logs** - If tests fail, check container logs
4. **Use --verbose for debugging** - Shows detailed test output
5. **Keep services running** - Faster test iterations during development

## Test Execution Time

| Test Suite | Quick Mode | Full Mode |
|------------|------------|-----------|
| Backend Smoke | 30s | - |
| Backend Full | - | ~10 min |
| RADA Smoke | 30s | - |
| RADA Full | - | ~5 min |
| **Total (Quick)** | **~1 min** | - |
| **Total (Full)** | - | **~15 min** |

## Related Documentation

- `LOCAL_DEVELOPMENT.md` - Local deployment guide
- `LOCAL_DEPLOYMENT_FIXES.md` - Recent fixes and improvements
- `../mcp_backend/src/api/__tests__/README.md` - API test details
- `../mcp_rada/README.md` - RADA MCP documentation

---

**Need help?** Check the main documentation or run `./run-local-tests.sh --help`
