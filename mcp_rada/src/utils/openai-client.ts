import OpenAI from 'openai';
import { AsyncLocalStorage } from 'async_hooks';
import { logger } from './logger';
import type { CostTracker } from '../services/cost-tracker';
import { ModelSelector } from './model-selector';

/**
 * Request context for tracking API costs across async call chains
 */
export interface RequestContext {
  requestId: string;
  task: string;
}

/**
 * AsyncLocalStorage instance for automatic context propagation
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export class OpenAIClientManager {
  private clients: OpenAI[] = [];
  private currentClientIndex: number = 0;
  private costTracker: CostTracker | null = null;

  constructor() {
    const primaryKey = process.env.OPENAI_API_KEY;
    const secondaryKey = process.env.OPENAI_API_KEY2;

    if (primaryKey) {
      this.clients.push(new OpenAI({ apiKey: primaryKey }));
    }
    if (secondaryKey) {
      this.clients.push(new OpenAI({ apiKey: secondaryKey }));
    }

    if (this.clients.length === 0) {
      throw new Error('No OpenAI API keys configured');
    }

    logger.info(`OpenAI client manager initialized with ${this.clients.length} key(s)`);
  }

  getClient(): OpenAI {
    return this.clients[this.currentClientIndex];
  }

  rotateClient() {
    if (this.clients.length > 1) {
      this.currentClientIndex = (this.currentClientIndex + 1) % this.clients.length;
      logger.info('Rotated to secondary OpenAI API key');
    }
  }

  setCostTracker(tracker: CostTracker) {
    this.costTracker = tracker;
    logger.debug('Cost tracker attached to OpenAI client manager');
  }

  async executeWithRetry<T>(
    operation: (client: OpenAI) => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: any;
    const maxRotations = this.clients.length;

    for (let rotation = 0; rotation < maxRotations; rotation++) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const client = this.getClient();
          const result = await operation(client);

          // Track usage from response
          if (this.costTracker && result && typeof result === 'object') {
            await this.trackOpenAIUsage(result);
          }

          return result;
        } catch (error: any) {
          lastError = error;

          // If it's a rate limit or auth error and we have multiple keys, try next key
          if (
            (error.status === 429 || error.status === 401 || error.status === 403) &&
            this.clients.length > 1 &&
            rotation < maxRotations - 1
          ) {
            this.rotateClient();
            break; // Break inner loop to try with new key
          }

          // If it's a rate limit, wait before retry
          if (error.status === 429 && attempt < maxRetries) {
            const retryAfter = error.headers?.['retry-after'] || Math.pow(2, attempt);
            logger.warn(`Rate limited, waiting ${retryAfter}s before retry`);
            await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          } else if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
    }

    throw new Error(
      `OpenAI operation failed after ${maxRetries * maxRotations} attempts: ${lastError?.message}`
    );
  }

  private async trackOpenAIUsage(response: any): Promise<void> {
    const context = requestContext.getStore();
    if (!context || !this.costTracker || !response.usage) {
      return;
    }

    try {
      // Handle both chat completions and embeddings
      const promptTokens = response.usage.prompt_tokens || 0;
      const completionTokens = response.usage.completion_tokens || 0;
      const totalTokens = response.usage.total_tokens || 0;

      const costUsd = ModelSelector.estimateCostAccurate(
        response.model || 'unknown',
        promptTokens,
        completionTokens
      );

      await this.costTracker.recordOpenAICall({
        requestId: context.requestId,
        model: response.model || 'unknown',
        promptTokens: promptTokens,
        completionTokens: completionTokens,
        totalTokens: totalTokens,
        costUsd: costUsd,
        task: context.task,
      });
    } catch (error) {
      logger.error('Failed to track OpenAI usage:', error);
      // Don't throw - we don't want to interrupt the main request
    }
  }
}

// Singleton instance
let openAIManager: OpenAIClientManager | null = null;

export function getOpenAIManager(): OpenAIClientManager {
  if (!openAIManager) {
    openAIManager = new OpenAIClientManager();
  }
  return openAIManager;
}
