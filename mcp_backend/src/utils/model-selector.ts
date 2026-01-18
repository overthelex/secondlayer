import { logger } from './logger.js';

/**
 * Model selection strategy based on reasoning budget and task complexity
 */
export class ModelSelector {
  private static readonly DEFAULT_EMBEDDING_MODEL = 'text-embedding-ada-002';

  // Chat model configuration from environment
  private static readonly QUICK_MODEL = process.env.OPENAI_MODEL_QUICK || 'gpt-4o-mini';
  private static readonly STANDARD_MODEL = process.env.OPENAI_MODEL_STANDARD || 'gpt-4o-mini';
  private static readonly DEEP_MODEL = process.env.OPENAI_MODEL_DEEP || 'gpt-4o';

  // Fallback to single model if set
  private static readonly SINGLE_MODEL = process.env.OPENAI_MODEL;

  /**
   * Get embedding model (always the same for consistency)
   */
  static getEmbeddingModel(): string {
    const model = process.env.OPENAI_EMBEDDING_MODEL || this.DEFAULT_EMBEDDING_MODEL;
    return model;
  }

  /**
   * Get chat model based on reasoning budget
   */
  static getChatModel(budget: 'quick' | 'standard' | 'deep'): string {
    // If OPENAI_MODEL is set, use it for all budgets (backward compatibility)
    if (this.SINGLE_MODEL) {
      logger.debug('Using single model for all budgets', { model: this.SINGLE_MODEL, budget });
      return this.SINGLE_MODEL;
    }

    // Otherwise use budget-specific models
    const models = {
      quick: this.QUICK_MODEL,
      standard: this.STANDARD_MODEL,
      deep: this.DEEP_MODEL,
    };

    const selectedModel = models[budget];
    logger.debug('Selected chat model', { budget, model: selectedModel });

    return selectedModel;
  }

  /**
   * Estimate cost per 1M tokens (approximate USD)
   */
  static estimateCost(model: string, tokens: number): number {
    const costPer1M: Record<string, { input: number; output: number }> = {
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4o-2024-08-06': { input: 2.50, output: 10.00 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      'text-embedding-ada-002': { input: 0.10, output: 0 },
      'text-embedding-3-small': { input: 0.02, output: 0 },
      'text-embedding-3-large': { input: 0.13, output: 0 },
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
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4o-2024-08-06': { input: 2.50, output: 10.00 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      'text-embedding-ada-002': { input: 0.10, output: 0 },
      'text-embedding-3-small': { input: 0.02, output: 0 },
      'text-embedding-3-large': { input: 0.13, output: 0 },
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
