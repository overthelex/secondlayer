import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';
import type { CostTracker } from '../services/cost-tracker.js';
import { ModelSelector } from './model-selector.js';
import { requestContext } from './openai-client.js';

export class AnthropicClientManager {
  private clients: Anthropic[] = [];
  private currentClientIndex: number = 0;
  private costTracker: CostTracker | null = null;

  constructor() {
    const primaryKey = process.env.ANTHROPIC_API_KEY;
    const secondaryKey = process.env.ANTHROPIC_API_KEY2;

    if (primaryKey && primaryKey !== 'your-anthropic-key-1') {
      this.clients.push(new Anthropic({ apiKey: primaryKey }));
    }
    if (secondaryKey && secondaryKey !== 'your-anthropic-key-2') {
      this.clients.push(new Anthropic({ apiKey: secondaryKey }));
    }

    if (this.clients.length === 0) {
      logger.warn('No Anthropic API keys configured - Anthropic provider will be unavailable');
    } else {
      logger.info(`Anthropic client manager initialized with ${this.clients.length} key(s)`);
    }
  }

  isAvailable(): boolean {
    return this.clients.length > 0;
  }

  getClient(): Anthropic {
    if (this.clients.length === 0) {
      throw new Error('No Anthropic API keys configured');
    }
    return this.clients[this.currentClientIndex];
  }

  rotateClient() {
    if (this.clients.length > 1) {
      this.currentClientIndex = (this.currentClientIndex + 1) % this.clients.length;
      logger.info('Rotated to secondary Anthropic API key');
    }
  }

  setCostTracker(tracker: CostTracker) {
    this.costTracker = tracker;
    logger.debug('Cost tracker attached to Anthropic client manager');
  }

  async executeWithRetry<T>(
    operation: (client: Anthropic) => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: any;
    const maxRotations = Math.max(1, this.clients.length);

    for (let rotation = 0; rotation < maxRotations; rotation++) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const client = this.getClient();
          const result = await operation(client);

          // Track usage from response
          if (this.costTracker && result && typeof result === 'object') {
            await this.trackAnthropicUsage(result);
          }

          return result;
        } catch (error: any) {
          lastError = error;

          // Check for rate limit or auth errors
          const isRateLimit = error.status === 429 || error.error?.type === 'rate_limit_error';
          const isAuthError = error.status === 401 || error.status === 403 ||
                             error.error?.type === 'authentication_error';

          // If we have multiple keys and it's a rate limit/auth error, try next key
          if ((isRateLimit || isAuthError) && this.clients.length > 1 && rotation < maxRotations - 1) {
            this.rotateClient();
            break; // Break inner loop to try with new key
          }

          // If it's a rate limit, wait before retry
          if (isRateLimit && attempt < maxRetries) {
            const retryAfter = error.headers?.['retry-after'] || Math.pow(2, attempt);
            logger.warn(`Anthropic rate limited, waiting ${retryAfter}s before retry`);
            await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          } else if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
    }

    throw new Error(
      `Anthropic operation failed after ${maxRetries * maxRotations} attempts: ${lastError?.message}`
    );
  }

  private async trackAnthropicUsage(response: any): Promise<void> {
    const context = requestContext.getStore();
    if (!context || !this.costTracker || !response.usage) {
      return;
    }

    try {
      // Anthropic usage format: { input_tokens, output_tokens }
      const inputTokens = response.usage.input_tokens || 0;
      const outputTokens = response.usage.output_tokens || 0;
      const totalTokens = inputTokens + outputTokens;

      const costUsd = ModelSelector.estimateCostAccurate(
        response.model || 'unknown',
        inputTokens,
        outputTokens
      );

      await this.costTracker.recordOpenAICall({
        requestId: context.requestId,
        model: response.model || 'unknown',
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: totalTokens,
        costUsd: costUsd,
        task: context.task,
      });

      logger.debug('Tracked Anthropic usage', {
        model: response.model,
        inputTokens,
        outputTokens,
        costUsd: `$${costUsd.toFixed(6)}`,
      });
    } catch (error) {
      logger.error('Failed to track Anthropic usage:', error);
      // Don't throw - we don't want to interrupt the main request
    }
  }
}

// Singleton instance
let anthropicManager: AnthropicClientManager | null = null;

export function getAnthropicManager(): AnthropicClientManager {
  if (!anthropicManager) {
    anthropicManager = new AnthropicClientManager();
  }
  return anthropicManager;
}
