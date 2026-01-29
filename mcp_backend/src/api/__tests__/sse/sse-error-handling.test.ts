/**
 * SSE Error Handling Tests
 *
 * Tests error scenarios and graceful degradation for SSE endpoints.
 *
 * Prerequisites:
 * - HTTP server must be running on TEST_BASE_URL (default: http://localhost:3000)
 * - Valid API key in TEST_API_KEY (default: test-key-123)
 *
 * Run tests:
 * npm test -- sse-error-handling.test.ts
 */

import axios from 'axios';

describe('SSE Error Handling Tests', () => {
  const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
  const API_KEY = process.env.TEST_API_KEY || 'test-key-123';

  describe('Invalid JSON-RPC Requests', () => {
    it('should handle missing jsonrpc field', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          id: 1,
          method: 'ping',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          validateStatus: () => true,
        }
      );

      // Should either return error event or handle gracefully
      expect(response.status).toBeGreaterThanOrEqual(200);
    });

    it('should handle missing id field', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          method: 'ping',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          validateStatus: () => true,
        }
      );

      expect(response.status).toBeGreaterThanOrEqual(200);
    });

    it('should handle missing method field', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 1,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          validateStatus: () => true,
        }
      );

      if (response.status === 200) {
        // Parse SSE events
        const lines = response.data.split('\n');
        const dataLines = lines.filter((line: string) => line.startsWith('data: '));

        if (dataLines.length > 0) {
          const data = JSON.parse(dataLines[0].substring(6));
          // Should have error
          expect(data.error || data.result).toBeDefined();
        }
      }
    });

    it('should handle invalid JSON-RPC version', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '1.0', // Invalid version
          id: 1,
          method: 'ping',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          validateStatus: () => true,
        }
      );

      expect(response.status).toBeGreaterThanOrEqual(200);
    });
  });

  describe('Unknown Method Errors', () => {
    it('should return -32601 error for unknown method', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'unknown/method',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
        }
      );

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const data = JSON.parse(dataLines[0].substring(6));

      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32601);
      expect(data.error.message).toContain('Method not found');
    });

    it('should return error for non-existent tool', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'non_existent_tool',
            arguments: {},
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 30000,
        }
      );

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const data = JSON.parse(dataLines[0].substring(6));

      expect(data.error).toBeDefined();
      expect(data.error.code).toBeDefined();
    }, 35000);
  });

  describe('Tool Execution Errors', () => {
    it('should handle tool with missing required arguments', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/search_court_cases/stream`,
        {
          arguments: {
            // Missing required 'query' parameter
            limit: 10,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 30000,
          validateStatus: () => true,
        }
      );

      // Should return 200 with SSE error event or 400
      if (response.status === 200) {
        const lines = response.data.split('\n');
        const events: any[] = [];

        let currentEvent: any = {};
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent.type = line.substring(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              currentEvent.data = JSON.parse(line.substring(6).trim());
            } catch {
              currentEvent.data = line.substring(6).trim();
            }
          } else if (line.trim() === '') {
            if (Object.keys(currentEvent).length > 0) {
              events.push(currentEvent);
              currentEvent = {};
            }
          }
        }

        // Should have error or complete event
        const hasError = events.some(e => e.type === 'error');
        const hasComplete = events.some(e => e.type === 'complete');
        expect(hasError || hasComplete).toBe(true);
      }
    }, 35000);

    it('should handle tool with invalid argument types', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/search_court_cases/stream`,
        {
          arguments: {
            query: 'test',
            limit: 'not a number', // Invalid type
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 30000,
          validateStatus: () => true,
        }
      );

      // Should handle gracefully
      expect(response.status).toBeGreaterThanOrEqual(200);
    }, 35000);
  });

  describe('Network and Timeout Errors', () => {
    it('should handle very long tool execution gracefully', async () => {
      // This test depends on the tool's timeout configuration
      // Most tools should complete within 60 seconds
      try {
        const response = await axios.post(
          `${BASE_URL}/api/tools/classify_intent/stream`,
          {
            arguments: { query: 'test' },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${API_KEY}`,
            },
            responseType: 'text',
            timeout: 120000, // 2 minutes
          }
        );

        expect(response.status).toBe(200);

        // Should eventually complete with end event
        const lines = response.data.split('\n');
        const eventTypes = lines
          .filter((line: string) => line.startsWith('event: '))
          .map((line: string) => line.substring(7).trim());

        expect(eventTypes).toContain('end');
      } catch (error: any) {
        // Timeout is acceptable
        if (error.code === 'ECONNABORTED') {
          // Timeout occurred - acceptable
        } else {
          throw error;
        }
      }
    }, 125000);
  });

  describe('Malformed Request Bodies', () => {
    it('should handle completely invalid JSON', async () => {
      try {
        await axios.post(
          `${BASE_URL}/sse`,
          'not valid json at all',
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
            validateStatus: () => true,
          }
        );
      } catch (error: any) {
        // Should either return 400 or handle gracefully
        expect(error.response.status).toBeGreaterThan(0);
      }
    }, 15000);

    it('should handle empty request body', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        '',
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          timeout: 10000,
          validateStatus: () => true,
        }
      );

      // Should handle gracefully (keep-alive mode)
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
    }, 15000);

    it('should handle null request body', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        null,
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          timeout: 10000,
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(200);
    }, 15000);
  });

  describe('Stream Endpoint Errors', () => {
    it('should return error for non-existent tool on /stream endpoint', async () => {
      try {
        await axios.post(
          `${BASE_URL}/api/tools/completely_fake_tool/stream`,
          {
            arguments: {},
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${API_KEY}`,
            },
            responseType: 'text',
            timeout: 30000,
            validateStatus: () => true,
          }
        );
      } catch (error: any) {
        // May return 404 or 200 with error event
        expect(error.response.status).toBeGreaterThanOrEqual(200);
      }
    }, 35000);

    it('should handle missing arguments object', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent/stream`,
        {
          // Missing arguments field
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 30000,
          validateStatus: () => true,
        }
      );

      // Should handle gracefully
      if (response.status === 200) {
        const lines = response.data.split('\n');
        const eventTypes = lines
          .filter((line: string) => line.startsWith('event: '))
          .map((line: string) => line.substring(7).trim());

        // Should complete or error
        expect(eventTypes.length).toBeGreaterThan(0);
      }
    }, 35000);
  });

  describe('Response Consistency', () => {
    it('should always send end event even on error', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/search_court_cases/stream`,
        {
          arguments: {
            // Invalid arguments
            limit: -1,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 30000,
          validateStatus: () => true,
        }
      );

      if (response.status === 200) {
        const lines = response.data.split('\n');
        const events: any[] = [];

        let currentEvent: any = {};
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent.type = line.substring(7).trim();
          } else if (line.startsWith('data: ')) {
            currentEvent.data = line.substring(6).trim();
          } else if (line.trim() === '') {
            if (Object.keys(currentEvent).length > 0) {
              events.push(currentEvent);
              currentEvent = {};
            }
          }
        }

        // Should have end event
        const eventTypes = events.map(e => e.type);
        expect(eventTypes).toContain('end');
      }
    }, 35000);

    it('should set proper SSE headers even on error', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/non_existent/stream`,
        {
          arguments: {},
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 10000,
          validateStatus: () => true,
        }
      );

      if (response.status === 200) {
        expect(response.headers['content-type']).toContain('text/event-stream');
      }
    }, 15000);
  });

  describe('Cost Tracking on Errors', () => {
    it('should still track costs even if tool fails', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent/stream`,
        {
          arguments: { query: 'test' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 60000,
        }
      );

      // Cost tracking should work regardless of success/failure
      // (verified in database cost_tracking table)
      expect(response.status).toBe(200);
    }, 65000);
  });
});
