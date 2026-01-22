import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';
import { OpenAIClientManager, getOpenAIManager } from './openai-client.js';
import { AnthropicClientManager, getAnthropicManager } from './anthropic-client.js';
import { ModelSelector, type LLMProvider, type BudgetLevel, type ModelSelection } from './model-selector.js';
import type { CostTracker } from '../services/cost-tracker.js';

/**
 * Unified message format compatible with both OpenAI and Anthropic
 */
export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Unified chat completion request
 */
export interface UnifiedChatRequest {
  messages: UnifiedMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
}

/**
 * Unified chat completion response
 */
export interface UnifiedChatResponse {
  model: string;
  provider: LLMProvider;
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Unified LLM Client Manager
 * Manages multiple LLM providers (OpenAI, Anthropic) with automatic fallback
 */
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

  setCostTracker(tracker: CostTracker) {
    this.openaiManager.setCostTracker(tracker);
    this.anthropicManager.setCostTracker(tracker);
  }

  /**
   * Execute chat completion with automatic provider selection and fallback
   */
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

      // Try fallback to other provider
      const fallbackProvider = this.getFallbackProvider(selection.provider);
      if (fallbackProvider) {
        logger.info(`Falling back to ${fallbackProvider}`);
        const fallbackSelection = ModelSelector.getModelSelection(budget, fallbackProvider);
        return await this.executeChatCompletion(request, fallbackSelection);
      }

      throw primaryError;
    }
  }

  /**
   * Execute chat completion with specific provider
   */
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

  /**
   * Execute OpenAI chat completion
   */
  private async executeOpenAIChatCompletion(
    request: UnifiedChatRequest,
    model: string
  ): Promise<UnifiedChatResponse> {
    const response = await this.openaiManager.executeWithRetry(async (client) => {
      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model,
        messages: request.messages as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature: request.temperature ?? 0.3,
      };

      if (request.max_tokens) {
        params.max_tokens = request.max_tokens;
      }

      if (request.response_format?.type === 'json_object' && ModelSelector.supportsJsonMode(model)) {
        params.response_format = { type: 'json_object' };
      }

      return await client.chat.completions.create(params);
    });

    return {
      model: response.model,
      provider: 'openai',
      content: response.choices[0]?.message?.content || '',
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
    };
  }

  /**
   * Execute Anthropic chat completion
   */
  private async executeAnthropicChatCompletion(
    request: UnifiedChatRequest,
    model: string
  ): Promise<UnifiedChatResponse> {
    // Convert messages to Anthropic format (system message separate)
    const systemMessage = request.messages.find((m) => m.role === 'system');
    const conversationMessages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

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

      return await client.messages.create(params);
    });

    // Extract text content from response
    const textContent = response.content
      .filter((block) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');

    return {
      model: response.model,
      provider: 'anthropic',
      content: textContent,
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  /**
   * Get fallback provider if primary fails
   */
  private getFallbackProvider(primaryProvider: LLMProvider): LLMProvider | null {
    const others = this.availableProviders.filter((p) => p !== primaryProvider);
    return others.length > 0 ? others[0] : null;
  }

  /**
   * Get OpenAI client for direct access (backward compatibility)
   */
  getOpenAIClient(): OpenAI {
    return this.openaiManager.getClient();
  }

  /**
   * Get Anthropic client for direct access
   */
  getAnthropicClient(): Anthropic {
    return this.anthropicManager.getClient();
  }

  /**
   * Check if a provider is available
   */
  isProviderAvailable(provider: LLMProvider): boolean {
    return this.availableProviders.includes(provider);
  }
}

// Singleton instance
let llmManager: LLMClientManager | null = null;

export function getLLMManager(): LLMClientManager {
  if (!llmManager) {
    llmManager = new LLMClientManager();
  }
  return llmManager;
}
