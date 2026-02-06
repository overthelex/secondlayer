/**
 * SSEClient Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEClient } from '../SSEClient';
import type { StreamingCallbacks } from '../../../types/api/sse';

describe('SSEClient', () => {
  let sseClient: SSEClient;
  let mockFetch: any;

  beforeEach(() => {
    sseClient = new SSEClient('https://test.example.com/api', 'test-key');
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('streamTool', () => {
    it('should establish SSE connection', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('event: connected\ndata: {"message":"connected"}\n\n'),
              })
              .mockResolvedValueOnce({ done: true }),
            releaseLock: vi.fn(),
          }),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);

      const callbacks: StreamingCallbacks = {
        onConnected: vi.fn(),
      };

      const controller = await sseClient.streamTool('test_tool', {}, callbacks);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/api/tools/test_tool/stream',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-key',
          }),
        })
      );

      expect(controller).toBeInstanceOf(AbortController);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callbacks.onConnected).toHaveBeenCalledWith({ message: 'connected' });
    });

    it('should parse progress events correctly', async () => {
      const progressEvent = 'event: progress\ndata: {"step":1,"action":"test","message":"testing"}\n\n';

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(progressEvent),
              })
              .mockResolvedValueOnce({ done: true }),
            releaseLock: vi.fn(),
          }),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);

      const callbacks: StreamingCallbacks = {
        onProgress: vi.fn(),
      };

      await sseClient.streamTool('test_tool', {}, callbacks);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callbacks.onProgress).toHaveBeenCalledWith({
        step: 1,
        action: 'test',
        message: 'testing',
      });
    });

    it('should handle complete event', async () => {
      const completeEvent = 'event: complete\ndata: {"result":"success"}\n\n';

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(completeEvent),
              })
              .mockResolvedValueOnce({ done: true }),
            releaseLock: vi.fn(),
          }),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);

      const callbacks: StreamingCallbacks = {
        onComplete: vi.fn(),
      };

      await sseClient.streamTool('test_tool', {}, callbacks);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callbacks.onComplete).toHaveBeenCalledWith({ result: 'success' });
    });

    it('should handle error events', async () => {
      const errorEvent = 'event: error\ndata: {"message":"Test error"}\n\n';

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(errorEvent),
              })
              .mockResolvedValueOnce({ done: true }),
            releaseLock: vi.fn(),
          }),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);

      const callbacks: StreamingCallbacks = {
        onError: vi.fn(),
      };

      await sseClient.streamTool('test_tool', {}, callbacks);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callbacks.onError).toHaveBeenCalledWith({ message: 'Test error' });
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const callbacks: StreamingCallbacks = {
        onError: vi.fn(),
      };

      await sseClient.streamTool('test_tool', {}, callbacks);

      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Network error',
        })
      );
    });

    it('should support stream cancellation', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockImplementation(() => new Promise(() => {})), // Never resolves
            releaseLock: vi.fn(),
          }),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);

      const controller = await sseClient.streamTool('test_tool', {}, {});

      expect(controller.signal.aborted).toBe(false);

      controller.abort();

      expect(controller.signal.aborted).toBe(true);
    });

    it('should handle HTTP error responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid API key',
      });

      const callbacks: StreamingCallbacks = {
        onError: vi.fn(),
      };

      await sseClient.streamTool('test_tool', {}, callbacks);

      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('401'),
        })
      );
    });

    it('should call onEnd when stream completes', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('event: end\ndata: {}\n\n'),
              })
              .mockResolvedValueOnce({ done: true }),
            releaseLock: vi.fn(),
          }),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);

      const callbacks: StreamingCallbacks = {
        onEnd: vi.fn(),
      };

      await sseClient.streamTool('test_tool', {}, callbacks);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callbacks.onEnd).toHaveBeenCalled();
    });
  });

  describe('parseSSEMessage', () => {
    it('should parse multiline SSE messages', async () => {
      const message = 'event: progress\ndata: {"step":1}\nid: msg-1\n';

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(message + '\n'),
              })
              .mockResolvedValueOnce({ done: true }),
            releaseLock: vi.fn(),
          }),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);

      const callbacks: StreamingCallbacks = {
        onProgress: vi.fn(),
      };

      await sseClient.streamTool('test_tool', {}, callbacks);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callbacks.onProgress).toHaveBeenCalledWith({ step: 1 });
    });

    it('should handle non-JSON data', async () => {
      const message = 'event: progress\ndata: plain text\n\n';

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(message),
              })
              .mockResolvedValueOnce({ done: true }),
            releaseLock: vi.fn(),
          }),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);

      const callbacks: StreamingCallbacks = {
        onProgress: vi.fn(),
      };

      await sseClient.streamTool('test_tool', {}, callbacks);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callbacks.onProgress).toHaveBeenCalledWith('plain text');
    });
  });

  describe('streamToolWithRetry', () => {
    it('should retry on failure', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          body: {
            getReader: () => ({
              read: vi.fn().mockResolvedValueOnce({ done: true }),
              releaseLock: vi.fn(),
            }),
          },
        });

      const callbacks: StreamingCallbacks = {
        onError: vi.fn(),
      };

      await sseClient.streamToolWithRetry('test_tool', {}, callbacks);

      // Wait for retry delay
      await new Promise(resolve => setTimeout(resolve, 1500));

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should give up after max retries', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const callbacks: StreamingCallbacks = {
        onError: vi.fn(),
      };

      // The promise resolves (returns AbortController) but onError is called
      await sseClient.streamToolWithRetry('test_tool', {}, callbacks);

      // Wait for all retries
      await new Promise(resolve => setTimeout(resolve, 8000));

      expect(mockFetch).toHaveBeenCalledTimes(4); // Initial + 3 retries
      expect(callbacks.onError).toHaveBeenCalled(); // Error callback invoked
    }, 10000);
  });
});
