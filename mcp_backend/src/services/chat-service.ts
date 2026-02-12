/**
 * ChatService — Agentic LLM loop for the /api/chat endpoint.
 *
 * Flow:
 * 1. Classify user intent → filter tools to relevant subset
 * 2. Pick LLM provider (round-robin OpenAI ↔ Anthropic)
 * 3. Stream LLM response with function calling / tool_use
 * 4. Execute tool calls via ToolRegistry
 * 5. Feed results back → loop until LLM produces final answer
 * 6. Stream token-level events to client via SSE
 */

import { logger } from '../utils/logger.js';
import { ToolRegistry, ToolDefinition } from '../api/tool-registry.js';
import { QueryPlanner } from './query-planner.js';
import { CostTracker } from './cost-tracker.js';
import { ConversationService } from './conversation-service.js';
import {
  getLLMManager,
  UnifiedMessage,
  ToolDefinitionParam,
  ToolCall,
} from '@secondlayer/shared';
import { ModelSelector } from '@secondlayer/shared';
import {
  CHAT_SYSTEM_PROMPT,
  DOMAIN_TOOL_MAP,
  DEFAULT_TOOLS,
} from '../prompts/chat-system-prompt.js';
import { ChatSearchCacheService, isCourtSearchTool } from './chat-search-cache-service.js';

// ============================
// Types
// ============================

export interface ChatEvent {
  type: 'thinking' | 'tool_result' | 'answer_delta' | 'answer' | 'complete' | 'error';
  data: any;
}

export interface ChatRequest {
  query: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  budget?: 'quick' | 'standard' | 'deep';
  conversationId?: string;
  userId?: string;
  signal?: AbortSignal;
}

// ============================
// Service
// ============================

const MAX_TOOL_CALLS = parseInt(process.env.MAX_CHAT_TOOL_CALLS || '5', 10);
const MAX_RESULT_LENGTH = 8000; // chars per tool result before summarization
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS || '48000', 10); // ~12K tokens

export class ChatService {
  constructor(
    private toolRegistry: ToolRegistry,
    private queryPlanner: QueryPlanner,
    private costTracker: CostTracker,
    private searchCache?: ChatSearchCacheService,
    private conversationService?: ConversationService
  ) {}

  /**
   * Run the agentic chat loop. Yields ChatEvents for SSE streaming.
   */
  async *chat(request: ChatRequest): AsyncGenerator<ChatEvent> {
    const { query, history = [], budget = 'standard', signal } = request;
    const startTime = Date.now();

    try {
      // 1. Classify intent → filter tools
      const intent = await this.queryPlanner.classifyIntent(query, 'quick');
      const toolDefs = this.filterTools(intent.domains);

      logger.info('[ChatService] Starting agentic loop', {
        query: query.slice(0, 100),
        domains: intent.domains,
        toolCount: toolDefs.length,
        budget,
      });

      // 2. Pick LLM provider (round-robin)
      const provider = ModelSelector.getNextProvider();
      const selection = ModelSelector.getModelSelection(budget, provider);

      logger.info('[ChatService] Selected LLM', {
        provider: selection.provider,
        model: selection.model,
      });

      // 3. Build messages with token-aware context window
      const messages = this.buildContextMessages(history, query);

      // 4. Convert tool definitions for LLM
      const llmTools = this.convertToolDefs(toolDefs);

      // 5. Agentic loop with streaming
      const llm = getLLMManager();
      let iteration = 0;
      let fullAnswerText = '';
      const collectedToolCalls: ToolCall[] = [];
      const collectedThinkingSteps: Array<{ tool: string; params: any; result: any }> = [];

      while (iteration < MAX_TOOL_CALLS) {
        if (signal?.aborted) break;

        // Stream LLM response
        let fullContent = '';
        let toolCalls: ToolCall[] = [];
        let finishReason: 'stop' | 'tool_calls' = 'stop';
        let hasToolCallDelta = false;

        for await (const chunk of llm.chatCompletionStream(
          {
            messages,
            tools: llmTools.length > 0 ? llmTools : undefined,
            tool_choice: llmTools.length > 0 ? 'auto' : undefined,
            max_tokens: 4096,
            temperature: 0.3,
          },
          budget,
          selection.provider,
          signal
        )) {
          if (signal?.aborted) break;

          if (chunk.type === 'text_delta' && chunk.text) {
            fullContent += chunk.text;
            // Always stream text deltas — if tool calls follow, the frontend
            // clears partial text when it receives the next 'thinking' event
            yield { type: 'answer_delta', data: { text: chunk.text } };
          }

          if (chunk.type === 'tool_call_delta') {
            hasToolCallDelta = true;
          }

          if (chunk.type === 'done') {
            finishReason = chunk.finish_reason || 'stop';
            if (chunk.tool_calls) {
              toolCalls = chunk.tool_calls;
            }
          }
        }

        if (signal?.aborted) break;

        // Final answer — no tool calls
        if (finishReason === 'stop' || toolCalls.length === 0) {
          fullAnswerText = fullContent;
          yield {
            type: 'answer',
            data: { text: fullContent, provider: selection.provider, model: selection.model },
          };
          break;
        }

        // Tool-calling iteration — execute each tool call
        for (const call of toolCalls) {
          collectedToolCalls.push(call);

          yield {
            type: 'thinking',
            data: {
              step: iteration + 1,
              tool: call.name,
              params: call.arguments,
            },
          };

          let toolResult: any;
          let cached = false;

          // Check cache for court search tools
          if (this.searchCache && isCourtSearchTool(call.name)) {
            const hit = await this.searchCache.getCachedResult(call.name, call.arguments);
            if (hit) {
              toolResult = hit;
              cached = true;
              logger.info('[ChatService] Cache hit for tool', { tool: call.name });
            }
          }

          if (!cached) {
            try {
              toolResult = await this.toolRegistry.executeTool(call.name, call.arguments);
            } catch (err: any) {
              toolResult = { error: err.message };
            }

            // Post-execution: cache result & trigger background downloads
            if (this.searchCache && isCourtSearchTool(call.name) && !toolResult?.error) {
              this.searchCache.cacheResult(call.name, call.arguments, toolResult);
              const docIds = this.searchCache.extractDocIds(toolResult);
              if (docIds.length > 0) {
                this.searchCache.triggerBackgroundDownloads(docIds);
              }
            }
          }

          collectedThinkingSteps.push({ tool: call.name, params: call.arguments, result: toolResult });

          const summarized = this.summarizeResult(toolResult);

          // Send the FULL result to the frontend for evidence extraction (decisions, citations).
          // The summarized version is only used for the LLM conversation to save tokens.
          yield {
            type: 'tool_result',
            data: {
              tool: call.name,
              result: toolResult,
              cached,
            },
          };

          // Append assistant tool_calls + tool result to messages (summarized for LLM)
          messages.push({
            role: 'assistant',
            content: fullContent || '',
            tool_calls: [call],
          });
          messages.push({
            role: 'tool',
            content: JSON.stringify(summarized),
            tool_call_id: call.id,
          });
        }

        iteration++;
      }

      // Yield completion event
      const elapsed = Date.now() - startTime;
      yield {
        type: 'complete',
        data: {
          iterations: iteration,
          elapsed_ms: elapsed,
        },
      };

      // Server-side message persistence
      if (this.conversationService && request.conversationId && request.userId) {
        try {
          await this.conversationService.addMessage(request.conversationId, request.userId, {
            role: 'user',
            content: request.query,
          });
          await this.conversationService.addMessage(request.conversationId, request.userId, {
            role: 'assistant',
            content: fullAnswerText,
            tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
            thinking_steps: collectedThinkingSteps.length > 0 ? collectedThinkingSteps : undefined,
          });
        } catch (e) {
          logger.warn('[ChatService] Failed to persist messages', { error: (e as Error).message });
        }
      }
    } catch (err: any) {
      logger.error('[ChatService] Error in agentic loop', { error: err.message, stack: err.stack });
      yield {
        type: 'error',
        data: { message: err.message },
      };
    }
  }

  /**
   * Token-aware sliding window: include as much history as fits within MAX_CONTEXT_CHARS.
   * Uses chars/4 heuristic for token estimation.
   */
  private buildContextMessages(
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    query: string
  ): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ];

    const systemChars = CHAT_SYSTEM_PROMPT.length;
    const queryChars = query.length;
    let availableChars = MAX_CONTEXT_CHARS - systemChars - queryChars;

    // Add history from most recent backwards until budget exhausted
    const historyMessages: UnifiedMessage[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const msgChars = history[i].content.length + 20; // overhead for role/framing
      if (availableChars - msgChars < 0) break;
      availableChars -= msgChars;
      historyMessages.unshift({ role: history[i].role, content: history[i].content });
    }

    messages.push(...historyMessages);
    messages.push({ role: 'user', content: query });
    return messages;
  }

  /**
   * Filter 45+ tools to a relevant subset based on intent domains.
   */
  private filterTools(domains: string[]): ToolDefinition[] {
    const allDefs = this.toolRegistry.getLocalToolDefinitions();

    // Collect tool names from matching domains
    const relevantNames = new Set<string>(DEFAULT_TOOLS);
    for (const domain of domains) {
      const mapped = DOMAIN_TOOL_MAP[domain];
      if (mapped) {
        for (const name of mapped) {
          relevantNames.add(name);
        }
      }
    }

    // If no domains matched, use a broader set
    if (relevantNames.size <= DEFAULT_TOOLS.length && domains.length > 0) {
      // Add all tools from the 'legal_advice' domain as fallback
      const fallback = DOMAIN_TOOL_MAP.legal_advice || [];
      for (const name of fallback) {
        relevantNames.add(name);
      }
    }

    // Filter to only tools that actually exist in the registry
    const filtered = allDefs.filter((d) => relevantNames.has(d.name));

    // Cap at 10 tools to keep token usage reasonable
    return filtered.slice(0, 10);
  }

  /**
   * Convert ToolRegistry definitions to LLM function calling format.
   */
  private convertToolDefs(defs: ToolDefinition[]): ToolDefinitionParam[] {
    return defs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.inputSchema || { type: 'object', properties: {} },
    }));
  }

  /**
   * Summarize large tool results to prevent context window overflow.
   */
  private summarizeResult(result: any): any {
    if (!result) return { empty: true };

    const text = typeof result === 'string' ? result : JSON.stringify(result);

    if (text.length <= MAX_RESULT_LENGTH) {
      return result;
    }

    // For MCP tool results with content array
    if (result.content && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text.length > MAX_RESULT_LENGTH) {
            block.text = block.text.slice(0, MAX_RESULT_LENGTH) + '\n\n[... результат скорочено]';
          }
        }
      }
      return result;
    }

    // Generic truncation
    return {
      summary: text.slice(0, MAX_RESULT_LENGTH),
      truncated: true,
      original_length: text.length,
    };
  }
}
