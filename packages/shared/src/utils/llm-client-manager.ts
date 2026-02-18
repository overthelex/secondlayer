import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';
import { OpenAIClientManager, getOpenAIManager, CostTrackerInterface } from './openai-client';
import { AnthropicClientManager, getAnthropicManager } from './anthropic-client';
import { ModelSelector, LLMProvider, BudgetLevel, ModelSelection } from './model-selector';

export interface ToolDefinitionParam {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface UnifiedChatRequest {
  messages: UnifiedMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
  tools?: ToolDefinitionParam[];
  tool_choice?: 'auto' | 'none';
}

export interface UnifiedChatResponse {
  model: string;
  provider: LLMProvider;
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  tool_calls?: ToolCall[];
  finish_reason: 'stop' | 'tool_calls';
}

export interface UnifiedStreamChunk {
  type: 'text_delta' | 'tool_call_delta' | 'usage' | 'done';
  text?: string;
  tool_call?: Partial<ToolCall> & { index?: number };
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finish_reason?: 'stop' | 'tool_calls';
  tool_calls?: ToolCall[];
  model?: string;
  provider?: LLMProvider;
}

export class LLMClientManager {
  private openaiManager: OpenAIClientManager;
  private anthropicManager: AnthropicClientManager;
  private availableProviders: LLMProvider[];
  private externalApiMetrics: ((service: string, status: string, durationSec: number) => void) | null = null;

  constructor() {
    this.openaiManager = getOpenAIManager();
    this.anthropicManager = getAnthropicManager();
    this.availableProviders = ModelSelector.getAvailableProviders();

    logger.info('LLM Client Manager initialized', {
      providers: this.availableProviders,
    });
  }

  setCostTracker(tracker: CostTrackerInterface) {
    this.openaiManager.setCostTracker(tracker);
    this.anthropicManager.setCostTracker(tracker);
  }

  setExternalApiMetrics(callback: (service: string, status: string, durationSec: number) => void) {
    this.externalApiMetrics = callback;
  }

  async chatCompletion(
    request: UnifiedChatRequest,
    budget: BudgetLevel = 'standard',
    preferredProvider?: LLMProvider
  ): Promise<UnifiedChatResponse> {
    const selection = ModelSelector.getModelSelection(budget, preferredProvider);

    logger.debug('Executing chat completion', {
      budget,
      provider: selection.provider,
      model: selection.model,
    });

    const callStart = Date.now();
    try {
      const result = await this.executeChatCompletion(request, selection);
      const callDuration = (Date.now() - callStart) / 1000;
      this.externalApiMetrics?.(selection.provider, 'success', callDuration);
      return result;
    } catch (primaryError: any) {
      const callDuration = (Date.now() - callStart) / 1000;
      this.externalApiMetrics?.(selection.provider, 'error', callDuration);
      logger.warn(`Primary provider ${selection.provider} failed: ${primaryError.message}`);

      const fallbackProvider = this.getFallbackProvider(selection.provider);
      if (fallbackProvider) {
        logger.info(`Falling back to ${fallbackProvider}`);
        const fallbackSelection = ModelSelector.getModelSelection(budget, fallbackProvider);
        const fbStart = Date.now();
        try {
          const result = await this.executeChatCompletion(request, fallbackSelection);
          this.externalApiMetrics?.(fallbackSelection.provider, 'success', (Date.now() - fbStart) / 1000);
          return result;
        } catch (fbError: any) {
          this.externalApiMetrics?.(fallbackSelection.provider, 'error', (Date.now() - fbStart) / 1000);
          throw fbError;
        }
      }

      throw primaryError;
    }
  }

  private async executeChatCompletion(
    request: UnifiedChatRequest,
    selection: ModelSelection
  ): Promise<UnifiedChatResponse> {
    return await this.executeOpenAIChatCompletion(request, selection.model);
  }

  private async executeOpenAIChatCompletion(
    request: UnifiedChatRequest,
    model: string
  ): Promise<UnifiedChatResponse> {
    const response = await this.openaiManager.executeWithRetry(async (client) => {
      // Map messages: handle tool role and tool_calls for OpenAI format
      const messages = request.messages.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'tool' as const,
            content: m.content,
            tool_call_id: m.tool_call_id!,
          };
        }
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
          return {
            role: 'assistant' as const,
            content: m.content || null,
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          };
        }
        return { role: m.role as 'system' | 'user' | 'assistant', content: m.content };
      });

      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature: request.temperature ?? 0.3,
      };

      if (request.max_tokens) {
        params.max_completion_tokens = request.max_tokens;
      }

      if (request.response_format?.type === 'json_object' && ModelSelector.supportsJsonMode(model)) {
        params.response_format = { type: 'json_object' };
      }

      // Add function calling tools
      if (request.tools && request.tools.length > 0) {
        params.tools = request.tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
        if (request.tool_choice) {
          params.tool_choice = request.tool_choice;
        }
      }

      return await client.chat.completions.create(params);
    });

    const choice = response.choices[0];
    const hasToolCalls = choice?.finish_reason === 'tool_calls' ||
                         (choice?.message?.tool_calls && choice.message.tool_calls.length > 0);

    const toolCalls: ToolCall[] | undefined = hasToolCalls
      ? choice.message.tool_calls!.map((tc: any) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        }))
      : undefined;

    return {
      model: response.model,
      provider: 'openai',
      content: choice?.message?.content || '',
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
      tool_calls: toolCalls,
      finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
    };
  }

  private async executeAnthropicChatCompletion(
    request: UnifiedChatRequest,
    model: string
  ): Promise<UnifiedChatResponse> {
    const systemMessage = request.messages.find((m) => m.role === 'system');

    // Build Anthropic messages, handling tool_use and tool_result
    const conversationMessages: Anthropic.MessageParam[] = [];
    for (const m of request.messages) {
      if (m.role === 'system') continue;

      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Assistant message with tool_use blocks
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) {
          content.push({ type: 'text', text: m.content });
        }
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        conversationMessages.push({ role: 'assistant', content });
      } else if (m.role === 'tool') {
        // Tool result → Anthropic expects this as a user message with tool_result block
        // Check if the last message is already a user message with tool_result content
        const lastMsg = conversationMessages[conversationMessages.length - 1];
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: m.tool_call_id!,
          content: m.content,
        };
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
          // Merge into existing user message
          (lastMsg.content as Anthropic.ContentBlockParam[]).push(toolResultBlock);
        } else {
          conversationMessages.push({
            role: 'user',
            content: [toolResultBlock],
          });
        }
      } else {
        conversationMessages.push({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        });
      }
    }

    const response = await this.anthropicManager.executeWithRetry(async (client) => {
      const params: Anthropic.MessageCreateParams = {
        model,
        messages: conversationMessages,
        max_tokens: request.max_tokens || 4096,
        temperature: request.temperature ?? 0.3,
      };

      if (systemMessage) {
        params.system = systemMessage.content;
      }

      // Add tool definitions
      if (request.tools && request.tools.length > 0) {
        params.tools = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        }));
        if (request.tool_choice === 'auto') {
          params.tool_choice = { type: 'auto' };
        } else if (request.tool_choice === 'none') {
          // Anthropic doesn't have 'none', omit tools instead
          delete params.tools;
        }
      }

      return await client.messages.create(params);
    });

    const textContent = response.content
      .filter((block) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');

    const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
    const hasToolCalls = toolUseBlocks.length > 0;

    const toolCalls: ToolCall[] | undefined = hasToolCalls
      ? toolUseBlocks.map((block: any) => ({
          id: block.id,
          name: block.name,
          arguments: block.input || {},
        }))
      : undefined;

    return {
      model: response.model,
      provider: 'anthropic',
      content: textContent,
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      tool_calls: toolCalls,
      finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
    };
  }

  /**
   * Streaming chat completion — yields UnifiedStreamChunk tokens.
   * Fallback only on connection error (not mid-stream).
   */
  async *chatCompletionStream(
    request: UnifiedChatRequest,
    budget: BudgetLevel = 'standard',
    preferredProvider?: LLMProvider,
    signal?: AbortSignal
  ): AsyncGenerator<UnifiedStreamChunk> {
    const selection = ModelSelector.getModelSelection(budget, preferredProvider);

    logger.debug('Executing streaming chat completion', {
      budget,
      provider: selection.provider,
      model: selection.model,
    });

    const streamStart = Date.now();
    try {
      yield* this.executeOpenAIStreamCompletion(request, selection.model, signal);
      this.externalApiMetrics?.(selection.provider, 'success', (Date.now() - streamStart) / 1000);
    } catch (primaryError: any) {
      this.externalApiMetrics?.(selection.provider, 'error', (Date.now() - streamStart) / 1000);
      logger.warn(`OpenAI streaming failed: ${primaryError.message}`);
      throw primaryError;
    }
  }

  private async *executeOpenAIStreamCompletion(
    request: UnifiedChatRequest,
    model: string,
    signal?: AbortSignal
  ): AsyncGenerator<UnifiedStreamChunk> {
    const messages = request.messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.tool_call_id!,
        };
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return { role: m.role as 'system' | 'user' | 'assistant', content: m.content };
    });

    const params: any = {
      model,
      messages,
      temperature: request.temperature ?? 0.3,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.max_tokens) {
      params.max_completion_tokens = request.max_tokens;
    }

    if (request.response_format?.type === 'json_object' && ModelSelector.supportsJsonMode(model)) {
      params.response_format = { type: 'json_object' };
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      if (request.tool_choice) {
        params.tool_choice = request.tool_choice;
      }
    }

    // Try current key; on 429/401/403 rotate to next key and retry once
    let stream: any;
    try {
      const client = this.openaiManager.getClient();
      stream = await client.chat.completions.create(params, { signal });
    } catch (err: any) {
      if ((err.status === 429 || err.status === 401 || err.status === 403) && this.openaiManager.getClientCount() > 1) {
        logger.warn(`OpenAI streaming key ${err.status}, rotating to next key`);
        this.openaiManager.rotateClient();
        const retryClient = this.openaiManager.getClient();
        stream = await retryClient.chat.completions.create(params, { signal });
      } else {
        throw err;
      }
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: 'stop' | 'tool_calls' = 'stop';

    for await (const chunk of stream as any) {
      if (signal?.aborted) break;

      const choice = chunk.choices?.[0];
      if (choice) {
        // Text delta
        if (choice.delta?.content) {
          yield { type: 'text_delta', text: choice.delta.content };
        }

        // Tool call deltas
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallBuffers.has(idx)) {
              toolCallBuffers.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
            }
            const buf = toolCallBuffers.get(idx)!;
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) buf.args += tc.function.arguments;

            yield {
              type: 'tool_call_delta',
              tool_call: { index: idx, id: buf.id, name: buf.name },
            };
          }
        }

        // Finish reason
        if (choice.finish_reason) {
          finishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop';
        }
      }

      // Usage info (final chunk)
      if (chunk.usage) {
        yield {
          type: 'usage',
          usage: {
            prompt_tokens: chunk.usage.prompt_tokens || 0,
            completion_tokens: chunk.usage.completion_tokens || 0,
            total_tokens: chunk.usage.total_tokens || 0,
          },
        };
      }
    }

    // Assemble completed tool calls
    const completedToolCalls: ToolCall[] = [];
    for (const [, buf] of toolCallBuffers) {
      completedToolCalls.push({
        id: buf.id,
        name: buf.name,
        arguments: buf.args ? JSON.parse(buf.args) : {},
      });
    }

    yield {
      type: 'done',
      finish_reason: finishReason,
      tool_calls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
      model,
      provider: 'openai',
    };
  }

  private async *executeAnthropicStreamCompletion(
    request: UnifiedChatRequest,
    model: string,
    signal?: AbortSignal
  ): AsyncGenerator<UnifiedStreamChunk> {
    const client = this.anthropicManager.getClient();
    const systemMessage = request.messages.find((m) => m.role === 'system');

    const conversationMessages: Anthropic.MessageParam[] = [];
    for (const m of request.messages) {
      if (m.role === 'system') continue;

      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) {
          content.push({ type: 'text', text: m.content });
        }
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        conversationMessages.push({ role: 'assistant', content });
      } else if (m.role === 'tool') {
        const lastMsg = conversationMessages[conversationMessages.length - 1];
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: m.tool_call_id!,
          content: m.content,
        };
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as Anthropic.ContentBlockParam[]).push(toolResultBlock);
        } else {
          conversationMessages.push({
            role: 'user',
            content: [toolResultBlock],
          });
        }
      } else {
        conversationMessages.push({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        });
      }
    }

    const params: any = {
      model,
      messages: conversationMessages,
      max_tokens: request.max_tokens || 4096,
      temperature: request.temperature ?? 0.3,
      stream: true,
    };

    if (systemMessage) {
      params.system = systemMessage.content;
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((t: ToolDefinitionParam) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      }));
      if (request.tool_choice === 'auto') {
        params.tool_choice = { type: 'auto' };
      } else if (request.tool_choice === 'none') {
        delete params.tools;
      }
    }

    const stream = client.messages.stream(params, { signal });
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let blockIndex = 0;
    let finishReason: 'stop' | 'tool_calls' = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream as any) {
      if (signal?.aborted) break;

      switch (event.type) {
        case 'message_start':
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0;
          }
          break;

        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            toolCallBuffers.set(event.index ?? blockIndex, {
              id: event.content_block.id || '',
              name: event.content_block.name || '',
              args: '',
            });
          }
          blockIndex = event.index ?? blockIndex;
          break;

        case 'content_block_delta':
          if (event.delta?.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta?.type === 'input_json_delta') {
            const idx = event.index ?? blockIndex;
            const buf = toolCallBuffers.get(idx);
            if (buf) {
              buf.args += event.delta.partial_json || '';
              yield {
                type: 'tool_call_delta',
                tool_call: { index: idx, id: buf.id, name: buf.name },
              };
            }
          }
          break;

        case 'message_delta':
          if (event.usage) {
            outputTokens = event.usage.output_tokens || 0;
          }
          if (event.delta?.stop_reason) {
            finishReason = event.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop';
          }
          break;
      }
    }

    // Assemble completed tool calls
    const completedToolCalls: ToolCall[] = [];
    for (const [, buf] of toolCallBuffers) {
      completedToolCalls.push({
        id: buf.id,
        name: buf.name,
        arguments: buf.args ? JSON.parse(buf.args) : {},
      });
    }

    yield {
      type: 'usage',
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };

    yield {
      type: 'done',
      finish_reason: finishReason,
      tool_calls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
      model,
      provider: 'anthropic',
    };
  }

  private getFallbackProvider(primaryProvider: LLMProvider): LLMProvider | null {
    const others = this.availableProviders.filter((p) => p !== primaryProvider);
    return others.length > 0 ? others[0] : null;
  }

  getOpenAIClient(): OpenAI {
    return this.openaiManager.getClient();
  }

  getAnthropicClient(): Anthropic {
    return this.anthropicManager.getClient();
  }

  isProviderAvailable(provider: LLMProvider): boolean {
    return this.availableProviders.includes(provider);
  }
}

let llmManager: LLMClientManager | null = null;

export function getLLMManager(): LLMClientManager {
  if (!llmManager) {
    llmManager = new LLMClientManager();
  }
  return llmManager;
}
