/**
 * useMCPTool Hook
 * Shared hook for calling any MCP tool with streaming support
 * Used by both ChatPage and ChatLayout
 */

import { useCallback } from 'react';
import { useChatStore } from '../stores';
import { useSettingsStore } from '../stores';
import { mcpService } from '../services';
import showToast from '../utils/toast';

export interface UseMCPToolOptions {
  enableStreaming?: boolean;
  onSuccess?: (result: any) => void;
  onError?: (error: Error) => void;
}

export function useMCPTool(
  toolName: string,
  options: UseMCPToolOptions = {}
) {
  const {
    addMessage,
    updateMessage,
    addThinkingStep,
    setStreaming,
    setStreamController,
    setCurrentTool,
  } = useChatStore();

  const { maxPrecedents } = useSettingsStore();

  const { enableStreaming = true, onSuccess, onError } = options;

  const executeTool = useCallback(
    async (params: any) => {
      // 1. Add user message
      const userMessage = {
        id: Date.now().toString(),
        role: 'user' as const,
        content:
          typeof params === 'string'
            ? params
            : params.query || JSON.stringify(params, null, 2),
      };
      addMessage(userMessage);

      // 2. Create placeholder for assistant message
      const assistantMessageId = (Date.now() + 1).toString();
      const assistantMessage = {
        id: assistantMessageId,
        role: 'assistant' as const,
        content: '',
        isStreaming: true,
        thinkingSteps: [],
      };
      addMessage(assistantMessage);
      setStreaming(true);
      setCurrentTool(toolName);

      try {
        if (enableStreaming) {
          // Streaming mode
          const controller = await mcpService.streamTool(toolName, params, {
            onConnected: (data) => {
              console.log('SSE connected:', data);
            },

            onProgress: (data) => {
              // Add thinking step for each progress event
              const step = {
                id: `step-${data.step}`,
                title: `${data.action}: ${data.message}`,
                content: data.result
                  ? JSON.stringify(data.result, null, 2)
                  : '',
                isComplete: !!data.result,
              };
              addThinkingStep(assistantMessageId, step);
            },

            onComplete: (data) => {
              // Transform result to message format
              const finalMessage = mcpService.transformToolResultToMessage(
                toolName,
                data
              );

              // Update placeholder message with final content
              updateMessage(assistantMessageId, {
                content: finalMessage.content,
                isStreaming: false,
                decisions: finalMessage.decisions,
                citations: finalMessage.citations,
                thinkingSteps: finalMessage.thinkingSteps,
              });

              setStreaming(false);
              setStreamController(null);
              setCurrentTool(null);

              onSuccess?.(data);
            },

            onError: (error) => {
              updateMessage(assistantMessageId, {
                content: `Помилка: ${error.message}`,
                isStreaming: false,
              });
              setStreaming(false);
              setStreamController(null);
              setCurrentTool(null);
              showToast.error(error.message);

              onError?.(new Error(error.message));
            },

            onEnd: () => {
              console.log('SSE stream ended');
            },
          });

          setStreamController(controller);
        } else {
          // Synchronous mode (fallback)
          const result = await mcpService.callTool(toolName, params);
          const finalMessage = mcpService.transformToolResultToMessage(
            toolName,
            result
          );

          updateMessage(assistantMessageId, {
            ...finalMessage,
            id: assistantMessageId,
            isStreaming: false,
          });

          setStreaming(false);
          setCurrentTool(null);

          onSuccess?.(result);
        }
      } catch (error: any) {
        updateMessage(assistantMessageId, {
          content: `Помилка: ${error.message || 'Невідома помилка'}`,
          isStreaming: false,
        });
        setStreaming(false);
        setCurrentTool(null);
        showToast.error(error.message || 'Невідома помилка');

        onError?.(error);
      }
    },
    [
      toolName,
      enableStreaming,
      addMessage,
      updateMessage,
      addThinkingStep,
      setStreaming,
      setStreamController,
      setCurrentTool,
      maxPrecedents,
      onSuccess,
      onError,
    ]
  );

  return { executeTool };
}

// Specialized hooks for popular tools
export function useGetLegalAdvice(options?: UseMCPToolOptions) {
  return useMCPTool('get_legal_advice', options);
}

export function useSearchCourtCases(options?: UseMCPToolOptions) {
  return useMCPTool('search_court_cases', options);
}

export function useSearchLegislation(options?: UseMCPToolOptions) {
  return useMCPTool('search_legislation', options);
}

export function useSearchDeputies(options?: UseMCPToolOptions) {
  return useMCPTool('search_deputies', options);
}

export function useSearchEntities(options?: UseMCPToolOptions) {
  return useMCPTool('search_entities', options);
}
