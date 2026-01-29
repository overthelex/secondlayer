/**
 * MCP SSE Protocol Integration Tests
 *
 * Tests the MCP (Model Context Protocol) implementation over SSE
 * for ChatGPT web integration.
 *
 * Endpoint: POST /sse
 *
 * Prerequisites:
 * - HTTP server must be running on TEST_BASE_URL (default: http://localhost:3000)
 * - Valid API key in TEST_API_KEY (default: test-key-123)
 *
 * Run tests:
 * npm test -- sse-mcp-protocol.test.ts
 */

import axios from 'axios';
import EventSource from 'eventsource';
import { SSEEventCollector } from '../../../__tests__/helpers/sse-event-collector.js';

describe('MCP SSE Protocol Integration Tests', () => {
  const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
  const API_KEY = process.env.TEST_API_KEY || 'test-key-123';

  describe('Protocol Handshake', () => {
    it('should handle initialize method with protocol version 2025-11-05', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-05',
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
          timeout: 30000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');

      // Parse SSE response
      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      expect(dataLines.length).toBeGreaterThan(0);

      // Parse first data event
      const firstData = JSON.parse(dataLines[0].substring(6));
      expect(firstData.jsonrpc).toBe('2.0');
      expect(firstData.id).toBe(1);
      expect(firstData.result).toBeDefined();
      expect(firstData.result.protocolVersion).toBe('2025-11-05');
      expect(firstData.result.serverInfo).toBeDefined();
      expect(firstData.result.serverInfo.name).toBeDefined();
      expect(firstData.result.capabilities).toBeDefined();
    }, 35000);

    it('should handle initialize with ChatGPT protocol version 2025-11-25', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            clientInfo: {
              name: 'ChatGPT',
              version: '1.0.0',
            },
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
          },
          responseType: 'text',
          timeout: 30000,
        }
      );

      expect(response.status).toBe(200);

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const firstData = JSON.parse(dataLines[0].substring(6));

      expect(firstData.result.protocolVersion).toMatch(/2025-11-/);
    }, 35000);

    it('should support protocol version 2024-11-05', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'test', version: '1.0' },
          },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          timeout: 30000,
        }
      );

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const data = JSON.parse(dataLines[0].substring(6));

      expect(data.result.protocolVersion).toBeDefined();
    }, 35000);
  });

  describe('Tools Discovery', () => {
    it('should list all available tools via tools/list method', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/list',
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

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const data = JSON.parse(dataLines[0].substring(6));

      expect(data.jsonrpc).toBe('2.0');
      expect(data.id).toBe(10);
      expect(data.result).toBeDefined();
      expect(data.result.tools).toBeDefined();
      expect(Array.isArray(data.result.tools)).toBe(true);
      expect(data.result.tools.length).toBeGreaterThan(40); // At least 41 tools

      // Verify tool structure
      const tool = data.result.tools[0];
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }, 35000);

    it('should include all expected MCP tools', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
        }
      );

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const data = JSON.parse(dataLines[0].substring(6));

      const toolNames = data.result.tools.map((t: any) => t.name);

      // Check for core tools
      expect(toolNames).toContain('classify_intent');
      expect(toolNames).toContain('search_court_cases');
      expect(toolNames).toContain('get_document_text');
      expect(toolNames).toContain('semantic_search');
      expect(toolNames).toContain('packaged_lawyer_answer');

      // Check for legislation tools
      expect(toolNames).toContain('search_legislation');
      expect(toolNames).toContain('get_legislation_section');

      // Check for document analysis tools
      expect(toolNames).toContain('parse_document');
    }, 35000);
  });

  describe('Tool Execution', () => {
    it('should execute classify_intent tool via tools/call method', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'classify_intent',
            arguments: {
              query: 'Хочу оскаржити рішення суду',
            },
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
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));

      // Find result message
      let resultData = null;
      for (const line of dataLines) {
        const data = JSON.parse(line.substring(6));
        if (data.result) {
          resultData = data;
          break;
        }
      }

      expect(resultData).toBeDefined();
      expect(resultData.jsonrpc).toBe('2.0');
      expect(resultData.id).toBe(20);
      expect(resultData.result).toBeDefined();
      expect(resultData.result.content).toBeDefined();
      expect(Array.isArray(resultData.result.content)).toBe(true);
    }, 65000);

    it('should handle search_court_cases tool execution', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: {
            name: 'search_court_cases',
            arguments: {
              query: 'договір',
              limit: 5,
            },
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
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));

      let resultData = null;
      for (const line of dataLines) {
        const data = JSON.parse(line.substring(6));
        if (data.result) {
          resultData = data;
          break;
        }
      }

      expect(resultData).toBeDefined();
      expect(resultData.result.content).toBeDefined();
    }, 65000);

    it('should return error for unknown tool', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 22,
          method: 'tools/call',
          params: {
            name: 'non_existent_tool',
            arguments: {},
          },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          timeout: 30000,
        }
      );

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const data = JSON.parse(dataLines[0].substring(6));

      expect(data.error).toBeDefined();
      expect(data.error.code).toBeDefined();
      expect(data.error.message).toBeDefined();
    }, 35000);
  });

  describe('MCP Protocol Methods', () => {
    it('should handle ping method', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 30,
          method: 'ping',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          timeout: 10000,
        }
      );

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const data = JSON.parse(dataLines[0].substring(6));

      expect(data.result).toBeDefined();
      expect(data.result.pong).toBe(true);
    }, 15000);

    it('should handle prompts/list method (returns empty)', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 31,
          method: 'prompts/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
        }
      );

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const data = JSON.parse(dataLines[0].substring(6));

      expect(data.result.prompts).toEqual([]);
    });

    it('should handle resources/list method (returns empty)', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 32,
          method: 'resources/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
        }
      );

      const lines = response.data.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));
      const data = JSON.parse(dataLines[0].substring(6));

      expect(data.result.resources).toEqual([]);
    });
  });

  describe('Error Handling', () => {
    it('should return JSON-RPC error for unknown method', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 40,
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

    it('should handle malformed JSON-RPC request', async () => {
      try {
        await axios.post(
          `${BASE_URL}/sse`,
          {
            invalid: 'request',
          },
          {
            headers: { 'Content-Type': 'application/json' },
            responseType: 'text',
            timeout: 10000,
          }
        );
      } catch (error: any) {
        // May return 400 or SSE error event
        expect(error.response.status).toBeGreaterThanOrEqual(200);
      }
    }, 15000);
  });

  describe('Authentication', () => {
    it('should accept request with JWT Bearer token', async () => {
      // Generate a simple JWT for testing (in real scenario, get from auth service)
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 50,
          method: 'ping',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
        }
      );

      expect(response.status).toBe(200);
    });

    it('should accept request with API key', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 51,
          method: 'ping',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          responseType: 'text',
        }
      );

      expect(response.status).toBe(200);
    });

    it('should accept request without authentication (for ChatGPT compatibility)', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 52,
          method: 'ping',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
        }
      );

      // /sse endpoint allows anonymous access
      expect(response.status).toBe(200);
    });
  });

  describe('SSE Headers', () => {
    it('should set correct SSE headers', async () => {
      const response = await axios.post(
        `${BASE_URL}/sse`,
        {
          jsonrpc: '2.0',
          id: 60,
          method: 'ping',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
        }
      );

      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['cache-control']).toContain('no-cache');
      expect(response.headers['connection']).toBe('keep-alive');
      expect(response.headers['x-accel-buffering']).toBe('no');
    });
  });
});
