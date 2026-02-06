/**
 * MCPService Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPService } from '../MCPService';
import type { StreamingCallbacks } from '../../../types/api/sse';

describe('MCPService', () => {
  let mcpService: MCPService;
  let mockFetch: any;

  beforeEach(() => {
    mcpService = new MCPService();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('callTool', () => {
    it('should call tool synchronously', async () => {
      const mockResponse = {
        result: {
          content: [
            {
              text: JSON.stringify({
                summary: 'Test answer',
                reasoning_chain: [],
              }),
            },
          ],
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await mcpService.callTool('get_legal_advice', {
        query: 'Test query',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tools/get_legal_advice'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: expect.stringContaining('Bearer'),
          }),
        })
      );

      expect(result).toEqual(mockResponse);
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      await expect(
        mcpService.callTool('get_legal_advice', { query: 'test' })
      ).rejects.toThrow('API Error: 500');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network failure'));

      await expect(
        mcpService.callTool('get_legal_advice', { query: 'test' })
      ).rejects.toThrow('Network failure');
    });
  });

  describe('streamTool', () => {
    it('should stream tool execution', async () => {
      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode('event: progress\ndata: {"step":1}\n\n'),
          })
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode('event: complete\ndata: {"result":"success"}\n\n'),
          })
          .mockResolvedValueOnce({ done: true }),
        releaseLock: vi.fn(),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: {
          getReader: () => mockReader,
        },
      });

      const callbacks: StreamingCallbacks = {
        onProgress: vi.fn(),
        onComplete: vi.fn(),
      };

      const controller = await mcpService.streamTool('get_legal_advice', {}, callbacks);

      expect(controller).toBeInstanceOf(AbortController);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callbacks.onProgress).toHaveBeenCalled();
      expect(callbacks.onComplete).toHaveBeenCalled();
    });

    it('should fallback to sync mode when streaming disabled', async () => {
      // Create service with streaming disabled
      vi.stubEnv('VITE_ENABLE_SSE_STREAMING', 'false');
      const serviceNoStreaming = new MCPService();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'success' }),
      });

      const callbacks: StreamingCallbacks = {
        onComplete: vi.fn(),
        onEnd: vi.fn(),
      };

      await serviceNoStreaming.streamTool('get_legal_advice', {}, callbacks);

      expect(callbacks.onComplete).toHaveBeenCalledWith({ result: { result: 'success' } });
      expect(callbacks.onEnd).toHaveBeenCalled();

      // Restore env
      vi.stubEnv('VITE_ENABLE_SSE_STREAMING', 'true');
    });
  });

  describe('getLegalAdvice', () => {
    it('should return formatted Message', async () => {
      const mockResponse = {
        result: {
          content: [
            {
              text: JSON.stringify({
                summary: 'Legal advice answer',
                reasoning_chain: [
                  { step: 1, action: 'analyze', explanation: 'Analyzing...' },
                ],
                precedent_chunks: [
                  {
                    case_number: '123/2024',
                    court: 'Test Court',
                    date: '2024-01-01',
                    summary: 'Test summary',
                    similarity: 0.95,
                  },
                ],
                source_attribution: [
                  { text: 'Source text', citation: 'Article 1' },
                ],
              }),
            },
          ],
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const message = await mcpService.getLegalAdvice({
        query: 'Test query',
        max_precedents: 5,
      });

      expect(message).toMatchObject({
        role: 'assistant',
        content: 'Legal advice answer',
        isStreaming: false,
      });

      expect(message.thinkingSteps).toHaveLength(1);
      expect(message.decisions).toHaveLength(1);
      expect(message.citations).toHaveLength(1);
    });

    it('should handle errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('API error'));

      const message = await mcpService.getLegalAdvice({
        query: 'Test query',
      });

      expect(message.role).toBe('assistant');
      expect(message.content).toContain('помилка');
    });
  });

  describe('searchCourtCases', () => {
    it('should search court cases', async () => {
      const mockResult = {
        cases: [
          { case_number: '123/2024', court: 'Test Court' },
        ],
        total: 1,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResult,
      });

      const result = await mcpService.searchCourtCases({
        query: 'test',
        limit: 10,
      });

      expect(result).toEqual(mockResult);
    });
  });

  describe('searchLegislation', () => {
    it('should search legislation', async () => {
      const mockResult = {
        legislation: [
          { id: 'law-1', title: 'Test Law', type: 'code' },
        ],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResult,
      });

      const result = await mcpService.searchLegislation({
        query: 'test law',
        limit: 5,
      });

      expect(result).toEqual(mockResult);
    });
  });

  describe('transformToolResultToMessage', () => {
    it('should transform get_legal_advice result', () => {
      const result = {
        summary: 'Test answer',
        reasoning_chain: [{ step: 1, action: 'test' }],
        precedent_chunks: [{ case_number: '123/2024', court: 'Test' }],
      };

      const message = mcpService.transformToolResultToMessage(
        'get_legal_advice',
        result
      );

      expect(message.content).toBe('Test answer');
      expect(message.thinkingSteps).toBeDefined();
      expect(message.decisions).toBeDefined();
    });

    it('should transform search results', () => {
      const result = {
        cases: [
          { case_number: '123/2024', court: 'Test Court', summary: 'Summary' },
        ],
        total: 1,
      };

      const message = mcpService.transformToolResultToMessage(
        'search_court_cases',
        result
      );

      expect(message.content).toContain('123/2024');
      expect(message.content).toContain('Test Court');
    });

    it('should transform legislation results', () => {
      const result = {
        text: 'Article text content',
        legislation_id: 'ccu',
        article_number: '203',
      };

      const message = mcpService.transformToolResultToMessage(
        'get_legislation_article',
        result
      );

      expect(message.content).toContain('Article text content');
      expect(message.content).toContain('203');
    });

    it('should handle unknown tool formats', () => {
      const result = { unknown: 'format' };

      const message = mcpService.transformToolResultToMessage(
        'unknown_tool',
        result
      );

      expect(message.content).toContain('unknown');
    });
  });

  describe('listAvailableTools', () => {
    it('should fetch available tools', async () => {
      const mockTools = [
        { name: 'get_legal_advice', description: 'Get legal advice' },
        { name: 'search_court_cases', description: 'Search cases' },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ tools: mockTools }),
      });

      const tools = await mcpService.listAvailableTools();

      expect(tools).toEqual(mockTools);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tools'),
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const tools = await mcpService.listAvailableTools();

      expect(tools).toEqual([]);
    });
  });

  describe('parseBackendResponse', () => {
    it('should parse nested JSON response', () => {
      const response = {
        result: {
          content: [
            {
              text: JSON.stringify({ answer: 'Test' }),
            },
          ],
        },
      };

      // Access private method via any
      const parsed = (mcpService as any).parseBackendResponse(response);

      expect(parsed).toEqual({ answer: 'Test' });
    });

    it('should handle direct result format', () => {
      const response = {
        result: { answer: 'Test' },
      };

      const parsed = (mcpService as any).parseBackendResponse(response);

      expect(parsed).toEqual({ answer: 'Test' });
    });

    it('should handle plain response', () => {
      const response = { answer: 'Test' };

      const parsed = (mcpService as any).parseBackendResponse(response);

      expect(parsed).toEqual({ answer: 'Test' });
    });

    it('should handle JSON parse errors', () => {
      const response = {
        result: {
          content: [
            {
              text: 'invalid json',
            },
          ],
        },
      };

      const parsed = (mcpService as any).parseBackendResponse(response);

      expect(parsed).toEqual(response);
    });
  });
});
