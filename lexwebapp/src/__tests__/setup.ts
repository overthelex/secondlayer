/**
 * Test Setup
 * Global test configuration and mocks
 */

import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock environment variables
vi.stubEnv('VITE_API_URL', 'https://test.example.com');
vi.stubEnv('VITE_API_KEY', 'test-key-123');
vi.stubEnv('VITE_ENABLE_SSE_STREAMING', 'true');

// Mock fetch globally
global.fetch = vi.fn();

// Mock AbortController if not available
if (typeof AbortController === 'undefined') {
  global.AbortController = class AbortController {
    signal = { aborted: false };
    abort() {
      this.signal.aborted = true;
    }
  } as any;
}

// Mock ReadableStream
if (typeof ReadableStream === 'undefined') {
  global.ReadableStream = class ReadableStream {
    getReader() {
      return {
        read: vi.fn(),
        releaseLock: vi.fn(),
      };
    }
  } as any;
}

// Mock TextDecoder
if (typeof TextDecoder === 'undefined') {
  global.TextDecoder = class TextDecoder {
    decode(input: any) {
      return input?.toString() || '';
    }
  } as any;
}
