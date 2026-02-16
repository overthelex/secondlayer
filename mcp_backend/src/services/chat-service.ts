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
  CHAT_INTENT_CLASSIFICATION_PROMPT,
  DOMAIN_TOOL_MAP,
  DEFAULT_TOOLS,
} from '../prompts/chat-system-prompt.js';
import { buildEnrichedSystemPrompt, SCENARIO_CATALOG } from '../prompts/tool-registry-catalog.js';
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
      // 1. Classify intent via LLM → filter tools
      const classification = await this.classifyChatIntent(query);
      const toolDefs = await this.filterTools(classification.domains, classification.slots);

      // 2. Anthropic pre-analysis: generate response template
      const responseTemplate = await this.generateResponseTemplate(query, classification);

      logger.info('[ChatService] Starting agentic loop', {
        query: query.slice(0, 100),
        domains: classification.domains,
        keywords: classification.keywords,
        toolCount: toolDefs.length,
        budget,
        hasTemplate: !!responseTemplate,
      });

      // 3. Pick LLM provider for the main loop
      const selection = ModelSelector.getModelSelection(budget);

      logger.info('[ChatService] Selected LLM', {
        provider: selection.provider,
        model: selection.model,
      });

      // 4. Build messages with token-aware context window + injected template
      const messages = this.buildContextMessages(history, query, classification.domains, responseTemplate);

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
    query: string,
    classifiedDomains?: string[],
    responseTemplate?: string
  ): UnifiedMessage[] {
    let enrichedPrompt = buildEnrichedSystemPrompt(
      CHAT_SYSTEM_PROMPT,
      SCENARIO_CATALOG,
      classifiedDomains
    );

    // Inject Anthropic-generated response template into system prompt
    if (responseTemplate) {
      enrichedPrompt += `\n\n## Шаблон відповіді (згенерований аналітиком)\n\nДотримуйся цього шаблону при формуванні відповіді. Використовуй інструменти для заповнення конкретними даними.\n\n${responseTemplate}`;
    }

    const messages: UnifiedMessage[] = [
      { role: 'system', content: enrichedPrompt },
    ];

    const systemChars = enrichedPrompt.length;
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
   * Classify chat intent using a fast LLM call (gpt-4o-mini ~200ms).
   * Falls back to keyword-based QueryPlanner on error.
   */
  private async classifyChatIntent(query: string): Promise<{
    domains: string[];
    keywords: string;
    slots?: Record<string, any>;
  }> {
    try {
      const llm = getLLMManager();
      const provider = ModelSelector.getNextProvider();

      const response = await llm.chatCompletion(
        {
          messages: [
            { role: 'system', content: CHAT_INTENT_CLASSIFICATION_PROMPT },
            { role: 'user', content: query },
          ],
          max_tokens: 300,
          temperature: 0.1,
        },
        'quick',
        provider
      );

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
      const slots = parsed.slots && typeof parsed.slots === 'object' && Object.keys(parsed.slots).length > 0
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
      return {
        domains: intent.domains,
        keywords: query,
        slots: intent.slots as Record<string, any> | undefined,
      };
    }
  }

  /**
   * Anthropic pre-analysis: send the user query to Claude to generate a structured
   * response template (legal norms, analysis structure, tool-call strategy).
   * The template is then injected into the system prompt for the main LLM loop.
   */
  private async generateResponseTemplate(
    query: string,
    classification: { domains: string[]; keywords: string; slots?: Record<string, any> }
  ): Promise<string | undefined> {
    try {
      const llm = getLLMManager();
      const available = ModelSelector.getAvailableProviders();

      if (!available.includes('anthropic')) {
        logger.debug('[ChatService] Anthropic not available, skipping pre-analysis');
        return undefined;
      }

      const preAnalysisPrompt = `Ти — старший юридичний аналітик. Проаналізуй запит користувача і створи ШАБЛОН ВІДПОВІДІ, який буде використаний іншим AI-асистентом для формування фінальної відповіді.

## Запит користувача
${query}

## Класифікація запиту
- Домени: ${classification.domains.join(', ')}
- Ключові слова: ${classification.keywords}
${classification.slots ? `- Слоти: ${JSON.stringify(classification.slots)}` : ''}

## Твоя задача
Створи детальний шаблон відповіді, який включає:

1. **Структура відповіді** — які розділи повинна містити відповідь (наприклад: "Правова кваліфікація", "Застосовні норми", "Аналіз судової практики", "Висновок")

2. **Правові норми** — які конкретні статті законів потрібно знайти та процитувати. Вказуй точні посилання: "ст. X Кодексу Y", "ч. Z ст. X Закону Y"

3. **Стратегія пошуку** — які інструменти викликати і в якому порядку, з якими параметрами:
   - search_legal_precedents(query) — для пошуку судових рішень
   - get_court_decision(case_number) — для конкретної справи
   - get_case_documents_chain(case_number) — для історії справи
   - get_legislation_article(law, article) — для статті закону
   - search_legislation(query) — для пошуку законодавства
   - find_similar_fact_pattern_cases(description) — для схожих справ
   - compare_practice_pro_contra(topic) — для порівняння практики

4. **Ключові аспекти аналізу** — на що звернути увагу при аналізі результатів (конкретні правові конструкції, процесуальні особливості, типові помилки)

5. **Формат відповіді** — як оформити фінальну відповідь (структура, рівень деталізації, чи потрібен зразок документа)

## Правила
- Пиши УКРАЇНСЬКОЮ
- Будь конкретним: вказуй точні статті, точні параметри пошуку
- Якщо запит стосується конкретної справи — включи стратегію аналізу всіх інстанцій
- Якщо запит загальний — включи стратегію порівняльного аналізу практики
- Шаблон повинен бути 300-800 слів`;

      const startTime = Date.now();

      const response = await llm.chatCompletion(
        {
          messages: [
            { role: 'user', content: preAnalysisPrompt },
          ],
          max_tokens: 2048,
          temperature: 0.2,
        },
        'standard',
        'anthropic'
      );

      const template = response.content?.trim();
      const elapsed = Date.now() - startTime;

      logger.info('[ChatService] Anthropic pre-analysis completed', {
        elapsed_ms: elapsed,
        templateLength: template?.length || 0,
      });

      return template || undefined;
    } catch (err: any) {
      logger.warn('[ChatService] Anthropic pre-analysis failed, proceeding without template', {
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
