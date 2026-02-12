/**
 * ChatService — Agentic LLM loop for the /api/chat endpoint.
 *
 * Flow:
 * 1. Classify user intent → filter tools to relevant subset
 * 2. Pick LLM provider (round-robin OpenAI ↔ Anthropic)
 * 3. LLM call with function calling / tool_use
 * 4. Execute tool calls via ToolRegistry
 * 5. Feed results back → loop until LLM produces final answer
 * 6. Stream events to client via SSE
 */

import { logger } from '../utils/logger.js';
import { ToolRegistry, ToolDefinition } from '../api/tool-registry.js';
import { QueryPlanner } from './query-planner.js';
import { CostTracker } from './cost-tracker.js';
import {
  getLLMManager,
  UnifiedMessage,
  ToolDefinitionParam,
  UnifiedChatResponse,
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
  type: 'thinking' | 'tool_result' | 'answer' | 'complete' | 'error';
  data: any;
}

export interface ChatRequest {
  query: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  budget?: 'quick' | 'standard' | 'deep';
  conversationId?: string;
  userId?: string;
}

// ============================
// Service
// ============================

const MAX_TOOL_CALLS = parseInt(process.env.MAX_CHAT_TOOL_CALLS || '5', 10);
const MAX_RESULT_LENGTH = 8000; // chars per tool result before summarization

export class ChatService {
  constructor(
    private toolRegistry: ToolRegistry,
    private queryPlanner: QueryPlanner,
    private costTracker: CostTracker,
    private searchCache?: ChatSearchCacheService
  ) {}

  /**
   * Run the agentic chat loop. Yields ChatEvents for SSE streaming.
   */
  async *chat(request: ChatRequest): AsyncGenerator<ChatEvent> {
    const { query, history = [], budget = 'standard' } = request;
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

      // 3. Build messages
      const messages: UnifiedMessage[] = [
        { role: 'system', content: CHAT_SYSTEM_PROMPT },
      ];

      // Add conversation history
      for (const h of history.slice(-6)) {
        messages.push({ role: h.role, content: h.content });
      }

      // Add current query
      messages.push({ role: 'user', content: query });

      // 4. Convert tool definitions for LLM
      const llmTools = this.convertToolDefs(toolDefs);

      // 5. Agentic loop
      const llm = getLLMManager();
      let iteration = 0;

      while (iteration < MAX_TOOL_CALLS) {
        const response: UnifiedChatResponse = await llm.chatCompletion(
          {
            messages,
            tools: llmTools.length > 0 ? llmTools : undefined,
            tool_choice: llmTools.length > 0 ? 'auto' : undefined,
            max_tokens: 4096,
            temperature: 0.3,
          },
          budget,
          selection.provider
        );

        // If the LLM wants to stop, yield the final answer
        if (response.finish_reason === 'stop' || !response.tool_calls || response.tool_calls.length === 0) {
          yield {
            type: 'answer',
            data: { text: response.content, provider: response.provider, model: response.model },
          };
          break;
        }

        // Execute each tool call
        for (const call of response.tool_calls) {
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
            content: response.content || '',
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
    } catch (err: any) {
      logger.error('[ChatService] Error in agentic loop', { error: err.message, stack: err.stack });
      yield {
        type: 'error',
        data: { message: err.message },
      };
    }
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
