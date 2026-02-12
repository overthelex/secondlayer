/**
 * useMCPTool Hook
 * Shared hook for calling any MCP tool with streaming support
 * Used by both ChatPage and ChatLayout
 */

import { useCallback, useRef } from 'react';
import { useChatStore } from '../stores';
import { useSettingsStore } from '../stores';
import { mcpService } from '../services';
import showToast from '../utils/toast';
import type { Decision, Citation } from '../types/models/Message';

/**
 * Parse raw tool result content — handles MCP content array and plain objects.
 */
function parseToolResultContent(result: any): any {
  if (!result) return null;
  try {
    if (result.content && Array.isArray(result.content)) {
      const textBlock = result.content.find((b: any) => b.type === 'text');
      if (textBlock?.text) {
        return JSON.parse(textBlock.text);
      }
    }
    return typeof result === 'string' ? JSON.parse(result) : result;
  } catch {
    return result;
  }
}

/**
 * Extract Decision[] and Citation[] from a tool_result SSE event.
 * Handles all court-case and legislation tools returned by the agentic loop.
 */
function extractEvidenceFromToolResult(
  toolName: string,
  rawResult: any
): { decisions: Decision[]; citations: Citation[] } {
  const decisions: Decision[] = [];
  const citations: Citation[] = [];

  const parsed = parseToolResultContent(rawResult);
  if (!parsed) return { decisions, citations };

  // ---- Court case tools ----
  const courtTools = [
    'search_court_cases',
    'search_legal_precedents',
    'search_supreme_court_practice',
    'get_case_documents_chain',
    'find_similar_cases',
    'find_similar_fact_pattern_cases',
    'compare_practice_pro_contra',
    'get_court_decision',
  ];
  if (courtTools.some((t) => toolName.includes(t) || toolName === t)) {
    // source_case (single)
    if (parsed.source_case) {
      const sc = parsed.source_case;
      decisions.push({
        id: `sc-${sc.doc_id || Date.now()}`,
        number: sc.cause_num || sc.case_number || 'N/A',
        court: sc.court_code || sc.court || '',
        date: sc.adjudication_date || sc.date || '',
        summary: sc.title || sc.resolution || '',
        relevance: 100,
        status: 'active',
      });
    }

    // similar_cases / results array (tools return different field names)
    const cases = parsed.similar_cases || parsed.results || parsed.cases || parsed.precedents || [];
    for (const c of cases) {
      decisions.push({
        id: `d-${c.doc_id || c.id || Math.random().toString(36).slice(2, 8)}`,
        number: c.cause_num || c.case_number || c.number || 'N/A',
        court: c.court_code || c.court || '',
        date: c.adjudication_date || c.date || '',
        summary: c.title || c.resolution || c.summary || c.similarity_reason || '',
        relevance: c.similarity
          ? Math.round(c.similarity * 100)
          : c.relevance
            ? Math.round(c.relevance * 100)
            : 70,
        status: 'active',
      });
    }

    // get_case_documents_chain format (flat array or grouped by instance)
    let chainDocs: any[] = [];
    if (parsed.documents && Array.isArray(parsed.documents)) {
      chainDocs = parsed.documents;
    } else if (parsed.grouped_documents && typeof parsed.grouped_documents === 'object') {
      chainDocs = Object.values(parsed.grouped_documents).flat();
    }
    for (const doc of chainDocs) {
      decisions.push({
        id: `chain-${doc.doc_id || Math.random().toString(36).slice(2, 8)}`,
        number: doc.case_number || parsed.case_number || doc.title || 'N/A',
        court: doc.court || doc.instance || '',
        date: doc.date || '',
        summary: doc.document_type
          ? `${doc.document_type}: ${doc.resolution || doc.title || ''}`
          : doc.title || doc.resolution || '',
        relevance: 80,
        status: 'active',
      });
    }

    // compare_practice_pro_contra format
    const proContraCases = [...(parsed.pro || []), ...(parsed.contra || [])];
    for (const c of proContraCases) {
      decisions.push({
        id: `pc-${c.doc_id || Math.random().toString(36).slice(2, 8)}`,
        number: c.case_number || 'N/A',
        court: c.court || c.chamber || '',
        date: c.date || '',
        summary: c.snippet || '',
        relevance: 70,
        status: 'active',
      });
    }

    // get_court_decision — single decision with sections
    if (parsed.sections && Array.isArray(parsed.sections) && (parsed.doc_id || parsed.case_number)) {
      const summarySection = parsed.sections.find((s: any) => s.type === 'DECISION' || s.type === 'COURT_REASONING');
      decisions.push({
        id: `gcd-${parsed.doc_id || Date.now()}`,
        number: parsed.case_number || String(parsed.doc_id) || 'N/A',
        court: '',
        date: '',
        summary: summarySection?.text?.slice(0, 300) || '',
        relevance: 100,
        status: 'active',
      });
    }
  }

  // ---- Legislation tools ----
  const legislationTools = [
    'search_legislation',
    'get_legislation_article',
    'get_legislation_section',
  ];
  if (legislationTools.some((t) => toolName.includes(t) || toolName === t)) {
    // Single article result
    if (parsed.full_text || parsed.text || parsed.content) {
      const articleNum = parsed.article_number || parsed.section_name || '';
      const title = parsed.title || parsed.rada_id || parsed.legislation_id || '';
      citations.push({
        text: (parsed.full_text || parsed.text || parsed.content || '').slice(0, 500),
        source: articleNum ? `${title}, ст. ${articleNum}` : title,
      });
    }

    // Array of legislation results
    if (parsed.legislation && Array.isArray(parsed.legislation)) {
      for (const l of parsed.legislation) {
        citations.push({
          text: l.snippet || l.text || l.title || '',
          source: l.title || l.type || 'Нормативний акт',
        });
      }
    }

    // Array of articles
    if (parsed.articles && Array.isArray(parsed.articles)) {
      for (const a of parsed.articles) {
        citations.push({
          text: (a.text || a.content || '').slice(0, 500),
          source: `Стаття ${a.article_number || ''}`,
        });
      }
    }
  }

  return { decisions, citations };
}

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

  // Accumulate evidence across multiple tool calls in one chat session
  const accumulatedDecisions = useRef<Decision[]>([]);
  const accumulatedCitations = useRef<Citation[]>([]);

  const executeChat = useCallback(
    async (query: string, documentIds?: string[]) => {
      // Reset accumulators for new chat request
      accumulatedDecisions.current = [];
      accumulatedCitations.current = [];
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

            // Extract decisions & citations from tool results
            const evidence = extractEvidenceFromToolResult(data.tool, data.result);
            if (evidence.decisions.length > 0) {
              accumulatedDecisions.current.push(...evidence.decisions);
            }
            if (evidence.citations.length > 0) {
              accumulatedCitations.current.push(...evidence.citations);
            }

            // Update message with accumulated evidence so far (for live RightPanel updates)
            if (accumulatedDecisions.current.length > 0 || accumulatedCitations.current.length > 0) {
              updateMessage(assistantMessageId, {
                decisions: [...accumulatedDecisions.current],
                citations: [...accumulatedCitations.current],
              });
            }
          },

          onAnswer: (data) => {
            updateMessage(assistantMessageId, {
              content: data.text,
              isStreaming: false,
              decisions: accumulatedDecisions.current.length > 0
                ? [...accumulatedDecisions.current]
                : undefined,
              citations: accumulatedCitations.current.length > 0
                ? [...accumulatedCitations.current]
                : undefined,
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
