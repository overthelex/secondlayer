/**
 * useMCPTool Hook Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMCPTool } from '../useMCPTool';
import { useChatStore } from '../../stores/chatStore';
import { mcpService } from '../../services';

// Mock the services
vi.mock('../../services', () => ({
  mcpService: {
    streamTool: vi.fn(),
    callTool: vi.fn(),
    transformToolResultToMessage: vi.fn(),
  },
}));

// Mock toast
vi.mock('../../utils/toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('useMCPTool', () => {
  beforeEach(() => {
    // Reset store before each test
    useChatStore.setState({
      messages: [],
      isStreaming: false,
      streamController: null,
      currentTool: null,
      currentSessionId: null,
    });

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with correct tool name', () => {
    const { result } = renderHook(() => useMCPTool('get_legal_advice'));

    expect(result.current.executeTool).toBeDefined();
    expect(typeof result.current.executeTool).toBe('function');
  });

  it('should add user message on execute', async () => {
    const mockController = new AbortController();
    (mcpService.streamTool as any).mockResolvedValue(mockController);

    const { result } = renderHook(() => useMCPTool('get_legal_advice'));

    await act(async () => {
      await result.current.executeTool({ query: 'Test query' });
    });

    const messages = useChatStore.getState().messages;

    expect(messages).toHaveLength(2); // User + Assistant placeholder
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('Test query');
  });

  it('should add assistant placeholder message', async () => {
    const mockController = new AbortController();
    (mcpService.streamTool as any).mockResolvedValue(mockController);

    const { result } = renderHook(() => useMCPTool('get_legal_advice'));

    await act(async () => {
      await result.current.executeTool({ query: 'Test' });
    });

    const messages = useChatStore.getState().messages;
    const assistantMsg = messages[1];

    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.isStreaming).toBe(true);
    expect(assistantMsg.content).toBe('');
  });

  it('should set streaming state', async () => {
    const mockController = new AbortController();
    (mcpService.streamTool as any).mockResolvedValue(mockController);

    const { result } = renderHook(() => useMCPTool('get_legal_advice'));

    await act(async () => {
      await result.current.executeTool({ query: 'Test' });
    });

    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().currentTool).toBe('get_legal_advice');
  });

  it('should handle onProgress callback', async () => {
    const mockController = new AbortController();
    let progressCallback: any;

    (mcpService.streamTool as any).mockImplementation(
      async (toolName: string, params: any, callbacks: any) => {
        progressCallback = callbacks.onProgress;
        return mockController;
      }
    );

    const { result } = renderHook(() => useMCPTool('get_legal_advice'));

    await act(async () => {
      await result.current.executeTool({ query: 'Test' });
    });

    // Simulate progress event
    await act(async () => {
      progressCallback({
        step: 1,
        action: 'analyzing',
        message: 'Analyzing query',
      });
    });

    const messages = useChatStore.getState().messages;
    const assistantMsg = messages[1];

    expect(assistantMsg.thinkingSteps).toBeDefined();
    expect(assistantMsg.thinkingSteps?.length).toBeGreaterThan(0);
  });

  it('should handle onComplete callback', async () => {
    const mockController = new AbortController();
    let completeCallback: any;

    const mockMessage = {
      id: 'test',
      role: 'assistant' as const,
      content: 'Final answer',
      decisions: [],
      citations: [],
    };

    (mcpService.streamTool as any).mockImplementation(
      async (toolName: string, params: any, callbacks: any) => {
        completeCallback = callbacks.onComplete;
        return mockController;
      }
    );

    (mcpService.transformToolResultToMessage as any).mockReturnValue(mockMessage);

    const { result } = renderHook(() => useMCPTool('get_legal_advice'));

    await act(async () => {
      await result.current.executeTool({ query: 'Test' });
    });

    // Simulate complete event
    await act(async () => {
      completeCallback({ result: 'success' });
    });

    const messages = useChatStore.getState().messages;
    const assistantMsg = messages[1];

    expect(assistantMsg.content).toBe('Final answer');
    expect(assistantMsg.isStreaming).toBe(false);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('should handle onError callback', async () => {
    const mockController = new AbortController();
    let errorCallback: any;

    (mcpService.streamTool as any).mockImplementation(
      async (toolName: string, params: any, callbacks: any) => {
        errorCallback = callbacks.onError;
        return mockController;
      }
    );

    const { result } = renderHook(() => useMCPTool('get_legal_advice'));

    await act(async () => {
      await result.current.executeTool({ query: 'Test' });
    });

    // Simulate error event
    await act(async () => {
      errorCallback({ message: 'Test error' });
    });

    const messages = useChatStore.getState().messages;
    const assistantMsg = messages[1];

    expect(assistantMsg.content).toContain('Помилка');
    expect(assistantMsg.isStreaming).toBe(false);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('should call onSuccess callback option', async () => {
    const mockController = new AbortController();
    const onSuccess = vi.fn();
    let completeCallback: any;

    (mcpService.streamTool as any).mockImplementation(
      async (toolName: string, params: any, callbacks: any) => {
        completeCallback = callbacks.onComplete;
        return mockController;
      }
    );

    (mcpService.transformToolResultToMessage as any).mockReturnValue({
      id: 'test',
      role: 'assistant',
      content: 'Answer',
    });

    const { result } = renderHook(() =>
      useMCPTool('get_legal_advice', { onSuccess })
    );

    await act(async () => {
      await result.current.executeTool({ query: 'Test' });
    });

    await act(async () => {
      completeCallback({ result: 'success' });
    });

    expect(onSuccess).toHaveBeenCalledWith({ result: 'success' });
  });

  it('should call onError callback option', async () => {
    const onError = vi.fn();

    (mcpService.streamTool as any).mockRejectedValue(new Error('Test error'));

    const { result } = renderHook(() =>
      useMCPTool('get_legal_advice', { onError })
    );

    await act(async () => {
      await result.current.executeTool({ query: 'Test' });
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
  });

  it('should handle sync mode when streaming disabled', async () => {
    const mockResult = { result: 'success' };
    const mockMessage = {
      id: 'test',
      role: 'assistant' as const,
      content: 'Answer',
    };

    (mcpService.callTool as any).mockResolvedValue(mockResult);
    (mcpService.transformToolResultToMessage as any).mockReturnValue(mockMessage);

    const { result } = renderHook(() =>
      useMCPTool('get_legal_advice', { enableStreaming: false })
    );

    await act(async () => {
      await result.current.executeTool({ query: 'Test' });
    });

    expect(mcpService.callTool).toHaveBeenCalled();
    expect(mcpService.streamTool).not.toHaveBeenCalled();

    const messages = useChatStore.getState().messages;
    expect(messages[1].content).toBe('Answer');
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('should store abort controller', async () => {
    const mockController = new AbortController();
    (mcpService.streamTool as any).mockResolvedValue(mockController);

    const { result } = renderHook(() => useMCPTool('get_legal_advice'));

    await act(async () => {
      await result.current.executeTool({ query: 'Test' });
    });

    expect(useChatStore.getState().streamController).toBe(mockController);
  });
});
