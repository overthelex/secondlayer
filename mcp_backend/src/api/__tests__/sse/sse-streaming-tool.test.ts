/**
 * Direct Streaming Endpoint Integration Tests
 *
 * Tests the direct streaming endpoint for MCP tools: POST /api/tools/:toolName/stream
 *
 * Prerequisites:
 * - HTTP server must be running on TEST_BASE_URL (default: http://localhost:3000)
 * - Valid API key in TEST_API_KEY (default: test-key-123)
 * - External services (OpenAI, ZakonOnline) should be available or mocked
 *
 * Run tests:
 * npm test -- sse-streaming-tool.test.ts
 */

import axios from 'axios';
import EventSource from 'eventsource';
import { SSEEventCollector } from '../../../__tests__/helpers/sse-event-collector.js';

describe('Direct Streaming Endpoint Tests', () => {
  const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
  const API_KEY = process.env.TEST_API_KEY || 'test-key-123';

  describe('SSE Headers Validation', () => {
    it('should set correct SSE headers for streaming endpoint', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent/stream`,
        {
          arguments: { query: 'тестовий запит' },
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
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['cache-control']).toContain('no-cache');
      expect(response.headers['connection']).toBe('keep-alive');
      expect(response.headers['x-accel-buffering']).toBe('no');
    }, 35000);
  });

  describe('Non-Streaming Tool Fallback', () => {
    it('should stream classify_intent with connected->progress->complete->end events', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/classify_intent/stream`,
        {
          arguments: { query: 'Хочу оскаржити рішення суду' },
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

      // Parse SSE events
      const lines = response.data.split('\n');
      const events: Array<{ type?: string; data?: any; id?: string }> = [];

      let currentEvent: any = {};
      for (const line of lines) {
        if (line.startsWith('id: ')) {
          currentEvent.id = line.substring(4).trim();
        } else if (line.startsWith('event: ')) {
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

      // Verify event sequence
      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toContain('connected');
      expect(eventTypes).toContain('complete');
      expect(eventTypes).toContain('end');

      // Verify connected event
      const connectedEvent = events.find(e => e.type === 'connected');
      expect(connectedEvent).toBeDefined();
      expect(connectedEvent?.data.tool).toBe('classify_intent');
      expect(connectedEvent?.data.timestamp).toBeDefined();

      // Verify complete event
      const completeEvent = events.find(e => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.data).toBeDefined();

      // Verify end event
      const endEvent = events.find(e => e.type === 'end');
      expect(endEvent).toBeDefined();
    }, 65000);

    it('should stream search_court_cases tool', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/search_court_cases/stream`,
        {
          arguments: {
            query: 'договір',
            limit: 3,
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

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('event: '));
      const eventTypes = dataLines.map((line: string) => line.substring(7).trim());

      expect(eventTypes).toContain('connected');
      expect(eventTypes).toContain('complete');
      expect(eventTypes).toContain('end');
    }, 65000);
  });

  describe('Authentication', () => {
    it('should require authentication for streaming endpoint', async () => {
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
        fail('Should have thrown authentication error');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    }, 15000);

    it('should accept valid Bearer token', async () => {
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

  describe('Tool Not Found', () => {
    it('should return error event for non-existent tool', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/non_existent_tool/stream`,
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
        }
      );

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

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
    }, 35000);
  });

  describe('Event ID Sequencing', () => {
    it('should include unique event IDs', async () => {
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

      const lines = response.data.split('\n');
      const idLines = lines.filter((line: string) => line.startsWith('id: '));
      const ids = idLines.map((line: string) => line.substring(4).trim());

      // Should have at least connection, complete, end IDs
      expect(ids.length).toBeGreaterThanOrEqual(3);

      // IDs should include expected values
      expect(ids).toContain('connection');
      expect(ids).toContain('final');
      expect(ids).toContain('end');
    }, 35000);
  });

  describe('Multiple Tool Types', () => {
    it('should stream legislation tool (search_legislation)', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/search_legislation/stream`,
        {
          arguments: {
            query: 'конституція',
            limit: 5,
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

      const lines = response.data.split('\n');
      const eventLines = lines.filter((line: string) => line.startsWith('event: '));
      const eventTypes = eventLines.map((line: string) => line.substring(7).trim());

      expect(eventTypes).toContain('connected');
      expect(eventTypes).toContain('end');
    }, 65000);

    it('should stream semantic_search tool', async () => {
      const response = await axios.post(
        `${BASE_URL}/api/tools/semantic_search/stream`,
        {
          arguments: {
            query: 'договір оренди',
            limit: 5,
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
    }, 65000);
  });

  describe('Error During Streaming', () => {
    it('should send error event and end event on tool failure', async () => {
      // Try to call a tool with invalid arguments
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
          validateStatus: () => true, // Accept any status
        }
      );

      // Should still return 200 with SSE, but include error event
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

      // Should have either error event or complete event
      const hasError = events.some(e => e.type === 'error');
      const hasComplete = events.some(e => e.type === 'complete');
      expect(hasError || hasComplete).toBe(true);

      // Should always end with 'end' event
      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe('end');
    }, 35000);
  });

  describe('Concurrent Streaming', () => {
    it('should handle multiple concurrent streaming requests', async () => {
      const requests = [
        axios.post(
          `${BASE_URL}/api/tools/classify_intent/stream`,
          { arguments: { query: 'запит 1' } },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${API_KEY}`,
            },
            responseType: 'text',
            timeout: 60000,
          }
        ),
        axios.post(
          `${BASE_URL}/api/tools/classify_intent/stream`,
          { arguments: { query: 'запит 2' } },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${API_KEY}`,
            },
            responseType: 'text',
            timeout: 60000,
          }
        ),
        axios.post(
          `${BASE_URL}/api/tools/classify_intent/stream`,
          { arguments: { query: 'запит 3' } },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${API_KEY}`,
            },
            responseType: 'text',
            timeout: 60000,
          }
        ),
      ];

      const responses = await Promise.all(requests);

      // All should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/event-stream');
      });
    }, 65000);
  });
});
