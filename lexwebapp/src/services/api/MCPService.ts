/**
 * MCP Service
 * Service for calling all 43 MCP tools (sync + streaming)
 * Supports mcp_backend, mcp_rada, and mcp_openreyestr tools
 */

import { BaseService } from '../base/BaseService';
import { SSEClient } from './SSEClient';
import { getErrorMessage, isAbortError, isNetworkError } from '../../utils/errors';
import { transformToolResultToMessage } from './mcp/response-transformers';
import type { Message } from '../../types/models';
import { StreamingCallbacks } from '../../types/api/sse';

/** Shown when a chat stream is lost to a network/connection failure (e.g. a backend restart)
 *  that could not be transparently retried — clearer than the raw browser "Failed to fetch". */
const CONNECTION_LOST_MESSAGE = "Зв'язок із сервером перервано. Перевірте підключення та спробуйте повторити запит.";

/** Raw SSE shape — backend emits either shape under the same event type. */
export type CitationWarning =
  | {
      reason?: undefined;
      case_number: string;
      status: 'explicitly_overruled' | 'limited';
      confidence: number;
      affecting_decisions?: Array<{ doc_id: string; instance: string; court: string; date?: string; outcome: string; effect: string }>;
      message: string;
    }
  | {
      reason: 'fabricated_case_numbers';
      fabricated: string[];
      message: string;
    }
  | {
      reason: 'unverified_law_articles';
      unverified: string[];
      message: string;
    }
  // Grounding/relevance gates (chat-answer-verification.ts). These carry NO
  // confidence/status — the message is self-contained. Do NOT map them to the
  // `overruled` shape (that produced "Частково змінено · впевненість: NaN%").
  | {
      reason: 'low_relevance_case_numbers';
      lowRelevance: string[];
      message: string;
    }
  | {
      reason: 'subject_matter_mismatch';
      mismatches: Array<{ caseNumber: string; claimed: string; actual: string }>;
      message: string;
    }
  | {
      reason: 'ungrounded_quote';
      ungrounded: Array<{ caseNumber: string }>;
      message: string;
    }
  | {
      reason: 'claim_unsupported';
      unsupported: Array<{ caseNumber: string; reason: string }>;
      message: string;
    };

import type { Decision, Citation, VaultDocument } from '../../types/models/Message';
import { API_BASE } from '../../utils/api/base';

export interface EvidenceEnvelope {
  decisions: Decision[];
  citations: Citation[];
  documents: VaultDocument[];
}

export interface ChatStreamCallbacks {
  onResponseId?: (data: { response_id: string }) => void;
  /** Conversation id, emitted up front — do not wait for `complete` to learn it. */
  onConversation?: (data: { conversationId: string; requestId?: string }) => void;
  onPlan?: (data: { goal: string; steps: Array<{ id: number; tool: string; params: Record<string, unknown>; purpose: string; depends_on?: number[] }>; expected_iterations: number }) => void;
  onThinking?: (data: { step: number; tool: string; params: Record<string, unknown>; description?: string; cost_usd?: number }) => void;
  onToolResult?: (data: { tool: string; result: unknown; evidence?: EvidenceEnvelope; cost_usd?: number }) => void;
  onAnswerDelta?: (data: { text: string }) => void;
  onAnswer?: (data: { text: string; provider: string; model: string; norms?: Array<{ text: string; source: string }> }) => void;
  onEvidenceUpdate?: (data: EvidenceEnvelope) => void;
  onCitationWarning?: (data: CitationWarning) => void;
  onComplete?: (data: { iterations: number; elapsed_ms: number; tools_used?: string[]; total_cost_usd?: number; charged_usd?: number; response_id?: string; conversationId?: string; search_stats?: { fts: number; qdrant: number; structured?: number } }) => void;
  onCostSummary?: (data: { total_cost_usd: number; charged_usd: number; balance_usd: number | null }) => void;
  onBudgetEscalated?: (data: { reason: string; estimatedCost: { minUsd: number; maxUsd: number }; requiresConfirmation?: boolean }) => void;
  onError?: (data: { message?: string; code?: string; current_balance_usd?: number }) => void;
  /** Called when the SSE stream ends (reader done), regardless of whether an answer was received */
  onStreamEnd?: () => void;
}

export class MCPService extends BaseService {
  private readonly API_URL: string;
  private readonly TOOLS_URL: string;
  private readonly API_KEY: string;
  private readonly sseClient: SSEClient;
  private readonly enableSSE: boolean;

  constructor() {
    super();
    const baseUrl = API_BASE;
    this.API_URL = `${baseUrl}/api`;
    this.TOOLS_URL = `${baseUrl}/api/v1/tools`;
    this.API_KEY =
      import.meta.env.VITE_API_KEY ||
      'REDACTED_SL_KEY_STAGE';
    this.enableSSE =
      import.meta.env.VITE_ENABLE_SSE_STREAMING !== 'false';
    this.sseClient = new SSEClient(this.TOOLS_URL, this.API_KEY);
  }

  private getAuthToken(): string {
    return localStorage.getItem('auth_token') || this.API_KEY;
  }

  // ============================================================================
  // Universal Tool Methods
  // ============================================================================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP tool responses are dynamic JSON, each tool returns a different shape
  async callTool(toolName: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    try {
      const response = await fetch(`${this.TOOLS_URL}/${toolName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.getAuthToken()}`,
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error: unknown) {
      console.error(`Tool ${toolName} error:`, error);
      throw error;
    }
  }

  async streamTool(
    toolName: string,
    params: Record<string, unknown>,
    callbacks: StreamingCallbacks
  ): Promise<AbortController> {
    if (!this.enableSSE) {
      try {
        const result = await this.callTool(toolName, params);
        callbacks.onComplete?.({ result });
        callbacks.onEnd?.();
      } catch (error: unknown) {
        callbacks.onError?.({ message: getErrorMessage(error), error });
      }
      return new AbortController();
    }

    return this.sseClient.streamToolWithRetry(toolName, params, callbacks, this.getAuthToken());
  }

  // ============================================================================
  // Chat Streaming
  // ============================================================================

  async requestPlan(
    query: string,
    budget: string = 'standard'
  ): Promise<{ plan: import('../../types/models/Message').ExecutionPlan | null; planSessionId: string | null }> {
    const response = await fetch(`${this.API_URL}/chat/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.getAuthToken()}`,
      },
      body: JSON.stringify({ query, budget }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Plan request failed: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  async streamChat(
    query: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    callbacks: ChatStreamCallbacks,
    budget: string = 'standard',
    conversationId?: string,
    approvedPlan?: import('../../types/models/Message').ExecutionPlan,
    planSessionId?: string,
    allowDeepEscalation?: boolean
  ): Promise<AbortController> {
    const controller = new AbortController();
    const maxRetries = 2;

    // Run one connect+stream attempt. Returns 'retry' only when the connection failed at the
    // network layer BEFORE any event was received — i.e. the request never produced output, so
    // re-sending it cannot duplicate a partial answer or double-charge. This is the blue-green
    // deploy case: the request hit the draining backend (or the upstream mid-switch) and was
    // reset; a moment later the new backend is up. Any failure after the first event is final.
    const runAttempt = async (attempt: number): Promise<'retry' | 'done'> => {
      let receivedAny = false;
      try {
        const response = await fetch(`${this.API_URL}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.getAuthToken()}`,
          },
          body: JSON.stringify({ query, history, budget, conversationId, approvedPlan, planSessionId, allowDeepEscalation }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          // Surface the beta-restricted modal when the chat endpoint blocks
          // the request because the user has not topped up via Monobank.
          if (response.status === 403) {
            try {
              const parsed = JSON.parse(errorText) as { code?: string; message?: string };
              if (parsed?.code === 'BETA_RESTRICTED') {
                const m = await import('../../stores/accessGateStore');
                m.useAccessGateStore.getState().markRestricted();
                callbacks.onError?.({ message: parsed.message, code: 'BETA_RESTRICTED' });
                return 'done';
              }
            } catch {
              // Fall through to the generic error path below.
            }
          }
          callbacks.onError?.({ message: `API Error: ${response.status} - ${errorText}` });
          return 'done';
        }

        const reader = response.body?.getReader();
        if (!reader) {
          callbacks.onError?.({ message: 'No response body' });
          return 'done';
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let currentData = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith(':')) continue;

              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                currentData = line.slice(6);
              } else if (line === '' && currentEvent && currentData) {
                try {
                  const data = JSON.parse(currentData);
                  receivedAny = true;
                  this.dispatchChatEvent(currentEvent, data, callbacks);
                } catch {
                  // skip malformed JSON
                }
                currentEvent = '';
                currentData = '';
              }
            }
          }
          return 'done';
        } catch (err: unknown) {
          if (isAbortError(err)) return 'done';
          if (isNetworkError(err) && !receivedAny && attempt < maxRetries) return 'retry';
          callbacks.onError?.({ message: isNetworkError(err) ? CONNECTION_LOST_MESSAGE : getErrorMessage(err) });
          return 'done';
        }
      } catch (err: unknown) {
        if (isAbortError(err)) return 'done';
        if (isNetworkError(err) && !receivedAny && attempt < maxRetries) return 'retry';
        callbacks.onError?.({ message: isNetworkError(err) ? CONNECTION_LOST_MESSAGE : getErrorMessage(err) });
        return 'done';
      }
    };

    const driveAttempts = async () => {
      try {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (controller.signal.aborted) break;
          const outcome = await runAttempt(attempt);
          if (outcome === 'done') break;
          // Brief backoff before re-connecting — a blue-green upstream switch settles in seconds.
          await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        }
      } finally {
        // Always notify that the stream has ended (once, after the final attempt) so the UI
        // resets streaming state even if it ended without an 'answer' event.
        callbacks.onStreamEnd?.();
      }
    };

    driveAttempts();
    return controller;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SSE events are parsed JSON with dynamic shapes per event type
  private dispatchChatEvent(event: string, data: Record<string, any>, callbacks: ChatStreamCallbacks) {
    switch (event) {
      case 'response_id': callbacks.onResponseId?.(data as { response_id: string }); break;
      case 'conversation': callbacks.onConversation?.(data as { conversationId: string; requestId?: string }); break;
      case 'plan': callbacks.onPlan?.(data as Parameters<NonNullable<ChatStreamCallbacks['onPlan']>>[0]); break;
      case 'thinking': callbacks.onThinking?.(data as Parameters<NonNullable<ChatStreamCallbacks['onThinking']>>[0]); break;
      case 'tool_result': callbacks.onToolResult?.(data as Parameters<NonNullable<ChatStreamCallbacks['onToolResult']>>[0]); break;
      case 'answer_delta': callbacks.onAnswerDelta?.(data as { text: string }); break;
      case 'answer': callbacks.onAnswer?.(data as Parameters<NonNullable<ChatStreamCallbacks['onAnswer']>>[0]); break;
      case 'evidence_update': callbacks.onEvidenceUpdate?.(data as EvidenceEnvelope); break;
      case 'citation_warning': callbacks.onCitationWarning?.(data as CitationWarning); break;
      case 'complete': callbacks.onComplete?.(data as Parameters<NonNullable<ChatStreamCallbacks['onComplete']>>[0]); break;
      case 'cost_summary': callbacks.onCostSummary?.(data as Parameters<NonNullable<ChatStreamCallbacks['onCostSummary']>>[0]); break;
      case 'budget_escalated': callbacks.onBudgetEscalated?.(data as Parameters<NonNullable<ChatStreamCallbacks['onBudgetEscalated']>>[0]); break;
      case 'error': callbacks.onError?.(data as { message?: string; code?: string; current_balance_usd?: number }); break;
    }
  }

  // ============================================================================
  // Response Parsing (delegates to extracted module)
  // ============================================================================

  transformToolResultToMessage(toolName: string, result: unknown): Message {
    return transformToolResultToMessage(toolName, result);
  }
}

// Export singleton instance
export const mcpService = new MCPService();
