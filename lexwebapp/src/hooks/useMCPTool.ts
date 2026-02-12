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

/**
 * Build a contextual query that includes prior conversation history.
 * Prepends last N user-assistant exchanges so the LLM has conversational memory.
 */
function buildContextualQuery(
  query: string,
  messages: Array<{ role: string; content: string }>,
  maxTurns = 3
): string {
  // Collect prior user-assistant pairs (exclude the just-added messages)
  const pairs: Array<{ user: string; assistant: string }> = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i];
    const next = messages[i + 1];
    if (msg.role === 'user' && next?.role === 'assistant' && next.content) {
      pairs.push({
        user: msg.content.slice(0, 500),
        assistant: next.content.slice(0, 500),
      });
      i++; // skip the assistant message
    }
  }

  if (pairs.length === 0) return query;

  const recentPairs = pairs.slice(-maxTurns);
  const context = recentPairs
    .map((p) => `\u041a\u043e\u0440\u0438\u0441\u0442\u0443\u0432\u0430\u0447: ${p.user}\n\u0410\u0441\u0438\u0441\u0442\u0435\u043d\u0442: ${p.assistant}`)
    .join('\n\n');

  return `\u041a\u043e\u043d\u0442\u0435\u043a\u0441\u0442 \u043f\u043e\u043f\u0435\u0440\u0435\u0434\u043d\u044c\u043e\u0457 \u0440\u043e\u0437\u043c\u043e\u0432\u0438:\n${context}\n\n\u041f\u043e\u0442\u043e\u0447\u043d\u0435 \u0437\u0430\u043f\u0438\u0442\u0430\u043d\u043d\u044f: ${query}`;
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

      // 2. Auto-create conversation if needed (for persistence)
      const state = useChatStore.getState();
      if (!state.conversationId && localStorage.getItem('auth_token')) {
        await state.createConversation();
      }
      // Sync user message to server
      useChatStore.getState().syncMessage(userMessage);

      // 3. Build contextual query from prior messages
      const currentMessages = useChatStore.getState().messages;
      // Messages before the just-added user message (all except the last one)
      const priorMessages = currentMessages.slice(0, -1);
      let toolParams = typeof params === 'string' ? { query: params } : { ...params };
      if (priorMessages.length >= 2 && typeof toolParams.query === 'string') {
        toolParams.query = buildContextualQuery(toolParams.query, priorMessages);
      }

      // 4. Create placeholder for assistant message
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
          const controller = await mcpService.streamTool(toolName, toolParams, {
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

              // Sync assistant message to server
              const completedState = useChatStore.getState();
              const completedMsg = completedState.messages.find(
                (m) => m.id === assistantMessageId
              );
              if (completedMsg) {
                completedState.syncMessage(completedMsg);
              }

              // Auto-title on first exchange
              if (completedState.conversationId && completedState.messages.length <= 3) {
                const firstUserMsg = completedState.messages.find((m) => m.role === 'user');
                if (firstUserMsg) {
                  const title = firstUserMsg.content.slice(0, 60).trim();
                  completedState.renameConversation(completedState.conversationId, title);
                }
              }

              onSuccess?.(data);
            },

            onError: (error) => {
              updateMessage(assistantMessageId, {
                content: `\u041f\u043e\u043c\u0438\u043b\u043a\u0430: ${error.message}`,
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
          const result = await mcpService.callTool(toolName, toolParams);
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

          // Sync assistant message to server
          const completedState = useChatStore.getState();
          const completedMsg = completedState.messages.find(
            (m) => m.id === assistantMessageId
          );
          if (completedMsg) {
            completedState.syncMessage(completedMsg);
          }

          // Auto-title on first exchange
          if (completedState.conversationId && completedState.messages.length <= 3) {
            const firstUserMsg = completedState.messages.find((m) => m.role === 'user');
            if (firstUserMsg) {
              const title = firstUserMsg.content.slice(0, 60).trim();
              completedState.renameConversation(completedState.conversationId, title);
            }
          }

          onSuccess?.(result);
        }
      } catch (error: any) {
        updateMessage(assistantMessageId, {
          content: `\u041f\u043e\u043c\u0438\u043b\u043a\u0430: ${error.message || '\u041d\u0435\u0432\u0456\u0434\u043e\u043c\u0430 \u043f\u043e\u043c\u0438\u043b\u043a\u0430'}`,
          isStreaming: false,
        });
        setStreaming(false);
        setCurrentTool(null);
        showToast.error(error.message || '\u041d\u0435\u0432\u0456\u0434\u043e\u043c\u0430 \u043f\u043e\u043c\u0438\u043b\u043a\u0430');

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

/**
 * useAIChat Hook
 * Calls the agentic /api/chat endpoint with SSE streaming.
 * The LLM automatically selects and calls tools, then generates a synthesized answer.
 */
export function useAIChat(options: UseMCPToolOptions = {}) {
  const {
    addMessage,
    updateMessage,
    addThinkingStep,
    setStreaming,
    setStreamController,
    setCurrentTool,
  } = useChatStore();

  const { onSuccess, onError } = options;

  const executeChat = useCallback(
    async (query: string, documentIds?: string[]) => {
      // 1. Add user message
      const userMessage = {
        id: Date.now().toString(),
        role: 'user' as const,
        content: query,
      };
      addMessage(userMessage);

      // 2. Auto-create conversation if needed
      const state = useChatStore.getState();
      if (!state.conversationId && localStorage.getItem('auth_token')) {
        await state.createConversation();
      }
      useChatStore.getState().syncMessage(userMessage);

      // 3. Build history from prior messages
      const currentMessages = useChatStore.getState().messages;
      const history = currentMessages
        .slice(0, -1) // exclude the just-added user message
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-6) // last 3 exchanges
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content.slice(0, 1000),
        }));

      // 4. Create placeholder assistant message
      const assistantMessageId = (Date.now() + 1).toString();
      addMessage({
        id: assistantMessageId,
        role: 'assistant' as const,
        content: '',
        isStreaming: true,
        thinkingSteps: [],
      });
      setStreaming(true);
      setCurrentTool('ai_chat');

      try {
        const controller = await mcpService.streamChat(query, history, {
          onThinking: (data) => {
            addThinkingStep(assistantMessageId, {
              id: `step-${data.step}`,
              title: `Інструмент: ${data.tool}`,
              content: JSON.stringify(data.params, null, 2),
              isComplete: false,
            });
          },

          onToolResult: (data) => {
            // Update the last thinking step as complete and add result preview
            const toolPreview = typeof data.result === 'string'
              ? data.result.slice(0, 500)
              : JSON.stringify(data.result, null, 2).slice(0, 500);

            addThinkingStep(assistantMessageId, {
              id: `result-${data.tool}`,
              title: `Результат: ${data.tool}`,
              content: toolPreview,
              isComplete: true,
            });
          },

          onAnswer: (data) => {
            updateMessage(assistantMessageId, {
              content: data.text,
              isStreaming: false,
            });

            setStreaming(false);
            setStreamController(null);
            setCurrentTool(null);

            // Sync assistant message to server
            const completedState = useChatStore.getState();
            const completedMsg = completedState.messages.find(
              (m) => m.id === assistantMessageId
            );
            if (completedMsg) {
              completedState.syncMessage(completedMsg);
            }

            // Auto-title on first exchange
            if (completedState.conversationId && completedState.messages.length <= 3) {
              const firstUserMsg = completedState.messages.find((m) => m.role === 'user');
              if (firstUserMsg) {
                const title = firstUserMsg.content.slice(0, 60).trim();
                completedState.renameConversation(completedState.conversationId, title);
              }
            }

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

          onComplete: (data) => {
            // Completion event — streaming is already finished in onAnswer
            console.log('[AIChat] Complete', data);
          },
        });

        setStreamController(controller);
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
    [addMessage, updateMessage, addThinkingStep, setStreaming, setStreamController, setCurrentTool, onSuccess, onError]
  );

  return { executeChat };
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
