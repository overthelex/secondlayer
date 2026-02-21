/**
 * ChatService — Agentic LLM loop for the /api/chat endpoint.
 *
 * Flow:
 * 1. Classify user intent → filter tools to relevant subset
 * 2. Anthropic pre-analysis: generate response template (structure, legal norms, strategy)
 * 3. Inject template into system prompt for the main LLM
 * 4. Stream LLM response with function calling / tool_use
 * 5. Execute tool calls via ToolRegistry
 * 6. Feed results back → loop until LLM produces final answer
 * 7. Stream token-level events to client via SSE
 */

import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { ToolRegistry, ToolDefinition } from '../api/tool-registry.js';
import { QueryPlanner } from './query-planner.js';
import { generateThinkingDescription } from './thinking-descriptions.js';
import { CostTracker } from './cost-tracker.js';
import { ConversationService } from './conversation-service.js';
import {
  getLLMManager,
  UnifiedMessage,
  ToolDefinitionParam,
  ToolCall,
  type LLMProvider,
} from '@secondlayer/shared';
import { ModelSelector } from '@secondlayer/shared';
import type { EmbeddingService } from './embedding-service.js';
import {
  CHAT_SYSTEM_PROMPT,
  CHAT_INTENT_CLASSIFICATION_PROMPT,
  DOMAIN_TOOL_MAP,
  DEFAULT_TOOLS,
  buildPlanGenerationMessages,
  ExecutionPlan,
} from '../prompts/chat-system-prompt.js';
import { buildEnrichedSystemPrompt, SCENARIO_CATALOG } from '../prompts/tool-registry-catalog.js';
import { ChatSearchCacheService, isCourtSearchTool } from './chat-search-cache-service.js';
import type { ShepardizationService, ShepardizationResult } from './shepardization-service.js';

// ============================
// Types
// ============================

export interface ChatEvent {
  type: 'plan' | 'thinking' | 'tool_result' | 'answer_delta' | 'answer' | 'citation_warning' | 'complete' | 'error';
  data: any;
}

export interface ChatRequest {
  query: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  budget?: 'quick' | 'standard' | 'deep';
  conversationId?: string;
  userId?: string;
  requestId?: string;
  signal?: AbortSignal;
}

// ============================
// Service
// ============================

// Budget-aware limits: deep analysis needs much more context
const BUDGET_LIMITS = {
  quick:    { maxResultChars: 6000,   maxContextChars: 48_000,  maxTokens: 4096,  maxToolCalls: 5,  resolutionSlice: 120 },
  standard: { maxResultChars: 8000,   maxContextChars: 64_000,  maxTokens: 4096,  maxToolCalls: 5,  resolutionSlice: 300 },
  deep:     { maxResultChars: 40_000, maxContextChars: 100_000, maxTokens: 16384, maxToolCalls: 10, resolutionSlice: 800 },
} as const;
type BudgetKey = keyof typeof BUDGET_LIMITS;

const CITATION_CHECK_TIMEOUT_MS = 5_000;
const CASE_NUMBER_REGEX = /\d+\/\d+\/\d{2,4}/g;

// Tools where deduplication hashes only on the primary key (e.g. caseNumber),
// ignoring secondary params like groupByInstance, includeFullText, maxDocs.
const COARSE_HASH_TOOLS: Record<string, string[]> = {
  get_case_documents_chain: ['caseNumber'],
  get_court_decision: ['caseNumber'],
  load_full_texts: ['doc_ids'],
};

/**
 * Compute a deduplication key for a tool call.
 * For court-chain tools, hash only the primary key to catch "same query, different flags" loops.
 */
function toolCallHash(toolName: string, params: Record<string, any>): string {
  const primaryKeys = COARSE_HASH_TOOLS[toolName];
  let payload: string;
  if (primaryKeys) {
    const subset: Record<string, any> = {};
    for (const k of primaryKeys) {
      if (params[k] !== undefined) subset[k] = params[k];
    }
    payload = JSON.stringify(subset);
  } else {
    // Sort keys for deterministic hashing
    payload = JSON.stringify(params, Object.keys(params).sort());
  }
  const hash = createHash('md5').update(payload).digest('hex').slice(0, 12);
  return `${toolName}:${hash}`;
}

export class ChatService {
  /** In-memory cache: conversationId → compressed summary of older history */
  private historySummaryCache = new Map<string, { messageCount: number; summary: string }>();

  constructor(
    private toolRegistry: ToolRegistry,
    private queryPlanner: QueryPlanner,
    private costTracker: CostTracker,
    private searchCache?: ChatSearchCacheService,
    private conversationService?: ConversationService,
    private shepardizationService?: ShepardizationService,
    private embeddingService?: EmbeddingService
  ) {}

  /**
   * Run the agentic chat loop. Yields ChatEvents for SSE streaming.
   */
  async *chat(request: ChatRequest): AsyncGenerator<ChatEvent> {
    const { query, history = [], budget = 'standard', signal, requestId } = request;
    const startTime = Date.now();

    // Create cost tracking record if requestId provided
    if (requestId) {
      try {
        await this.costTracker.createTrackingRecord({
          requestId,
          toolName: 'ai_chat',
          userId: request.userId,
          userQuery: query,
          queryParams: { budget, conversationId: request.conversationId },
        });
      } catch (e) {
        logger.warn('[ChatService] Failed to create tracking record', { error: (e as Error).message });
      }
    }

    try {
      // 1. Classify intent via LLM → filter tools
      const classification = await this.classifyChatIntent(query, requestId);
      const toolDefs = await this.filterTools(classification.domains, classification.slots);

      // 2. Generate execution plan (replaces old response template)
      const plan = await this.generateExecutionPlan(query, classification, toolDefs, requestId);

      // 3. Emit plan to client via SSE
      if (plan) {
        yield { type: 'plan', data: plan };
      }

      // 4. Budget escalation:
      //    - Plan with >= 3 steps → deep
      //    - Complex case analysis (case_number + long query) → deep even without a plan
      let effectiveBudget: BudgetKey = budget;
      if (plan && plan.steps.length >= 3) {
        effectiveBudget = 'deep';
      } else if (
        !plan &&
        classification.slots?.case_number &&
        query.length > 100
      ) {
        effectiveBudget = 'deep';
        logger.info('[ChatService] Auto-escalated to deep budget (case_number + long query, no plan)', {
          caseNumber: classification.slots.case_number,
          queryLength: query.length,
        });
      }

      logger.info('[ChatService] Starting agentic loop', {
        query: query.slice(0, 100),
        domains: classification.domains,
        keywords: classification.keywords,
        toolCount: toolDefs.length,
        budget: effectiveBudget,
        budgetEscalated: effectiveBudget !== budget,
        hasPlan: !!plan,
        planSteps: plan?.steps.length || 0,
      });

      // 4. Pick LLM model for the main loop
      const selection = ModelSelector.getModelSelection(effectiveBudget);

      logger.info('[ChatService] Selected LLM', {
        provider: selection.provider,
        model: selection.model,
      });

      // 5. Build messages with token-aware context window + injected plan
      const limits = BUDGET_LIMITS[effectiveBudget as BudgetKey] || BUDGET_LIMITS.standard;
      const messages = await this.buildContextMessages(history, query, classification.domains, plan, limits.maxContextChars, request.conversationId, requestId);

      // Log estimated prompt size for rate-limit debugging
      const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
      const estimatedTokens = Math.ceil(totalChars / 3.5); // ~3.5 chars per token for multilingual
      logger.info('[ChatService] Prompt size estimate', {
        totalChars,
        estimatedTokens,
        messageCount: messages.length,
        systemPromptChars: messages[0]?.content?.length || 0,
        provider: selection.provider,
        model: selection.model,
      });

      if (estimatedTokens > 25000) {
        logger.warn('[ChatService] Prompt exceeds 25K tokens — risk of Anthropic rate limit', {
          estimatedTokens,
          provider: selection.provider,
        });
      }

      // 4. Convert tool definitions for LLM
      const llmTools = this.convertToolDefs(toolDefs);

      // 5. Agentic loop with streaming
      const llm = getLLMManager();
      let iteration = 0;
      let fullAnswerText = '';
      let totalCostUsd = 0;
      const toolsUsed: string[] = [];
      const collectedToolCalls: ToolCall[] = [];
      const collectedThinkingSteps: Array<{ tool: string; params: any; result: any }> = [];
      const previousToolCallHashes = new Set<string>();

      while (iteration < limits.maxToolCalls) {
        if (signal?.aborted) break;

        // Stream LLM response
        let fullContent = '';
        let toolCalls: ToolCall[] = [];
        let finishReason: 'stop' | 'tool_calls' = 'stop';
        let hasToolCallDelta = false;
        let iterationUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let iterationModel = '';
        let iterationProvider: LLMProvider = 'openai';

        for await (const chunk of llm.chatCompletionStream(
          {
            messages,
            tools: llmTools.length > 0 ? llmTools : undefined,
            tool_choice: llmTools.length > 0 ? 'auto' : undefined,
            max_tokens: limits.maxTokens,
            temperature: 0.3,
          },
          effectiveBudget,
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

          if (chunk.type === 'usage' && chunk.usage) {
            iterationUsage = chunk.usage;
          }

          if (chunk.type === 'done') {
            finishReason = chunk.finish_reason || 'stop';
            if (chunk.tool_calls) {
              toolCalls = chunk.tool_calls;
            }
            if (chunk.model) iterationModel = chunk.model;
            if (chunk.provider) iterationProvider = chunk.provider;
          }
        }

        if (signal?.aborted) break;

        // Record LLM cost for this iteration
        // Anthropic streaming may not report usage; estimate from content length
        let iterationCostUsd = 0;
        if (requestId && iterationModel) {
          if (iterationUsage.total_tokens > 0) {
            iterationCostUsd = ModelSelector.estimateCostAccurate(iterationModel, iterationUsage.prompt_tokens, iterationUsage.completion_tokens);
          } else {
            // Estimate tokens from content length (~3.5 chars/token for multilingual)
            const estPromptTokens = Math.ceil(messages.reduce((s, m) => s + (m.content?.length || 0), 0) / 3.5);
            const estCompletionTokens = Math.ceil((fullContent.length + JSON.stringify(toolCalls).length) / 3.5);
            iterationCostUsd = ModelSelector.estimateCostAccurate(iterationModel, estPromptTokens, estCompletionTokens);
            iterationUsage = { prompt_tokens: estPromptTokens, completion_tokens: estCompletionTokens, total_tokens: estPromptTokens + estCompletionTokens };
            logger.warn('[ChatService] No usage from streaming, estimated tokens', {
              iteration,
              model: iterationModel,
              provider: iterationProvider,
              estPromptTokens,
              estCompletionTokens,
              estimatedCost: iterationCostUsd,
            });
          }
          totalCostUsd += iterationCostUsd;
          this.recordStreamingCost(requestId, iterationProvider, iterationModel, iterationUsage, `chat_iteration_${iteration}`);
        }

        // Final answer — no tool calls
        if (finishReason === 'stop' || toolCalls.length === 0) {
          fullAnswerText = fullContent;
          yield {
            type: 'answer',
            data: { text: fullContent, provider: selection.provider, model: selection.model },
          };
          break;
        }

        // Tool-calling iteration — deduplicate before executing

        // Filter out duplicate tool calls (same tool + same/similar params)
        const uniqueToolCalls: ToolCall[] = [];
        const duplicateToolCalls: ToolCall[] = [];
        for (const call of toolCalls) {
          const hash = toolCallHash(call.name, (call.arguments || {}) as Record<string, any>);
          if (previousToolCallHashes.has(hash)) {
            duplicateToolCalls.push(call);
            logger.warn('[ChatService] Skipping duplicate tool call', {
              tool: call.name,
              hash,
              iteration,
            });
          } else {
            previousToolCallHashes.add(hash);
            uniqueToolCalls.push(call);
          }
        }

        // If ALL tool calls are duplicates, force exit and generate answer from collected data
        if (uniqueToolCalls.length === 0) {
          logger.warn('[ChatService] All tool calls are duplicates — forcing answer generation', {
            iteration,
            duplicates: duplicateToolCalls.map(c => c.name),
          });
          // Push assistant message with the duplicate calls so context is valid,
          // then inject a nudge to synthesize
          messages.push({
            role: 'assistant',
            content: fullContent || '',
            tool_calls: toolCalls,
          });
          for (const call of toolCalls) {
            messages.push({
              role: 'tool',
              content: JSON.stringify({ note: 'Цей інструмент вже було викликано з такими параметрами. Використай наявні результати.' }),
              tool_call_id: call.id,
            });
          }
          messages.push({
            role: 'user',
            content: 'Дані вже отримано. Перейди до аналізу на основі зібраних результатів. Не повторюй виклики інструментів.',
          });
          // Continue to next iteration — the model should now produce a text answer
          iteration++;
          continue;
        }

        // Replace toolCalls with only unique ones for execution
        toolCalls = uniqueToolCalls;

        // Step 1: Emit all thinking events upfront
        for (const call of toolCalls) {
          collectedToolCalls.push(call);
          if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
          yield {
            type: 'thinking',
            data: {
              step: iteration + 1,
              tool: call.name,
              params: call.arguments,
              description: generateThinkingDescription(call.name, call.arguments as Record<string, unknown>),
              cost_usd: iterationCostUsd,
            },
          };
        }

        // Step 2: Execute all tools in parallel
        const settled = await Promise.allSettled(
          toolCalls.map(call => this.executeToolWithCache(call, request.userId))
        );

        // Step 3: Build correct message format — ONE assistant message with ALL tool_calls
        messages.push({
          role: 'assistant',
          content: fullContent || '',
          tool_calls: toolCalls,
        });

        // Step 4: Yield results and append individual tool result messages
        for (let i = 0; i < settled.length; i++) {
          const outcome = settled[i];
          const call = toolCalls[i];

          const toolResult = outcome.status === 'fulfilled'
            ? outcome.value.result
            : { error: (outcome.reason as Error).message };
          const cached = outcome.status === 'fulfilled' ? outcome.value.cached : false;

          collectedThinkingSteps.push({ tool: call.name, params: call.arguments, result: toolResult });

          const summarized = this.summarizeResult(toolResult, limits);

          // Send the FULL result to the frontend for evidence extraction (decisions, citations).
          // The summarized version is only used for the LLM conversation to save tokens.
          yield {
            type: 'tool_result',
            data: {
              tool: call.name,
              result: toolResult,
              cached,
              cost_usd: iterationCostUsd,
            },
          };

          messages.push({
            role: 'tool',
            content: JSON.stringify(summarized),
            tool_call_id: call.id,
          });
        }

        // After first tool execution round, nudge the model to synthesize
        if (iteration === 0 && settled.some(o => o.status === 'fulfilled')) {
          messages.push({
            role: 'user',
            content: 'Дані вже отримано. Перейди до аналізу на основі зібраних результатів. Не повторюй виклики інструментів.',
          });
        }

        // RAG compaction: if accumulated tool results are too large, compact them
        if (this.embeddingService && iteration >= 2) {
          const toolMessages = messages.filter(m => m.role === 'tool');
          if (toolMessages.length >= 3) {
            const toolContents = toolMessages.map(m => ({
              tool: (m as any).tool_call_id || 'unknown',
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            }));
            const compacted = await this.ragCompactToolResults(query, toolContents, limits.maxResultChars * 2);
            // Replace tool message contents with compacted versions
            let compIdx = 0;
            for (const msg of messages) {
              if (msg.role === 'tool' && compIdx < compacted.length) {
                msg.content = compacted[compIdx].content;
                compIdx++;
              }
            }
          }
        }

        iteration++;
      }

      // If loop exhausted MAX_TOOL_CALLS without a final answer, generate fallback
      if (!fullAnswerText && collectedThinkingSteps.length > 0 && !signal?.aborted) {
        logger.warn('[ChatService] Agentic loop exhausted maxToolCalls without final answer', {
          iterations: iteration,
          toolCalls: collectedToolCalls.length,
          maxToolCalls: limits.maxToolCalls,
        });
        // Attempt one more LLM call without tools to force a text answer
        try {
          const summaryPrompt = collectedThinkingSteps
            .map(s => `[${s.tool}]: ${JSON.stringify(s.result).slice(0, 2000)}`)
            .join('\n\n');
          messages.push({
            role: 'user',
            content: `На основі зібраних даних дай повну аналітичну відповідь. Не викликай інструменти.\n\nЗібрані дані:\n${summaryPrompt.slice(0, limits.maxContextChars / 2)}`,
          });
          let fallbackContent = '';
          for await (const chunk of llm.chatCompletionStream(
            { messages, max_tokens: limits.maxTokens, temperature: 0.3 },
            effectiveBudget,
            selection.provider,
            signal
          )) {
            if (signal?.aborted) break;
            if (chunk.type === 'text_delta' && chunk.text) {
              fallbackContent += chunk.text;
              yield { type: 'answer_delta', data: { text: chunk.text } };
            }
          }
          if (fallbackContent) {
            fullAnswerText = fallbackContent;
            yield { type: 'answer', data: { text: fallbackContent, provider: selection.provider, model: selection.model } };
          }
        } catch (fallbackErr: any) {
          logger.warn('[ChatService] Fallback answer generation failed', { error: fallbackErr.message });
        }
      }

      // Post-answer citation verification (non-blocking, with timeout)
      if (this.shepardizationService && fullAnswerText) {
        yield* this.verifyCitationsInAnswer(fullAnswerText);
      }

      // Yield completion event
      const elapsed = Date.now() - startTime;
      yield {
        type: 'complete',
        data: {
          iterations: iteration,
          elapsed_ms: elapsed,
          tools_used: toolsUsed,
          total_cost_usd: totalCostUsd,
        },
      };

      // Server-side message persistence — skip if client disconnected (aborted)
      if (this.conversationService && request.conversationId && request.userId && !signal?.aborted) {
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
            cost_summary: totalCostUsd > 0 ? { total_cost_usd: totalCostUsd, tools_used: toolsUsed } : undefined,
          });
        } catch (e) {
          logger.warn('[ChatService] Failed to persist messages', { error: (e as Error).message });
        }
      } else if (signal?.aborted) {
        logger.info('[ChatService] Skipping message persistence — client disconnected', {
          conversationId: request.conversationId,
          userId: request.userId,
          hadAnswer: !!fullAnswerText,
          toolCallsCount: collectedToolCalls.length,
        });
      }
    } catch (err: any) {
      logger.error('[ChatService] Error in agentic loop', { error: err.message, stack: err.stack });

      // Complete tracking as failed
      if (requestId) {
        try {
          await this.costTracker.completeTrackingRecord({
            requestId,
            executionTimeMs: Date.now() - startTime,
            status: 'failed',
            errorMessage: err.message,
          });
        } catch (e) {
          logger.warn('[ChatService] Failed to complete tracking record', { error: (e as Error).message });
        }
      }

      yield {
        type: 'error',
        data: { message: err.message },
      };
      return;
    }

    // Complete tracking as successful
    if (requestId) {
      try {
        await this.costTracker.completeTrackingRecord({
          requestId,
          executionTimeMs: Date.now() - startTime,
          status: 'completed',
        });
      } catch (e) {
        logger.warn('[ChatService] Failed to complete tracking record', { error: (e as Error).message });
      }
    }
  }

  /**
   * Token-aware sliding window with history compression.
   * Recent messages (last 4) are kept verbatim; older messages are LLM-summarized.
   */
  private async buildContextMessages(
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    query: string,
    classifiedDomains?: string[],
    plan?: ExecutionPlan,
    maxContextChars?: number,
    conversationId?: string,
    requestId?: string
  ): Promise<UnifiedMessage[]> {
    const contextBudget = maxContextChars || BUDGET_LIMITS.standard.maxContextChars;

    let enrichedPrompt = buildEnrichedSystemPrompt(
      CHAT_SYSTEM_PROMPT,
      SCENARIO_CATALOG,
      classifiedDomains
    );

    // Inject execution plan into system prompt
    if (plan) {
      const stepsText = plan.steps
        .map((s) => {
          const paramsStr = JSON.stringify(s.params);
          const depsStr = s.depends_on?.length ? ` (після кроків ${s.depends_on.join(', ')})` : '';
          return `Крок ${s.id}: ${s.tool}(${paramsStr})${depsStr}\n  → Мета: ${s.purpose}`;
        })
        .join('\n\n');

      enrichedPrompt += `\n\n## План виконання

Ціль: ${plan.goal}

${stepsText}

ВАЖЛИВО: Виконай кроки в зазначеному порядку. Можеш адаптувати параметри на основі результатів попередніх кроків.
Використовуй РЕАЛЬНІ дані з результатів інструментів. НІКОЛИ не залишай плейсхолдери — тільки конкретні факти.
Якщо інструмент не повернув певну інформацію — напиши "інформація не знайдена".`;
    }

    const messages: UnifiedMessage[] = [
      { role: 'system', content: enrichedPrompt },
    ];

    const systemChars = enrichedPrompt.length;
    const queryChars = query.length;
    let availableChars = contextBudget - systemChars - queryChars;

    // Split history: last 4 messages are "recent", the rest are "older"
    const RECENT_COUNT = 4;
    const recentHistory = history.slice(-RECENT_COUNT);
    const olderHistory = history.slice(0, Math.max(0, history.length - RECENT_COUNT));

    // Compress older history into a summary if it exists
    if (olderHistory.length > 0) {
      const summary = await this.compressOlderHistory(olderHistory, conversationId, requestId);
      if (summary) {
        const summaryChars = summary.length + 20;
        if (availableChars - summaryChars > 0) {
          messages.push({ role: 'user', content: summary });
          availableChars -= summaryChars;
        }
      }
    }

    // Add recent messages verbatim (truncated to 2000 chars each), from most recent backwards
    const recentMessages: UnifiedMessage[] = [];
    for (let i = recentHistory.length - 1; i >= 0; i--) {
      const content = recentHistory[i].content.slice(0, 2000);
      const msgChars = content.length + 20;
      if (availableChars - msgChars < 0) break;
      availableChars -= msgChars;
      recentMessages.unshift({ role: recentHistory[i].role, content });
    }

    messages.push(...recentMessages);
    messages.push({ role: 'user', content: query });
    return messages;
  }

  /**
   * Compress older chat history into a concise summary using a quick LLM call.
   * Caches summaries per conversation to avoid re-summarizing on each iteration.
   */
  private async compressOlderHistory(
    olderMessages: Array<{ role: string; content: string }>,
    conversationId?: string,
    requestId?: string
  ): Promise<string | null> {
    // If total content is small, just concatenate
    const totalChars = olderMessages.reduce((sum, m) => sum + m.content.length, 0);
    if (totalChars < 2000) {
      const concat = olderMessages.map(m => `${m.role}: ${m.content}`).join('\n');
      return `[Контекст попередніх повідомлень]: ${concat}`;
    }

    // Check cache
    if (conversationId) {
      const cached = this.historySummaryCache.get(conversationId);
      if (cached && cached.messageCount === olderMessages.length) {
        return cached.summary;
      }
    }

    try {
      const llm = getLLMManager();

      const historyText = olderMessages
        .map(m => `${m.role}: ${m.content.slice(0, 1000)}`)
        .join('\n---\n');

      const response = await llm.chatCompletion(
        {
          messages: [
            {
              role: 'system',
              content: 'Стисло підсумуй контекст розмови (до 200 слів). Збережи ключові юридичні факти, номери справ, посилання на закони та прийняті рішення. Відповідай українською.',
            },
            { role: 'user', content: historyText },
          ],
          max_tokens: 400,
          temperature: 0.1,
        },
        'quick'
      );

      if (requestId && response.usage) {
        this.recordStreamingCost(requestId, response.provider, response.model, response.usage, 'history_compression');
      }

      const summary = `[Контекст попередніх повідомлень]: ${response.content || ''}`;

      // Cache the summary
      if (conversationId) {
        this.historySummaryCache.set(conversationId, {
          messageCount: olderMessages.length,
          summary,
        });
      }

      logger.info('[ChatService] Compressed older history', {
        originalMessages: olderMessages.length,
        originalChars: totalChars,
        summaryChars: summary.length,
      });

      return summary;
    } catch (err: any) {
      logger.warn('[ChatService] History compression failed, using truncated concat', { error: err.message });
      // Fallback: truncated concatenation
      const concat = olderMessages
        .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
        .join('\n');
      return `[Контекст попередніх повідомлень]: ${concat}`.slice(0, 3000);
    }
  }

  /**
   * Classify chat intent using a fast LLM call (gpt-4o-mini ~200ms).
   * Falls back to keyword-based QueryPlanner on error.
   */
  private async classifyChatIntent(query: string, requestId?: string): Promise<{
    domains: string[];
    keywords: string;
    slots?: Record<string, any>;
  }> {
    try {
      const llm = getLLMManager();

      const classifyChars = CHAT_INTENT_CLASSIFICATION_PROMPT.length + query.length;
      logger.debug('[ChatService] Intent classification prompt size', {
        chars: classifyChars,
        estimatedTokens: Math.ceil(classifyChars / 3.5),
      });

      const response = await llm.chatCompletion(
        {
          messages: [
            { role: 'system', content: CHAT_INTENT_CLASSIFICATION_PROMPT },
            { role: 'user', content: query },
          ],
          max_tokens: 300,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        },
        'quick'
      );

      // Record classification LLM cost
      if (requestId && response.usage) {
        this.recordStreamingCost(requestId, response.provider, response.model, response.usage, 'intent_classification');
      }

      const content = response.content || '{}';

      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in classification response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const domains = Array.isArray(parsed.domains) && parsed.domains.length > 0
        ? parsed.domains
        : ['court'];
      const keywords = typeof parsed.keywords === 'string' ? parsed.keywords : query;
      let slots: Record<string, any> | undefined = parsed.slots && typeof parsed.slots === 'object' && Object.keys(parsed.slots).length > 0
        ? parsed.slots
        : undefined;

      // Force-include domains based on extracted slots
      if (slots?.edrpou && !domains.includes('registry')) {
        domains.push('registry');
      }
      if (slots?.case_number && !domains.includes('court')) {
        domains.push('court');
      }
      if (slots?.law_reference && !domains.includes('legislation')) {
        domains.push('legislation');
      }

      // Safety net: extract case_number from query if LLM missed it
      if (!slots?.case_number) {
        const caseMatch = query.match(/\d+\/\d+\/\d{2,4}/);
        if (caseMatch) {
          if (!slots) slots = {};
          slots.case_number = caseMatch[0];
        }
      }

      // Keyword-based safety net for registry queries
      const lowerQuery = query.toLowerCase();
      const registryKeywords = ['тов ', 'тов "', 'тов «', 'фоп ', 'пп ', 'ат ', 'єдрпоу', 'edrpou', 'підприємство', 'компанія', 'юридична особа'];
      const hasRegistryKeyword = registryKeywords.some(kw => lowerQuery.includes(kw));
      const hasEdrpouPattern = /\b\d{8}\b/.test(query);
      if ((hasRegistryKeyword || hasEdrpouPattern) && !domains.includes('registry')) {
        domains.push('registry');
      }

      logger.info('[ChatService] LLM intent classification', { domains, keywords, slots });

      return { domains, keywords, slots };
    } catch (err: any) {
      logger.warn('[ChatService] LLM classification failed, falling back to keyword matching', {
        error: err.message,
      });

      // Fallback to keyword-based classification
      const intent = await this.queryPlanner.classifyIntent(query, 'quick');
      const fallbackSlots = (intent.slots as Record<string, any>) || {};

      // Extract case_number from query if QueryPlanner didn't
      if (!fallbackSlots.case_number) {
        const caseMatch = query.match(/\d+\/\d+\/\d{2,4}/);
        if (caseMatch) {
          fallbackSlots.case_number = caseMatch[0];
        }
      }

      return {
        domains: intent.domains,
        keywords: query,
        slots: Object.keys(fallbackSlots).length > 0 ? fallbackSlots : undefined,
      };
    }
  }

  /**
   * Generate a structured execution plan: which tools to call, in what order,
   * with what parameters. Uses a fast LLM call (quick budget, ~200-400ms).
   * Falls back to undefined on error → agentic loop runs without a plan.
   */
  private async generateExecutionPlan(
    query: string,
    classification: { domains: string[]; keywords: string; slots?: Record<string, any> },
    toolDefs: ToolDefinition[],
    requestId?: string
  ): Promise<ExecutionPlan | undefined> {
    try {
      const llm = getLLMManager();

      // Build tool descriptions for the prompt
      const toolDescriptions = toolDefs
        .map((d) => `- ${d.name}: ${d.description}`)
        .join('\n');

      const planMessages = buildPlanGenerationMessages(query, classification, toolDescriptions);

      const totalChars = planMessages.reduce((s, m) => s + m.content.length, 0);
      logger.debug('[ChatService] Execution plan prompt size', {
        chars: totalChars,
        estimatedTokens: Math.ceil(totalChars / 3.5),
      });

      const startTime = Date.now();

      const response = await llm.chatCompletion(
        {
          messages: planMessages,
          max_tokens: 800,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        },
        'quick',
        'openai'
      );

      // Record plan generation LLM cost
      if (requestId && response.usage) {
        this.recordStreamingCost(requestId, response.provider, response.model, response.usage, 'plan_generation');
      }

      const content = response.content || '{}';
      const elapsed = Date.now() - startTime;

      logger.debug('[ChatService] Plan generation response', {
        model: response.model,
        contentLength: content.length,
        contentPreview: content.slice(0, 500),
      });

      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in plan response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Empty object means model decided no plan is needed (simple/conversational query)
      if (Object.keys(parsed).length === 0) {
        return undefined;
      }

      // Validate plan structure
      if (!parsed.goal || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        logger.warn('[ChatService] Plan validation failed - invalid structure', {
          parsed: JSON.stringify(parsed).slice(0, 500),
          hasGoal: !!parsed.goal,
          hasSteps: Array.isArray(parsed.steps),
          stepsLength: parsed.steps?.length,
          model: response.model,
          provider: response.provider,
        });
        throw new Error('Invalid plan structure: missing goal or steps');
      }

      // Cap at 5 steps
      const steps = parsed.steps.slice(0, 5);

      // Validate each step has required fields
      for (const step of steps) {
        if (!step.tool || !step.purpose) {
          throw new Error(`Invalid step: missing tool or purpose`);
        }
        step.params = step.params || {};
      }

      const plan: ExecutionPlan = {
        goal: parsed.goal,
        steps,
        expected_iterations: parsed.expected_iterations || steps.length,
      };

      logger.info('[ChatService] Execution plan generated', {
        provider: 'openai',
        elapsed_ms: elapsed,
        steps: plan.steps.length,
        goal: plan.goal.slice(0, 100),
      });

      return plan;
    } catch (err: any) {
      logger.warn('[ChatService] Plan generation failed, proceeding without plan', {
        error: err.message,
      });
      return undefined;
    }
  }

  /**
   * Filter 45+ tools to a relevant subset based on intent domains.
   */
  private async filterTools(domains: string[], slots?: Record<string, any>): Promise<ToolDefinition[]> {
    const allDefs = await this.toolRegistry.getAllToolDefinitions();

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

    // If EDRPOU is in slots, ensure all registry tools are included
    if (slots?.edrpou) {
      const registryTools = DOMAIN_TOOL_MAP.registry || [];
      for (const name of registryTools) {
        relevantNames.add(name);
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

    // Cap at 15 tools — modern LLMs handle 15-20 tools fine
    return filtered.slice(0, 15);
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
   * Budget-aware: deep analysis preserves much more content.
   */
  private summarizeResult(result: any, limits: typeof BUDGET_LIMITS[BudgetKey]): any {
    if (!result) return { empty: true };

    const maxLen = limits.maxResultChars;

    // For MCP tool results with content array — try compact extraction first
    if (result.content && Array.isArray(result.content)) {
      const compacted = this.compactCourtResult(result, limits);
      if (compacted) return compacted;

      // Fallback: truncate text blocks
      const cloned = { ...result, content: result.content.map((b: any) => ({ ...b })) };
      for (const block of cloned.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text.length > maxLen) {
            block.text = block.text.slice(0, maxLen) + '\n\n[... результат скорочено]';
          }
        }
      }
      return cloned;
    }

    const text = typeof result === 'string' ? result : JSON.stringify(result);

    if (text.length <= maxLen) {
      return result;
    }

    // Generic truncation
    return {
      summary: text.slice(0, maxLen),
      truncated: true,
      original_length: text.length,
    };
  }

  /**
   * Compact court document chain/search results for LLM context.
   * Never sends full_text to LLM — extracts key sections (FACTS, REASONING, DECISION) instead.
   * Budget-aware section limits: quick=500, standard=1500, deep=3000 chars per section.
   */
  private compactCourtResult(result: any, limits: typeof BUDGET_LIMITS[BudgetKey]): any | null {
    if (!result.content?.[0]?.text) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(result.content[0].text);
    } catch {
      return null;
    }

    const resSlice = limits.resolutionSlice;
    const sectionLimit = limits.maxTokens > 4096 ? 3000 : (limits.maxResultChars <= 6000 ? 500 : 1500);

    // Case documents chain: { case_number, total_documents, grouped_documents }
    // For chain results we send ONLY metadata (no key_sections) so that ALL documents
    // fit within the budget.  The LLM can call load_full_texts for deeper analysis.
    if (parsed.grouped_documents && parsed.total_documents) {
      const compact: any = {
        case_number: parsed.case_number,
        total_documents: parsed.total_documents,
        grouped_documents: {},
      };

      for (const [instance, docs] of Object.entries(parsed.grouped_documents)) {
        compact.grouped_documents[instance] = (docs as any[]).map((d: any) => {
          const entry: any = {
            doc_id: d.doc_id,
            case_number: d.case_number,
            document_type: d.document_type,
            instance: d.instance,
            court: d.court,
            judge: d.judge,
            date: d.date,
            resolution: d.resolution ? d.resolution.slice(0, resSlice) : undefined,
          };
          // Only include snippets for chain results — key_sections are too large
          // and cause truncation when there are many documents (e.g. 29 docs × 3 sections × 3000 chars)
          if (d.snippets) entry.snippets = d.snippets;
          return entry;
        });
      }

      const compactText = JSON.stringify(compact);
      if (compactText.length > limits.maxResultChars) {
        return { content: [{ type: 'text', text: compactText.slice(0, limits.maxResultChars) + '\n[... скорочено]' }] };
      }
      return { content: [{ type: 'text', text: compactText }] };
    }

    // Search results: { results: [...], total_count }
    if (Array.isArray(parsed.results)) {
      const compact = {
        total_count: parsed.total_count || parsed.results.length,
        results: parsed.results.map((r: any) => {
          const entry: any = {
            doc_id: r.doc_id,
            case_number: r.case_number,
            document_type: r.document_type,
            court: r.court,
            judge: r.judge,
            date: r.date || r.adjudication_date,
            instance: r.instance,
            resolution: r.resolution ? r.resolution.slice(0, resSlice) : undefined,
          };
          entry.key_sections = this.extractKeySections(r.sections, r.full_text, sectionLimit);
          if (r.snippets) entry.snippets = r.snippets;
          return entry;
        }),
      };

      const compactText = JSON.stringify(compact);
      if (compactText.length > limits.maxResultChars) {
        return { content: [{ type: 'text', text: compactText.slice(0, limits.maxResultChars) + '\n[... скорочено]' }] };
      }
      return { content: [{ type: 'text', text: compactText }] };
    }

    return null;
  }

  /**
   * Extract key sections (FACTS, COURT_REASONING, DECISION) from court document.
   * Uses structured sections if available, otherwise falls back to regex extraction from full_text.
   */
  private extractKeySections(
    sections: any,
    fullText: string | undefined,
    charLimit: number
  ): { facts?: string; reasoning?: string; decision?: string } | undefined {
    const KEY_SECTION_TYPES = ['FACTS', 'COURT_REASONING', 'DECISION', 'ВСТАНОВИВ', 'МОТИВУВАЛЬНА', 'РЕЗОЛЮТИВНА'];

    const result: { facts?: string; reasoning?: string; decision?: string } = {};

    // Try structured sections first
    if (sections && Array.isArray(sections)) {
      for (const s of sections) {
        const type = (s.type || s.section_type || '').toUpperCase();
        const text = s.text || s.content || '';
        if (!text) continue;

        if (type.includes('FACT') || type.includes('ВСТАНОВИВ')) {
          result.facts = text.slice(0, charLimit);
        } else if (type.includes('REASON') || type.includes('МОТИВ')) {
          result.reasoning = text.slice(0, charLimit);
        } else if (type.includes('DECISION') || type.includes('РЕЗОЛЮТ')) {
          result.decision = text.slice(0, charLimit);
        }
      }
    }

    // If we didn't find sections from structured data, try regex from full_text
    if (!result.facts && !result.reasoning && !result.decision && fullText) {
      // Ukrainian court decisions commonly have: ВСТАНОВИВ, МОТИВУВАЛЬНА ЧАСТИНА, ВИРІШИВ/УХВАЛИВ/ПОСТАНОВИВ
      const factsMatch = fullText.match(/ВСТАНОВИВ[:\s]*([\s\S]{10,}?)(?=(?:МОТИВУВАЛЬНА|ВИРІШИВ|УХВАЛИВ|ПОСТАНОВИВ)|$)/i);
      const reasoningMatch = fullText.match(/МОТИВУВАЛЬНА[^:]*:[:\s]*([\s\S]{10,}?)(?=(?:ВИРІШИВ|УХВАЛИВ|ПОСТАНОВИВ|РЕЗОЛЮТИВНА)|$)/i);
      const decisionMatch = fullText.match(/(?:ВИРІШИВ|УХВАЛИВ|ПОСТАНОВИВ)[:\s]*([\s\S]{10,}?)$/i);

      if (factsMatch) result.facts = factsMatch[1].trim().slice(0, charLimit);
      if (reasoningMatch) result.reasoning = reasoningMatch[1].trim().slice(0, charLimit);
      if (decisionMatch) result.decision = decisionMatch[1].trim().slice(0, charLimit);
    }

    // Return undefined if no sections extracted to avoid empty object in JSON
    return (result.facts || result.reasoning || result.decision) ? result : undefined;
  }

  /**
   * RAG-based compaction of tool results when context gets too large.
   * Embeds the user query, computes cosine similarity with each tool result,
   * and keeps the top-K most relevant results fully while summarizing the rest.
   * Only triggers when there are 3+ results and total chars exceed threshold.
   */
  private async ragCompactToolResults(
    query: string,
    toolResults: Array<{ tool: string; content: string }>,
    maxChars: number
  ): Promise<Array<{ tool: string; content: string }>> {
    if (!this.embeddingService || toolResults.length < 3) return toolResults;

    const totalChars = toolResults.reduce((sum, r) => sum + r.content.length, 0);
    if (totalChars <= maxChars * 1.5) return toolResults;

    try {
      // Embed the query
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);

      // Embed each tool result (use first 500 chars as representative)
      const scored = await Promise.all(
        toolResults.map(async (r) => {
          const snippet = r.content.slice(0, 500);
          const embedding = await this.embeddingService!.generateEmbedding(snippet);
          const similarity = this.cosineSimilarity(queryEmbedding, embedding);
          return { ...r, similarity };
        })
      );

      // Sort by relevance (highest first)
      scored.sort((a, b) => b.similarity - a.similarity);

      // Keep top results fully until we approach the budget; summarize the rest
      const compacted: Array<{ tool: string; content: string }> = [];
      let usedChars = 0;

      for (const item of scored) {
        if (usedChars + item.content.length <= maxChars) {
          compacted.push({ tool: item.tool, content: item.content });
          usedChars += item.content.length;
        } else {
          // Summarize to just metadata line
          const summary = `[${item.tool}]: результат скорочено (релевантність: ${item.similarity.toFixed(2)}, ${item.content.length} символів)`;
          compacted.push({ tool: item.tool, content: summary });
          usedChars += summary.length;
        }
      }

      logger.info('[ChatService] RAG compacted tool results', {
        originalResults: toolResults.length,
        originalChars: totalChars,
        compactedChars: usedChars,
        fullResults: compacted.filter(r => !r.content.startsWith('[')).length,
      });

      return compacted;
    } catch (err: any) {
      logger.warn('[ChatService] RAG compaction failed, returning original results', { error: err.message });
      return toolResults;
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Record LLM cost for a single call (streaming or non-streaming).
   * Fire-and-forget — errors are logged but don't break the chat flow.
   */
  private recordStreamingCost(
    requestId: string,
    provider: LLMProvider,
    model: string,
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    task: string
  ): void {
    const costUsd = ModelSelector.estimateCostAccurate(model, usage.prompt_tokens, usage.completion_tokens);

    const params = {
      requestId,
      model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUsd,
      task,
    };

    this.costTracker.recordOpenAICall(params).catch((e: Error) => {
      logger.warn('[ChatService] Failed to record LLM cost', { error: e.message, task });
    });
  }

  /**
   * Extract case numbers from the LLM answer and verify their precedent status.
   * Yields citation_warning events for overruled or limited decisions.
   */
  private async *verifyCitationsInAnswer(answerText: string): AsyncGenerator<ChatEvent> {
    try {
      const matches = answerText.match(CASE_NUMBER_REGEX);
      if (!matches || matches.length === 0) return;

      const caseNumbers = [...new Set(matches)];
      logger.info('[ChatService] Verifying citations in answer', { count: caseNumbers.length });

      const results = await Promise.race([
        this.shepardizationService!.batchAnalyze(caseNumbers),
        new Promise<ShepardizationResult[]>((_, reject) =>
          setTimeout(() => reject(new Error('citation check timeout')), CITATION_CHECK_TIMEOUT_MS)
        ),
      ]);

      for (const result of results) {
        if (result.status === 'explicitly_overruled' || result.status === 'limited') {
          yield {
            type: 'citation_warning',
            data: {
              case_number: result.case_number,
              status: result.status,
              confidence: result.confidence,
              affecting_decisions: result.affecting_decisions,
              message: result.status === 'explicitly_overruled'
                ? `Рішення у справі ${result.case_number} було скасовано вищою інстанцією`
                : `Рішення у справі ${result.case_number} було змінено вищою інстанцією`,
            },
          };
        }
      }
    } catch (err: any) {
      logger.debug('[ChatService] Citation verification skipped', { error: err.message });
      // Non-critical — don't yield error, just skip
    }
  }

  /**
   * Execute a single tool call with cache check/store logic.
   * Extracted to enable parallel execution via Promise.allSettled().
   */
  private async executeToolWithCache(
    call: ToolCall,
    userId?: string
  ): Promise<{ call: ToolCall; result: any; cached: boolean }> {
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
        const VAULT_TOOLS = new Set(['store_document', 'get_document', 'list_documents', 'semantic_search', 'list_folders']);
        const toolArgs = (userId && VAULT_TOOLS.has(call.name))
          ? { ...call.arguments, userId }
          : call.arguments;
        toolResult = await this.toolRegistry.executeTool(call.name, toolArgs);
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

    return { call, result: toolResult, cached };
  }
}
