# ZOAdapter Test Suite

Comprehensive tests for the ZOAdapter (Zakononline API adapter).

## Test Files

| File | Description | Coverage |
|------|-------------|----------|
| `zo-adapter.test.ts` | Core adapter functionality | Constructor, domain config, backward compatibility |
| `zo-adapter-domains.test.ts` | Domain configuration | All 4 domains, configuration validation, helper functions |
| `zo-adapter-dictionaries.test.ts` | Reference dictionaries | All 10+ dictionary methods, validation |
| `zo-adapter-errors.test.ts` | Error handling | 6 custom error classes, error factory |
| `zo-adapter-metadata.test.ts` | Advanced features | Metadata queries, sorting, search parameters |

## Running Tests

### Run all ZOAdapter tests
```bash
npm test -- zo-adapter
```

### Run specific test file
```bash
npm test -- zo-adapter.test.ts
npm test -- zo-adapter-domains.test.ts
npm test -- zo-adapter-dictionaries.test.ts
npm test -- zo-adapter-errors.test.ts
npm test -- zo-adapter-metadata.test.ts
```

### Run in watch mode
```bash
npm run test:watch -- zo-adapter
```

### Run with coverage
```bash
npm test -- zo-adapter --coverage
```

## Test Structure

### zo-adapter.test.ts (350+ lines)

Tests core functionality:
- ✅ Constructor variations (4 signatures)
- ✅ Domain configuration retrieval
- ✅ Available targets per domain
- ✅ Target validation
- ✅ Available dictionaries per domain
- ✅ Date field configuration
- ✅ Multi-instance support
- ✅ Backward compatibility
- ✅ Environment variable handling

**Example:**
```typescript
describe('Constructor', () => {
  test('should create adapter with default domain', () => {
    const adapter = new ZOAdapter();
    expect(adapter.getDomain().name).toBe('court_decisions');
  });

  test('should create adapter with specific domain', () => {
    const adapter = new ZOAdapter('legal_acts');
    expect(adapter.getDomain().name).toBe('legal_acts');
  });
});
```

### zo-adapter-domains.test.ts (350+ lines)

Tests domain configuration system:
- ✅ ZAKONONLINE_DOMAINS object structure
- ✅ All 4 domain configurations
- ✅ Domain-specific endpoints
- ✅ Available targets per domain
- ✅ Date fields per domain
- ✅ Helper functions (getDomainConfig, isValidTarget, etc.)
- ✅ Configuration consistency
- ✅ Base URL patterns

**Example:**
```typescript
describe('isValidTarget()', () => {
  test('should validate text target for court_decisions', () => {
    expect(isValidTarget('court_decisions', 'text')).toBe(true);
  });

  test('should reject cause_num target for court_decisions', () => {
    expect(isValidTarget('court_decisions', 'cause_num')).toBe(false);
  });
});
```

### zo-adapter-dictionaries.test.ts (350+ lines)

Tests reference dictionary methods:
- ✅ Generic getDictionary() method
- ✅ Domain-specific dictionary methods (10+)
- ✅ Dictionary availability per domain
- ✅ Validation for unavailable dictionaries
- ✅ Error messages
- ✅ Shared dictionaries across domains
- ✅ Method signatures and parameters

**Example:**
```typescript
describe('Court Decisions Domain - Dictionaries', () => {
  test('should have courts dictionary method', () => {
    expect(courtAdapter.getCourtsDictionary).toBeDefined();
  });

  test('should list all available dictionaries', () => {
    const dictionaries = courtAdapter.getAvailableDictionaries();
    expect(dictionaries).toContain('courts');
    expect(dictionaries).toContain('judges');
  });
});
```

### zo-adapter-errors.test.ts (300+ lines)

Tests error handling:
- ✅ All 6 custom error classes
- ✅ Error properties and messages
- ✅ Error inheritance chain
- ✅ createZakonOnlineError factory function
- ✅ Error creation for different HTTP status codes
- ✅ Error message quality
- ✅ Stack traces

**Example:**
```typescript
describe('createZakonOnlineError', () => {
  test('should create RateLimitError for 429 status', () => {
    const axiosError = {
      response: { status: 429, headers: { 'retry-after': '60' } },
      message: 'Rate limited',
    };

    const error = createZakonOnlineError(axiosError, '/v1/search', {});

    expect(error).toBeInstanceOf(ZakonOnlineRateLimitError);
    expect(error.retryAfter).toBe(60000);
  });
});
```

### zo-adapter-metadata.test.ts (350+ lines)

Tests advanced features:
- ✅ Metadata query method (getSearchMetadata)
- ✅ Search parameter validation
- ✅ Target configuration and validation
- ✅ Sorting (orderBy parameter)
- ✅ Where conditions
- ✅ Pagination parameters
- ✅ Complex query scenarios
- ✅ Domain-specific sort fields

**Example:**
```typescript
describe('getSearchMetadata()', () => {
  test('should validate target for metadata query', async () => {
    await expect(async () => {
      await adapter.getSearchMetadata({
        meta: { search: 'test' },
        target: 'invalid_target',
      });
    }).rejects.toThrow(ZakonOnlineValidationError);
  });
});
```

## Test Coverage

### By Feature

| Feature | Test Count | Files |
|---------|-----------|-------|
| Multi-domain architecture | 40+ | zo-adapter.test.ts, zo-adapter-domains.test.ts |
| Reference dictionaries | 50+ | zo-adapter-dictionaries.test.ts |
| Error handling | 40+ | zo-adapter-errors.test.ts |
| Metadata queries | 20+ | zo-adapter-metadata.test.ts |
| Sorting | 15+ | zo-adapter-metadata.test.ts |
| Target validation | 25+ | zo-adapter.test.ts, zo-adapter-metadata.test.ts |

### By Domain

Each of the 4 domains (court_decisions, court_sessions, legal_acts, court_practice) has dedicated tests covering:
- Configuration
- Available targets
- Date fields
- Dictionaries
- Sort fields

## Mocking Strategy

Tests use Jest mocks for external dependencies:

```typescript
// Mock axios to avoid real API calls
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

beforeEach(() => {
  const mockAxiosInstance = {
    get: jest.fn(),
    defaults: { headers: {} },
  };
  mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);
});
```

## Test Data

Tests use realistic data:
- Real domain names: 'court_decisions', 'court_sessions', 'legal_acts', 'court_practice'
- Real endpoints: '/v1/search', '/v1/search/meta', '/v1/court_sessions/search'
- Real base URLs: 'https://court.searcher.api.zakononline.com.ua'
- Real targets: 'text', 'title', 'cause_num', 'case_involved'
- Real dictionary names: 'courts', 'judges', 'regions', 'documentTypes', etc.

## Environment Variables

Tests require these environment variables:
```bash
ZAKONONLINE_API_TOKEN=your-token-here
ZAKONONLINE_API_TOKEN2=your-secondary-token-here  # Optional
```

Set in `.env` file or test environment.

## Common Test Patterns

### Testing Constructor Signatures
```typescript
test('should support old signature: new ZOAdapter()', () => {
  const adapter = new ZOAdapter();
  expect(adapter.getDomain().name).toBe('court_decisions');
});

test('should support new signature: new ZOAdapter("domain")', () => {
  const adapter = new ZOAdapter('legal_acts');
  expect(adapter.getDomain().name).toBe('legal_acts');
});
```

### Testing Validation
```typescript
test('should reject invalid target', async () => {
  await expect(async () => {
    await adapter.getSearchMetadata({
      target: 'invalid_target',
    });
  }).rejects.toThrow(ZakonOnlineValidationError);
});
```

### Testing Error Messages
```typescript
test('should include helpful error message', async () => {
  try {
    await adapter.getDictionary('nonexistent');
  } catch (error) {
    expect(error.message).toContain('Available dictionaries');
    expect(error.message).toContain('courts');
  }
});
```

## Continuous Integration

Tests are designed to run in CI/CD:
- No external API calls (mocked)
- Fast execution (< 5 seconds total)
- No database dependencies (adapter-level tests only)
- No Redis dependencies (mocked)

## Contributing

When adding new features to ZOAdapter:

1. Add tests to appropriate file(s)
2. Follow existing test structure
3. Use descriptive test names
4. Include both positive and negative test cases
5. Test error messages and validation
6. Update this README if adding new test files

## References

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [ZOAdapter Implementation](../zo-adapter.ts)
- [Domain Configuration](../../types/zakononline-domains.ts)
- [Error Classes](../zakononline-errors.ts)
