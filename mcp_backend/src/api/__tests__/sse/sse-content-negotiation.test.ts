/**
 * Content Negotiation Tests for SSE
 *
 * Tests the Accept header content negotiation between JSON and SSE responses.
 * Tools can respond with either JSON or SSE based on the Accept header.
 *
 * Prerequisites:
 * - HTTP server must be running on TEST_BASE_URL (default: http://localhost:3000)
 * - Valid API key in TEST_API_KEY (default: test-key-123)
 *
 * Run tests:
 * npm test -- sse-content-negotiation.test.ts
 */

import axios from 'axios';

describe('SSE Content Negotiation Tests', () => {
  const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
  const API_KEY = process.env.TEST_API_KEY || 'test-key-123';

  describe('Accept Header: text/event-stream', () => {
    it('should return SSE stream when Accept: text/event-stream is set', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent`,
        {
          arguments: { query: 'тестовий запит' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'text/event-stream',
          },
          responseType: 'text',
          timeout: 60000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');

      // Verify SSE format
      expect(response.data).toContain('event: ');
      expect(response.data).toContain('data: ');
    }, 65000);

    it('should stream search_court_cases via Accept header', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/search_court_cases`,
        {
          arguments: {
            query: 'договір',
            limit: 5,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'text/event-stream',
          },
          responseType: 'text',
          timeout: 60000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');

      // Parse events
      const lines = response.data.split('\n');
      const eventTypes = lines
        .filter((line: string) => line.startsWith('event: '))
        .map((line: string) => line.substring(7).trim());

      expect(eventTypes).toContain('connected');
      expect(eventTypes).toContain('end');
    }, 65000);
  });

  describe('Accept Header: application/json (default)', () => {
    it('should return JSON when Accept: application/json is set', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent`,
        {
          arguments: { query: 'тестовий запит' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
          },
          timeout: 60000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      // Verify JSON structure
      expect(response.data).toHaveProperty('success');
      expect(response.data).toHaveProperty('result');
    }, 65000);

    it('should return JSON when no Accept header is provided', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent`,
        {
          arguments: { query: 'тестовий запит' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          timeout: 60000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.data).toHaveProperty('success');
    }, 65000);
  });

  describe('Accept Header Priority', () => {
    it('should prioritize text/event-stream when both are specified', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent`,
        {
          arguments: { query: 'test' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'text/event-stream, application/json',
          },
          responseType: 'text',
          timeout: 60000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
    }, 65000);

    it('should handle quality values in Accept header', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent`,
        {
          arguments: { query: 'test' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'text/event-stream;q=1.0, application/json;q=0.8',
          },
          responseType: 'text',
          timeout: 60000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
    }, 65000);
  });

  describe('All Tools Support Content Negotiation', () => {
    const toolsToTest = [
      'classify_intent',
      'search_court_cases',
      'semantic_search',
      'search_legislation',
      'find_legal_patterns',
    ];

    toolsToTest.forEach(toolName => {
      it(`should support SSE for ${toolName} via Accept header`, async () => {
        const arguments_map: Record<string, any> = {
          classify_intent: { query: 'test' },
          search_court_cases: { query: 'договір', limit: 3 },
          semantic_search: { query: 'договір', limit: 3 },
          search_legislation: { query: 'конституція', limit: 3 },
          find_legal_patterns: { query: 'договір', limit: 3 },
        };

        const response = await axios.post(
          `${BASE_URL}/api/tools/${toolName}`,
          {
            arguments: arguments_map[toolName],
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${API_KEY}`,
              'Accept': 'text/event-stream',
            },
            responseType: 'text',
            timeout: 60000,
          }
        );

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/event-stream');
      }, 65000);
    });
  });

  describe('Invalid Accept Header', () => {
    it('should fallback to JSON for unsupported Accept types', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent`,
        {
          arguments: { query: 'test' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'text/xml',
          },
          timeout: 60000,
        }
      );

      expect(response.status).toBe(200);
      // Should fallback to JSON
      expect(response.headers['content-type']).toContain('application/json');
    }, 65000);

    it('should handle wildcard Accept header', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent`,
        {
          arguments: { query: 'test' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': '*/*',
          },
          timeout: 60000,
        }
      );

      expect(response.status).toBe(200);
      // Should return JSON by default
      expect(response.headers['content-type']).toContain('application/json');
    }, 65000);
  });

  describe('Dedicated Streaming Endpoint Precedence', () => {
    it('should use SSE regardless of Accept header for /stream endpoint', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent/stream`,
        {
          arguments: { query: 'test' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json', // Explicitly request JSON
          },
          responseType: 'text',
          timeout: 60000,
        }
      );

      expect(response.status).toBe(200);
      // /stream endpoint should always return SSE
      expect(response.headers['content-type']).toContain('text/event-stream');
    }, 65000);
  });
});
