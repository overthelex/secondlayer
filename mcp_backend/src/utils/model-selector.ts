import { logger } from './logger.js';

export type LLMProvider = 'openai' | 'anthropic';
export type BudgetLevel = 'quick' | 'standard' | 'deep';

export interface ModelSelection {
  provider: LLMProvider;
  model: string;
  budget: BudgetLevel;
}

/**
 * Model selection strategy based on reasoning budget and task complexity
 * Supports multiple LLM providers (OpenAI, Anthropic) with automatic fallback
 */
export class ModelSelector {
  private static readonly DEFAULT_EMBEDDING_MODEL = 'text-embedding-ada-002';

  // Provider strategy configuration
  private static readonly PROVIDER_STRATEGY = process.env.LLM_PROVIDER_STRATEGY || 'openai-first';

  // OpenAI chat model configuration
  private static readonly OPENAI_QUICK = process.env.OPENAI_MODEL_QUICK || 'gpt-4o-mini';
  private static readonly OPENAI_STANDARD = process.env.OPENAI_MODEL_STANDARD || 'gpt-4o-mini';
  private static readonly OPENAI_DEEP = process.env.OPENAI_MODEL_DEEP || 'gpt-4o';

  // Anthropic chat model configuration
  private static readonly ANTHROPIC_QUICK = process.env.ANTHROPIC_MODEL_QUICK || 'claude-haiku-4.5';
  private static readonly ANTHROPIC_STANDARD = process.env.ANTHROPIC_MODEL_STANDARD || 'claude-sonnet-4.5';
  private static readonly ANTHROPIC_DEEP = process.env.ANTHROPIC_MODEL_DEEP || 'claude-opus-4.5';

  // Fallback to single model if set (backward compatibility)
  private static readonly SINGLE_MODEL = process.env.OPENAI_MODEL;

  /**
   * Get embedding model (always the same for consistency)
   */
  static getEmbeddingModel(): string {
    const model = process.env.OPENAI_EMBEDDING_MODEL || this.DEFAULT_EMBEDDING_MODEL;
    return model;
  }

  /**
   * Get chat model based on reasoning budget (backward compatible, returns OpenAI model only)
   * @deprecated Use getModelSelection() instead for multi-provider support
   */
  static getChatModel(budget: BudgetLevel): string {
    return this.getModelSelection(budget).model;
  }

  /**
   * Get model selection (provider + model) based on reasoning budget
   */
  static getModelSelection(budget: BudgetLevel, preferredProvider?: LLMProvider): ModelSelection {
    // If OPENAI_MODEL is set, use it for all budgets (backward compatibility)
    if (this.SINGLE_MODEL) {
      logger.debug('Using single model for all budgets', { model: this.SINGLE_MODEL, budget });
      return { provider: 'openai', model: this.SINGLE_MODEL, budget };
    }

    // Determine which provider to use
    const provider = preferredProvider || this.selectProvider();

    const selection: ModelSelection = {
      provider,
      model: this.getModelForProvider(provider, budget),
      budget,
    };

    logger.debug('Selected chat model', selection);
    return selection;
  }

  /**
   * Select LLM provider based on strategy
   */
  private static selectProvider(): LLMProvider {
    switch (this.PROVIDER_STRATEGY) {
      case 'anthropic-first':
        return 'anthropic';
      case 'openai-first':
      default:
        return 'openai';
      // Note: 'round-robin' and 'cheapest' strategies can be implemented by the caller
    }
  }

  /**
   * Get model name for specific provider and budget
   */
  private static getModelForProvider(provider: LLMProvider, budget: BudgetLevel): string {
    if (provider === 'anthropic') {
      return {
        quick: this.ANTHROPIC_QUICK,
        standard: this.ANTHROPIC_STANDARD,
        deep: this.ANTHROPIC_DEEP,
      }[budget];
    } else {
      return {
        quick: this.OPENAI_QUICK,
        standard: this.OPENAI_STANDARD,
        deep: this.OPENAI_DEEP,
      }[budget];
    }
  }

  /**
   * Get all available providers
   */
  static getAvailableProviders(): LLMProvider[] {
    const providers: LLMProvider[] = [];

    // Check if OpenAI is configured
    if (process.env.OPENAI_API_KEY) {
      providers.push('openai');
    }

    // Check if Anthropic is configured
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your-anthropic-key-1') {
      providers.push('anthropic');
    }

    return providers;
  }

  /**
   * Estimate cost per 1M tokens (approximate USD)
   */
  static estimateCost(model: string, tokens: number): number {
    const costPer1M: Record<string, { input: number; output: number }> = {
      // OpenAI models (updated 2026-01-18)
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4o-2024-08-06': { input: 2.50, output: 10.00 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      'text-embedding-ada-002': { input: 0.10, output: 0 },
      'text-embedding-3-small': { input: 0.02, output: 0 },
      'text-embedding-3-large': { input: 0.13, output: 0 },

      // Claude models (updated 2026-01-18)
      'claude-opus-4.5': { input: 5.00, output: 25.00 },
      'claude-opus-4.1': { input: 15.00, output: 75.00 },
      'claude-opus-4': { input: 15.00, output: 75.00 },
      'claude-opus-3': { input: 15.00, output: 75.00 },
      'claude-sonnet-4.5': { input: 3.00, output: 15.00 },
      'claude-sonnet-4': { input: 3.00, output: 15.00 },
      'claude-sonnet-3.7': { input: 3.00, output: 15.00 },
      'claude-haiku-4.5': { input: 1.00, output: 5.00 },
      'claude-haiku-3.5': { input: 0.80, output: 4.00 },
      'claude-haiku-3': { input: 0.25, output: 1.25 },

      // Claude model aliases
      'claude-opus': { input: 5.00, output: 25.00 },
      'claude-sonnet': { input: 3.00, output: 15.00 },
      'claude-haiku': { input: 1.00, output: 5.00 },
    };

    const pricing = costPer1M[model] || { input: 5.00, output: 15.00 };
    // Assume 70% input, 30% output for chat models
    const inputCost = (tokens * 0.7 * pricing.input) / 1_000_000;
    const outputCost = (tokens * 0.3 * pricing.output) / 1_000_000;

    return inputCost + outputCost;
  }

  /**
   * Accurate cost estimation based on real token counts from OpenAI response.usage
   * Instead of 70/30 estimation, uses actual prompt_tokens and completion_tokens
   */
  static estimateCostAccurate(
    model: string,
    promptTokens: number,
    completionTokens: number
  ): number {
    const costPer1M: Record<string, { input: number; output: number }> = {
      // OpenAI models (updated 2026-01-18)
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4o-2024-08-06': { input: 2.50, output: 10.00 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      'text-embedding-ada-002': { input: 0.10, output: 0 },
      'text-embedding-3-small': { input: 0.02, output: 0 },
      'text-embedding-3-large': { input: 0.13, output: 0 },

      // Claude models (updated 2026-01-18 from https://platform.claude.com/docs/en/about-claude/pricing)
      'claude-opus-4.5': { input: 5.00, output: 25.00 },
      'claude-opus-4.1': { input: 15.00, output: 75.00 },
      'claude-opus-4': { input: 15.00, output: 75.00 },
      'claude-opus-3': { input: 15.00, output: 75.00 },
      'claude-sonnet-4.5': { input: 3.00, output: 15.00 },
      'claude-sonnet-4': { input: 3.00, output: 15.00 },
      'claude-sonnet-3.7': { input: 3.00, output: 15.00 },
      'claude-haiku-4.5': { input: 1.00, output: 5.00 },
      'claude-haiku-3.5': { input: 0.80, output: 4.00 },
      'claude-haiku-3': { input: 0.25, output: 1.25 },

      // Claude model aliases (without version numbers)
      'claude-opus': { input: 5.00, output: 25.00 },    // Latest Opus (4.5)
      'claude-sonnet': { input: 3.00, output: 15.00 },  // Latest Sonnet (4.5)
      'claude-haiku': { input: 1.00, output: 5.00 },    // Latest Haiku (4.5)
    };

    const pricing = costPer1M[model] || { input: 5.00, output: 15.00 };

    // Accurate calculation based on real tokens
    const inputCost = (promptTokens * pricing.input) / 1_000_000;
    const outputCost = (completionTokens * pricing.output) / 1_000_000;

    return inputCost + outputCost;
  }

  /**
   * Get recommended budget based on query characteristics
   */
  static recommendBudget(params: {
    queryLength: number;
    requiresStructuredOutput?: boolean;
    contextSize?: number;
    userSpecified?: 'quick' | 'standard' | 'deep';
  }): 'quick' | 'standard' | 'deep' {
    // User override takes priority
    if (params.userSpecified) {
      return params.userSpecified;
    }

    // Very short queries - keyword matching is enough
    if (params.queryLength < 20) {
      return 'quick';
    }

    // Long queries or large context - need deeper analysis
    if (params.queryLength > 200 || (params.contextSize && params.contextSize > 5000)) {
      return 'deep';
    }

    // Structured output (JSON) might need better model
    if (params.requiresStructuredOutput && params.queryLength > 100) {
      return 'standard';
    }

    // Default to standard for most cases
    return 'standard';
  }

  /**
   * Check if model supports JSON mode
   */
  static supportsJsonMode(model: string): boolean {
    const jsonModeModels = [
      'gpt-4-turbo',
      'gpt-4-turbo-preview',
      'gpt-4-1106-preview',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4o-2024-08-06',
    ];
    return jsonModeModels.includes(model);
  }

  /**
   * Log model usage for monitoring
   */
  static logUsage(params: {
    model: string;
    budget: 'quick' | 'standard' | 'deep';
    tokens: number;
    task: string;
  }): void {
    const cost = this.estimateCost(params.model, params.tokens);

    logger.info('OpenAI API usage', {
      model: params.model,
      budget: params.budget,
      tokens: params.tokens,
      estimatedCost: `$${cost.toFixed(6)}`,
      task: params.task,
    });
  }
}
