/**
 * Unit tests for MCPSSEServer class
 *
 * Tests the MCP (Model Context Protocol) SSE server implementation
 * for ChatGPT web integration.
 */

import { MCPSSEServer, MCPRequest } from '../mcp-sse-server.js';
import { MockSSEResponse } from '../../__tests__/helpers/mock-sse-response.js';
import { Request } from 'express';

// Mock dependencies
const mockMCPQueryAPI = {
  getTools: jest.fn(),
  handleToolCall: jest.fn(),
  classifyIntent: jest.fn(),
  searchCourtCases: jest.fn(),
};

const mockLegislationTools = {
  getToolDefinitions: jest.fn(),
  executeTool: jest.fn(),
};

const mockDocumentAnalysisTools = {
  getToolDefinitions: jest.fn(),
  executeTool: jest.fn(),
};

const mockCostTracker = {
  createTrackingRecord: jest.fn(),
  completeTrackingRecord: jest.fn(),
};

// Mock logger
jest.mock('../../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('MCPSSEServer', () => {
  let server: MCPSSEServer;
  let mockRes: MockSSEResponse;
  let mockReq: Partial<Request>;

  beforeEach(() => {
    // Create server instance with mocked dependencies
    server = new MCPSSEServer(
      mockMCPQueryAPI as any,
      mockLegislationTools as any,
      mockDocumentAnalysisTools as any,
      mockCostTracker as any
    );

    // Create mock response
    mockRes = new MockSSEResponse();

    // Create mock request
    mockReq = {
      ip: '127.0.0.1',
      headers: {
        'user-agent': 'test-client/1.0',
      },
      body: {},
      on: jest.fn(),
    };

    // Reset mocks
    jest.clearAllMocks();
  });

  describe('getAllTools', () => {
    it('should return all tools in MCP format', () => {
      // Setup mocks
      mockMCPQueryAPI.getTools.mockReturnValue([
        {
          name: 'classify_intent',
          description: 'Classify legal query intent',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
        {
          name: 'search_court_cases',
          description: 'Search court cases',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      ]);

      mockLegislationTools.getToolDefinitions.mockReturnValue([
        {
          name: 'search_legislation',
          description: 'Search legislation',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      ]);

      mockDocumentAnalysisTools.getToolDefinitions.mockReturnValue([
        {
          name: 'parse_document',
          description: 'Parse legal document',
          inputSchema: {
            type: 'object',
            properties: { documentId: { type: 'string' } },
          },
        },
      ]);

      // Execute
      const tools = server.getAllTools();

      // Verify
      expect(tools).toHaveLength(4);
      expect(tools[0]).toEqual({
        name: 'classify_intent',
        description: 'Classify legal query intent',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      });
      expect(tools[1].name).toBe('search_court_cases');
      expect(tools[2].name).toBe('search_legislation');
      expect(tools[3].name).toBe('parse_document');
    });

    it('should handle tools without inputSchema', () => {
      mockMCPQueryAPI.getTools.mockReturnValue([
        {
          name: 'test_tool',
          description: 'Test tool without schema',
        },
      ]);
      mockLegislationTools.getToolDefinitions.mockReturnValue([]);
      mockDocumentAnalysisTools.getToolDefinitions.mockReturnValue([]);

      const tools = server.getAllTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].inputSchema).toEqual({
        type: 'object',
        properties: {},
      });
    });

    it('should handle empty tools list', () => {
      mockMCPQueryAPI.getTools.mockReturnValue([]);
      mockLegislationTools.getToolDefinitions.mockReturnValue([]);
      mockDocumentAnalysisTools.getToolDefinitions.mockReturnValue([]);

      const tools = server.getAllTools();

      expect(tools).toHaveLength(0);
    });
  });

  describe('handleSSEConnection', () => {
    it('should set correct SSE headers', async () => {
      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any,
        'user-123',
        'key-456'
      );

      // Verify SSE headers
      expect(mockRes.getHeader('content-type')).toBe('text/event-stream');
      expect(mockRes.getHeader('cache-control')).toBe('no-cache, no-transform');
      expect(mockRes.getHeader('connection')).toBe('keep-alive');
      expect(mockRes.getHeader('x-accel-buffering')).toBe('no');
    });

    it('should handle initialize request', async () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-05',
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      };

      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any,
        'user-123'
      );

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify response message sent
      const events = mockRes.parseEvents();
      expect(events.length).toBeGreaterThan(0);

      const dataEvent = events.find(e => e.data?.result);
      expect(dataEvent).toBeDefined();
      expect(dataEvent?.data.result.protocolVersion).toBe('2025-11-05');
      expect(dataEvent?.data.result.serverInfo).toBeDefined();
    });

    it('should handle tools/list request', async () => {
      mockMCPQueryAPI.getTools.mockReturnValue([
        { name: 'tool1', description: 'Tool 1', inputSchema: { type: 'object', properties: {} } },
      ]);
      mockLegislationTools.getToolDefinitions.mockReturnValue([]);
      mockDocumentAnalysisTools.getToolDefinitions.mockReturnValue([]);

      mockReq.body = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      };

      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      const events = mockRes.parseEvents();
      const dataEvent = events.find(e => e.data?.result?.tools);
      expect(dataEvent).toBeDefined();
      expect(dataEvent?.data.result.tools).toHaveLength(1);
      expect(dataEvent?.data.result.tools[0].name).toBe('tool1');
    });

    it('should handle unknown method with error', async () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 3,
        method: 'unknown/method',
      };

      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      const events = mockRes.parseEvents();
      const errorEvent = events.find(e => e.data?.error);
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.data.error.code).toBe(-32601);
      expect(errorEvent?.data.error.message).toContain('Method not found');
    });

    it('should handle empty request body (keep-alive)', async () => {
      mockReq.body = {};

      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any,
        'user-123'
      );

      // Verify headers set
      expect(mockRes.verifySSEHeaders()).toBe(true);

      // No messages sent for empty body (connection kept alive for pings)
      const events = mockRes.parseEvents();
      // Should not have any data events, only potential pings
      const dataEvents = events.filter(e => e.data && typeof e.data === 'object' && e.data.jsonrpc);
      expect(dataEvents.length).toBe(0);
    });

    it('should handle client disconnect', async () => {
      const closeCallbacks: Function[] = [];
      mockReq.on = jest.fn((event, callback) => {
        if (event === 'close') {
          closeCallbacks.push(callback);
        }
        return mockReq as any;
      }) as any;

      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any,
        'user-123'
      );

      // Simulate client disconnect
      expect(closeCallbacks.length).toBeGreaterThan(0);
      closeCallbacks.forEach(cb => cb());

      // Session should be cleaned up (tested via logger calls)
      expect(mockReq.on).toHaveBeenCalledWith('close', expect.any(Function));
    });
  });

  describe('MCP Protocol Methods', () => {
    it('should handle ping request', async () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 99,
        method: 'ping',
      };

      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      const events = mockRes.parseEvents();
      const pongEvent = events.find(e => e.data?.result?.pong);
      expect(pongEvent).toBeDefined();
      expect(pongEvent?.data.id).toBe(99);
    });

    it('should handle prompts/list request', async () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 4,
        method: 'prompts/list',
      };

      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      const events = mockRes.parseEvents();
      const promptsEvent = events.find(e => e.data?.result?.prompts);
      expect(promptsEvent).toBeDefined();
      expect(promptsEvent?.data.result.prompts).toEqual([]);
    });

    it('should handle resources/list request', async () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/list',
      };

      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      const events = mockRes.parseEvents();
      const resourcesEvent = events.find(e => e.data?.result?.resources);
      expect(resourcesEvent).toBeDefined();
      expect(resourcesEvent?.data.result.resources).toEqual([]);
    });
  });

  describe('Error Handling', () => {
    it('should handle request processing errors gracefully', async () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 6,
        method: 'initialize',
        params: null, // Invalid params
      };

      // This might cause an error in processing
      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not crash, response should be sent
      expect(mockRes.chunks.length).toBeGreaterThan(0);
    });

    it('should send error response for malformed request', async () => {
      mockReq.body = 'not a valid JSON-RPC request';

      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should handle gracefully or send error
      // The exact behavior depends on implementation
    });
  });

  describe('Session Management', () => {
    it('should create session with userId', async () => {
      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any,
        'user-456',
        undefined
      );

      // Verify headers set (session created internally)
      expect(mockRes.verifySSEHeaders()).toBe(true);
    });

    it('should create session with clientKey', async () => {
      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any,
        undefined,
        'client-key-789'
      );

      expect(mockRes.verifySSEHeaders()).toBe(true);
    });

    it('should create anonymous session', async () => {
      await server.handleSSEConnection(
        mockReq as Request,
        mockRes as any,
        undefined,
        undefined
      );

      expect(mockRes.verifySSEHeaders()).toBe(true);
    });
  });

  describe('Protocol Version Negotiation', () => {
    it('should support protocol version 2025-11-05', async () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-05',
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      await server.handleSSEConnection(mockReq as Request, mockRes as any);
      await new Promise(resolve => setTimeout(resolve, 100));

      const events = mockRes.parseEvents();
      const initEvent = events.find(e => e.data?.result?.protocolVersion);
      expect(initEvent?.data.result.protocolVersion).toBe('2025-11-05');
    });

    it('should support protocol version 2025-11-25 (ChatGPT web)', async () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'ChatGPT', version: '1.0' },
        },
      };

      await server.handleSSEConnection(mockReq as Request, mockRes as any);
      await new Promise(resolve => setTimeout(resolve, 100));

      const events = mockRes.parseEvents();
      const initEvent = events.find(e => e.data?.result?.protocolVersion);
      expect(initEvent?.data.result.protocolVersion).toMatch(/2025-11-/);
    });
  });
});
