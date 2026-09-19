module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        esModuleInterop: true,
      },
    }],
    '^.+\\.js$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        esModuleInterop: true,
        allowJs: true,
      },
    }],
  },
  // These suites drive a LIVE backend over HTTP (axios against localhost:3000) — they are
  // integration tests, not unit tests, and can never pass in a plain `jest` run. Leaving them
  // in the default run kept the suite permanently red (126 of 154 failures), which is what let
  // a genuinely broken change reach production unnoticed. Run them with `npm run test:integration`
  // against a started server.
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/api/__tests__/sse/',
    '<rootDir>/src/api/__tests__/all-tools-integration.test.ts',
    '<rootDir>/src/api/__tests__/smoke-test-all-tools.test.ts',
    '<rootDir>/src/api/__tests__/get-case-documents-chain.test.ts',
    '<rootDir>/src/api/__tests__/get-legal-advice-cpc-gpc.test.ts',
    '<rootDir>/src/api/__tests__/search-legal-precedents.test.ts',
    // Modernised to the ToolRegistry constructor (it predated the unified gateway and no longer
    // compiled), but its handleSSEConnection cases keep the SSE response open and the suite
    // HANGS rather than finishing — a hanging test is worse in CI than a failing one. Its live
    // coverage of tools/list is already carried by mcp-sse-tools-whitelist.test.ts. Rewriting the
    // connection-lifecycle cases is tracked in LEXAI-1930.
    '<rootDir>/src/api/__tests__/mcp-sse-server.test.ts',
    // Same category as its neighbours above and misfiled until 2026-09-19: it needs
    // GOOGLE_APPLICATION_CREDENTIALS, OPENAI_API_KEY and a ../test_data directory that
    // is not in the repository, so it can never pass in a plain `jest` run.
    //
    // ⚠ It did not merely fail, it failed to COMPILE, so its own
    // `SKIP_TESTS = !GOOGLE_APPLICATION_CREDENTIALS || !OPENAI_API_KEY` guard never ran:
    // `console.log` does not type-check under ts-jest here. @types/node 25 declares a
    // global `interface Console extends console.Console {}` (web-globals/console.d.ts)
    // which resolves EMPTY in ts-jest's per-file compilation while plain
    // `tsc -p tsconfig.json` over the same code is fine. Every other console-using suite
    // in this repo was already on this list, which is why nobody had met it. If you add a
    // test that logs, expect this and use process.stdout.write.
    '<rootDir>/src/api/__tests__/document-analysis-e2e.test.ts',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(uuid)/)',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testTimeout: 120000,
  extensionsToTreatAsEsm: [],
  // Show output in real-time
  verbose: true,
  // Don't buffer output
  maxWorkers: 1,
  // Show console output immediately
  silent: false,
};
