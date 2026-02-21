import { logger } from './logger';

export type LLMProvider = 'openai' | 'anthropic';
export type BudgetLevel = 'quick' | 'standard' | 'deep';
export type TaskType = 'search' | 'analysis' | 'lookup';

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
  private static readonly DEFAULT_EMBEDDING_MODEL = 'voyage-multilingual-2';

  private static readonly PROVIDER_STRATEGY = process.env.LLM_PROVIDER_STRATEGY || 'openai-first';

  private static readonly OPENAI_QUICK = process.env.OPENAI_MODEL_QUICK || 'gpt-5-nano';
  private static readonly OPENAI_STANDARD = process.env.OPENAI_MODEL_STANDARD || 'gpt-5-mini';
  private static readonly OPENAI_DEEP = process.env.OPENAI_MODEL_DEEP || 'gpt-5.1';

  private static readonly SINGLE_MODEL = process.env.OPENAI_MODEL;

  static getEmbeddingModel(): string {
    return process.env.VOYAGEAI_EMBEDDING_MODEL || this.DEFAULT_EMBEDDING_MODEL;
  }

  /**
   * @deprecated Use getModelSelection() instead for multi-provider support
   */
  static getChatModel(budget: BudgetLevel): string {
    return this.getModelSelection(budget).model;
  }

  static getModelSelection(budget: BudgetLevel, preferredProvider?: LLMProvider): ModelSelection {
    if (this.SINGLE_MODEL) {
      logger.debug('Using single model for all budgets', { model: this.SINGLE_MODEL, budget });
      return { provider: 'openai', model: this.SINGLE_MODEL, budget };
    }

    const selection: ModelSelection = {
      provider: 'openai',
      model: this.getModelForBudget(budget),
      budget,
    };

    logger.debug('Selected chat model', selection);
    return selection;
  }

  private static selectProvider(): LLMProvider {
    return 'openai';
  }

  /**
   * @deprecated Round-robin removed. Always returns 'openai'.
   */
  static getNextProvider(): LLMProvider {
    return 'openai';
  }

  private static getModelForBudget(budget: BudgetLevel): string {
    return {
      quick: this.OPENAI_QUICK,
      standard: this.OPENAI_STANDARD,
      deep: this.OPENAI_DEEP,
    }[budget];
  }

  static getAvailableProviders(): LLMProvider[] {
    const providers: LLMProvider[] = [];

    if (process.env.OPENAI_API_KEY) {
      providers.push('openai');
    }

    return providers;
  }

  static estimateCost(model: string, tokens: number): number {
    const costPer1M: Record<string, { input: number; output: number }> = {
      // GPT-5 family
      'gpt-5.1': { input: 2.00, output: 8.00 },
      'gpt-5': { input: 2.00, output: 8.00 },
      'gpt-5-mini': { input: 0.40, output: 1.60 },
      'gpt-5-nano': { input: 0.10, output: 0.40 },
      // GPT-4.1 family
      'gpt-4.1': { input: 2.00, output: 8.00 },
      'gpt-4.1-mini': { input: 0.40, output: 1.60 },
      'gpt-4.1-nano': { input: 0.10, output: 0.40 },
      // GPT-4o family
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4o-2024-08-06': { input: 2.50, output: 10.00 },
      // Legacy
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      // Embeddings (OpenAI)
      'text-embedding-ada-002': { input: 0.10, output: 0 },
      'text-embedding-3-small': { input: 0.02, output: 0 },
      'text-embedding-3-large': { input: 0.13, output: 0 },
      // Embeddings (VoyageAI)
      'voyage-multilingual-2': { input: 0.06, output: 0 },
      'voyage-3': { input: 0.06, output: 0 },
      'voyage-3.5': { input: 0.06, output: 0 },
      'voyage-3.5-lite': { input: 0.02, output: 0 },
      'voyage-law-2': { input: 0.12, output: 0 },
      'voyage-3-large': { input: 0.18, output: 0 },
      // Claude (historical — kept for cost tracking of past usage)
      'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
      'claude-opus-4.5': { input: 5.00, output: 25.00 },
      'claude-opus-4.1': { input: 15.00, output: 75.00 },
      'claude-opus-4': { input: 15.00, output: 75.00 },
      'claude-opus-3': { input: 15.00, output: 75.00 },
      'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
      'claude-sonnet-4.5': { input: 3.00, output: 15.00 },
      'claude-sonnet-4': { input: 3.00, output: 15.00 },
      'claude-sonnet-3.7': { input: 3.00, output: 15.00 },
      'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
      'claude-haiku-4.5': { input: 1.00, output: 5.00 },
      'claude-haiku-3.5': { input: 0.80, output: 4.00 },
      'claude-haiku-3': { input: 0.25, output: 1.25 },
      'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
      'claude-opus': { input: 5.00, output: 25.00 },
      'claude-sonnet': { input: 3.00, output: 15.00 },
      'claude-haiku': { input: 1.00, output: 5.00 },
    };

    const pricing = costPer1M[model] || { input: 5.00, output: 15.00 };
    const inputCost = (tokens * 0.7 * pricing.input) / 1_000_000;
    const outputCost = (tokens * 0.3 * pricing.output) / 1_000_000;

    return inputCost + outputCost;
  }

  static estimateCostAccurate(
    model: string,
    promptTokens: number,
    completionTokens: number
  ): number {
    const costPer1M: Record<string, { input: number; output: number }> = {
      // GPT-5 family
      'gpt-5.1': { input: 2.00, output: 8.00 },
      'gpt-5': { input: 2.00, output: 8.00 },
      'gpt-5-mini': { input: 0.40, output: 1.60 },
      'gpt-5-nano': { input: 0.10, output: 0.40 },
      // GPT-4.1 family
      'gpt-4.1': { input: 2.00, output: 8.00 },
      'gpt-4.1-mini': { input: 0.40, output: 1.60 },
      'gpt-4.1-nano': { input: 0.10, output: 0.40 },
      // GPT-4o family
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4o-2024-08-06': { input: 2.50, output: 10.00 },
      // Legacy
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      // Embeddings (OpenAI)
      'text-embedding-ada-002': { input: 0.10, output: 0 },
      'text-embedding-3-small': { input: 0.02, output: 0 },
      'text-embedding-3-large': { input: 0.13, output: 0 },
      // Embeddings (VoyageAI)
      'voyage-multilingual-2': { input: 0.06, output: 0 },
      'voyage-3': { input: 0.06, output: 0 },
      'voyage-3.5': { input: 0.06, output: 0 },
      'voyage-3.5-lite': { input: 0.02, output: 0 },
      'voyage-law-2': { input: 0.12, output: 0 },
      'voyage-3-large': { input: 0.18, output: 0 },
      // Claude (historical — kept for cost tracking of past usage)
      'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
      'claude-opus-4.5': { input: 5.00, output: 25.00 },
      'claude-opus-4.1': { input: 15.00, output: 75.00 },
      'claude-opus-4': { input: 15.00, output: 75.00 },
      'claude-opus-3': { input: 15.00, output: 75.00 },
      'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
      'claude-sonnet-4.5': { input: 3.00, output: 15.00 },
      'claude-sonnet-4': { input: 3.00, output: 15.00 },
      'claude-sonnet-3.7': { input: 3.00, output: 15.00 },
      'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
      'claude-haiku-4.5': { input: 1.00, output: 5.00 },
      'claude-haiku-3.5': { input: 0.80, output: 4.00 },
      'claude-haiku-3': { input: 0.25, output: 1.25 },
      'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
      'claude-opus': { input: 5.00, output: 25.00 },
      'claude-sonnet': { input: 3.00, output: 15.00 },
      'claude-haiku': { input: 1.00, output: 5.00 },
    };

    const pricing = costPer1M[model] || { input: 5.00, output: 15.00 };
    const inputCost = (promptTokens * pricing.input) / 1_000_000;
    const outputCost = (completionTokens * pricing.output) / 1_000_000;

    return inputCost + outputCost;
  }

  static recommendBudget(params: {
    queryLength: number;
    requiresStructuredOutput?: boolean;
    contextSize?: number;
    userSpecified?: 'quick' | 'standard' | 'deep';
  }): 'quick' | 'standard' | 'deep' {
    if (params.userSpecified) {
      return params.userSpecified;
    }

    if (params.queryLength < 20) {
      return 'quick';
    }

    if (params.queryLength > 200 || (params.contextSize && params.contextSize > 5000)) {
      return 'deep';
    }

    if (params.requiresStructuredOutput && params.queryLength > 100) {
      return 'standard';
    }

    return 'standard';
  }

  static supportsJsonMode(model: string): boolean {
    const jsonModeModels = [
      'gpt-5.1',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
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
   * Returns true if the model accepts a custom temperature parameter.
   * Reasoning models (o1, o3, o4-mini, gpt-5 family) only support temperature=1 (default)
   * and will return a 400 error if any other value is passed.
   */
  static supportsTemperature(model: string): boolean {
    const noTemperatureModels = [
      // GPT-5 family — only default temperature supported
      'gpt-5',
      'gpt-5.1',
      'gpt-5-mini',
      'gpt-5-nano',
      // GPT-4.1 family
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      // OpenAI reasoning/o-series models
      'o1',
      'o1-mini',
      'o1-preview',
      'o3',
      'o3-mini',
      'o4-mini',
    ];
    return !noTemperatureModels.includes(model);
  }

  static logUsage(params: {
    model: string;
    budget: 'quick' | 'standard' | 'deep';
    tokens: number;
    task: string;
  }): void {
    const cost = this.estimateCost(params.model, params.tokens);

    logger.info('LLM API usage', {
      model: params.model,
      budget: params.budget,
      tokens: params.tokens,
      estimatedCost: `$${cost.toFixed(6)}`,
      task: params.task,
    });
  }
}
