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

export class LLMClientManager {
  private openaiManager: OpenAIClientManager;
  private anthropicManager: AnthropicClientManager;
  private availableProviders: LLMProvider[];

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

    try {
      return await this.executeChatCompletion(request, selection);
    } catch (primaryError: any) {
      logger.warn(`Primary provider ${selection.provider} failed: ${primaryError.message}`);

      const fallbackProvider = this.getFallbackProvider(selection.provider);
      if (fallbackProvider) {
        logger.info(`Falling back to ${fallbackProvider}`);
        const fallbackSelection = ModelSelector.getModelSelection(budget, fallbackProvider);
        return await this.executeChatCompletion(request, fallbackSelection);
      }

      throw primaryError;
    }
  }

  private async executeChatCompletion(
    request: UnifiedChatRequest,
    selection: ModelSelection
  ): Promise<UnifiedChatResponse> {
    if (selection.provider === 'anthropic') {
      return await this.executeAnthropicChatCompletion(request, selection.model);
    } else {
      return await this.executeOpenAIChatCompletion(request, selection.model);
    }
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
        params.max_tokens = request.max_tokens;
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
