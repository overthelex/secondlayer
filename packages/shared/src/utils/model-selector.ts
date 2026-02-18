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
  private static readonly DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

  private static readonly PROVIDER_STRATEGY = process.env.LLM_PROVIDER_STRATEGY || 'openai-first';

  private static readonly OPENAI_QUICK = process.env.OPENAI_MODEL_QUICK || 'gpt-4o-mini';
  private static readonly OPENAI_STANDARD = process.env.OPENAI_MODEL_STANDARD || 'gpt-4o-mini';
  private static readonly OPENAI_DEEP = process.env.OPENAI_MODEL_DEEP || 'gpt-4o';

  private static readonly ANTHROPIC_QUICK = process.env.ANTHROPIC_MODEL_QUICK || 'claude-haiku-4-5-20251001';
  private static readonly ANTHROPIC_STANDARD = process.env.ANTHROPIC_MODEL_STANDARD || 'claude-sonnet-4-20250514';
  private static readonly ANTHROPIC_DEEP = process.env.ANTHROPIC_MODEL_DEEP || 'claude-sonnet-4-20250514';
  private static readonly ANTHROPIC_ANALYSIS = process.env.ANTHROPIC_MODEL_ANALYSIS || 'claude-opus-4-20250514';

  private static readonly SINGLE_MODEL = process.env.OPENAI_MODEL;

  private static roundRobinCounter = 0;

  static getEmbeddingModel(): string {
    const model = process.env.OPENAI_EMBEDDING_MODEL || this.DEFAULT_EMBEDDING_MODEL;
    return model;
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

    let provider = preferredProvider || this.selectProvider();

    // anthropic-deep: override to Anthropic for deep budget if available
    if (this.PROVIDER_STRATEGY === 'anthropic-deep' && budget === 'deep' && !preferredProvider) {
      const available = this.getAvailableProviders();
      if (available.includes('anthropic')) {
        provider = 'anthropic';
      }
    }

    const selection: ModelSelection = {
      provider,
      model: this.getModelForProvider(provider, budget),
      budget,
    };

    logger.debug('Selected chat model', selection);
    return selection;
  }

  private static selectProvider(): LLMProvider {
    switch (this.PROVIDER_STRATEGY) {
      case 'round-robin':
        return this.getNextProvider();
      case 'anthropic-first':
        return 'anthropic';
      case 'anthropic-deep':
        // Default to OpenAI; deep budget override happens in getModelSelection()
        return 'openai';
      case 'task-aware':
        // Default to OpenAI; actual task routing happens in ChatService via getTaskRouting()
        return 'openai';
      case 'openai-first':
      default:
        return 'openai';
    }
  }

  /**
   * Round-robin provider selection — alternates between available providers.
   * Falls back to single provider if only one is configured.
   */
  static getNextProvider(): LLMProvider {
    const available = this.getAvailableProviders();
    if (available.length === 0) return 'openai'; // fallback
    if (available.length === 1) return available[0];

    const provider = available[this.roundRobinCounter % available.length];
    this.roundRobinCounter++;
    return provider;
  }

  private static getModelForProvider(provider: LLMProvider, budget: BudgetLevel, taskType?: TaskType): string {
    if (provider === 'anthropic') {
      // Use Opus for analysis tasks with deep budget
      if (taskType === 'analysis' && budget === 'deep') {
        return this.ANTHROPIC_ANALYSIS;
      }
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

  static getAvailableProviders(): LLMProvider[] {
    const providers: LLMProvider[] = [];

    if (process.env.OPENAI_API_KEY) {
      providers.push('openai');
    }

    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your-anthropic-key-1') {
      providers.push('anthropic');
    }

    return providers;
  }

  /**
   * Check if the current strategy is task-aware routing.
   */
  static isTaskAwareStrategy(): boolean {
    return this.PROVIDER_STRATEGY === 'task-aware';
  }

  /**
   * Task-aware model routing: maps task types to optimal provider+budget.
   * - search (recall-heavy): GPT-4o (OpenAI deep)
   * - analysis (reasoning): Claude (Anthropic deep)
   * - lookup (simple): gpt-4o-mini (OpenAI quick)
   */
  static getTaskRouting(taskType: TaskType, budget: BudgetLevel): ModelSelection {
    const routing: Record<TaskType, { provider: LLMProvider; budget: BudgetLevel }> = {
      search:   { provider: 'openai',    budget: 'deep' },
      analysis: { provider: 'anthropic', budget: 'deep' },
      lookup:   { provider: 'openai',    budget: 'quick' },
    };
    const route = routing[taskType] || { provider: 'openai', budget };
    const available = this.getAvailableProviders();
    const provider = available.includes(route.provider) ? route.provider : available[0] || 'openai';

    if (this.SINGLE_MODEL) {
      return { provider: 'openai', model: this.SINGLE_MODEL, budget: route.budget };
    }

    return {
      provider,
      model: this.getModelForProvider(provider, route.budget, taskType),
      budget: route.budget,
    };
  }

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
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4o-2024-08-06': { input: 2.50, output: 10.00 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      'text-embedding-ada-002': { input: 0.10, output: 0 },
      'text-embedding-3-small': { input: 0.02, output: 0 },
      'text-embedding-3-large': { input: 0.13, output: 0 },
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
      'gpt-4-turbo',
      'gpt-4-turbo-preview',
      'gpt-4-1106-preview',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4o-2024-08-06',
    ];
    return jsonModeModels.includes(model);
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
