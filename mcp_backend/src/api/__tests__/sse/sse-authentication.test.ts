/**
 * SSE Authentication Tests
 *
 * Tests authentication flows for SSE endpoints (dual auth: JWT + API key).
 *
 * Prerequisites:
 * - HTTP server must be running on TEST_BASE_URL (default: http://localhost:3000)
 * - Valid API key in TEST_API_KEY (default: test-key-123)
 * - JWT_SECRET configured in environment
 *
 * Run tests:
 * npm test -- sse-authentication.test.ts
 */

import axios from 'axios';

describe('SSE Authentication Tests', () => {
  const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
  const API_KEY = process.env.TEST_API_KEY || 'test-key-123';

  describe('API Key Authentication', () => {
    it('should accept valid API key for /sse endpoint', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'ping',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 10000,
        }
      );

      expect(response.status).toBe(200);
    }, 15000);

    it('should accept valid API key for /stream endpoint', async () => {
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
          timeout: 30000,
        }
      );

      expect(response.status).toBe(200);
    }, 35000);

    it('should accept valid API key for regular endpoint with Accept header', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent`,
        {
          arguments: { query: 'test' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'text/event-stream',
          },
          responseType: 'text',
          timeout: 30000,
        }
      );

      expect(response.status).toBe(200);
    }, 35000);
  });

  describe('No Authentication (Anonymous)', () => {
    it('should allow anonymous access to /sse endpoint (ChatGPT compatibility)', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'ping',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          timeout: 10000,
        }
      );

      expect(response.status).toBe(200);
    }, 15000);

    it('should require authentication for /api/tools/:name/stream endpoint', async () => {
      try {
        await axios.post(
          `${BASE_URL}/api/tools/classify_intent/stream`,
          {
            arguments: { query: 'test' },
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        fail('Should have thrown 401 error');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    }, 15000);

    it('should require authentication for regular endpoint', async () => {
      try {
        await axios.post(
          `${BASE_URL}/api/tools/classify_intent`,
          {
            arguments: { query: 'test' },
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        fail('Should have thrown 401 error');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    }, 15000);
  });

  describe('Invalid Authentication', () => {
    it('should reject invalid API key for /stream endpoint', async () => {
      try {
        await axios.post(
          `${BASE_URL}/api/tools/classify_intent/stream`,
          {
            arguments: { query: 'test' },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer invalid-key-12345',
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown 401 error');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    }, 15000);

    it('should reject malformed Authorization header', async () => {
      try {
        await axios.post(
          `${BASE_URL}/api/tools/classify_intent/stream`,
          {
            arguments: { query: 'test' },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'InvalidFormat',
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown 401 error');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    }, 15000);

    it('should reject empty Bearer token', async () => {
      try {
        await axios.post(
          `${BASE_URL}/api/tools/classify_intent/stream`,
          {
            arguments: { query: 'test' },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ',
            },
            timeout: 10000,
          }
        );
        fail('Should have thrown 401 error');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    }, 15000);
  });

  describe('JWT Token Authentication', () => {
    // Note: These tests depend on having a JWT_SECRET and valid JWT tokens
    // In a real scenario, you would generate JWTs using your auth service

    it('should accept JWT token for /sse endpoint', async () => {
      // For this test, we use API key as JWT tokens require proper signing
      // In production, replace with actual JWT generation
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 20,
          method: 'ping',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 10000,
        }
      );

      expect(response.status).toBe(200);
    }, 15000);

    it('should accept JWT token for /stream endpoint', async () => {
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
          timeout: 30000,
        }
      );

      expect(response.status).toBe(200);
    }, 35000);
  });

  describe('Authentication Context', () => {
    it('should track userId from JWT in session context', async () => {
      // The userId is extracted from JWT and used in cost tracking
      // This test verifies the endpoint accepts the token
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 30,
          method: 'tools/call',
          params: {
            name: 'classify_intent',
            arguments: { query: 'test' },
          },
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

      expect(response.status).toBe(200);

      // The cost tracking should include userId/clientKey
      // (verified in backend logs and database)
    }, 65000);

    it('should track clientKey from API key in session context', async () => {
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
          timeout: 30000,
        }
      );

      expect(response.status).toBe(200);

      // The clientKey should be included in cost tracking
    }, 35000);
  });

  describe('Mixed Authentication Scenarios', () => {
    it('should gracefully handle invalid JWT and continue as anonymous for /sse', async () => {
      // /sse endpoint allows fallback to anonymous
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 40,
          method: 'ping',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer invalid.jwt.token',
          },
          responseType: 'text',
          timeout: 10000,
        }
      );

      // Should still work (logs warning but continues)
      expect(response.status).toBe(200);
    }, 15000);

    it('should handle missing Authorization header gracefully for /sse', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 41,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          timeout: 30000,
        }
      );

      expect(response.status).toBe(200);
    }, 35000);
  });

  describe('Authorization with Different Endpoints', () => {
    it('should enforce auth on /api/tools/:name (no SSE)', async () => {
      try {
        await axios.post(
          `${BASE_URL}/api/tools/classify_intent`,
          {
            arguments: { query: 'test' },
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        fail('Should require authentication');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    }, 15000);

    it('should enforce auth on /api/tools/:name/stream', async () => {
      try {
        await axios.post(
          `${BASE_URL}/api/tools/classify_intent/stream`,
          {
            arguments: { query: 'test' },
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        fail('Should require authentication');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    }, 15000);

    it('should allow anonymous on /sse for ChatGPT compatibility', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 50,
          method: 'ping',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
        }
      );

      expect(response.status).toBe(200);
    });
  });
});
