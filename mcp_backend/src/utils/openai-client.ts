import OpenAI from 'openai';
import { logger } from './logger.js';

export class OpenAIClientManager {
  private clients: OpenAI[] = [];
  private currentClientIndex: number = 0;

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
          return await operation(client);
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
}

// Singleton instance
let openAIManager: OpenAIClientManager | null = null;

export function getOpenAIManager(): OpenAIClientManager {
  if (!openAIManager) {
    openAIManager = new OpenAIClientManager();
  }
  return openAIManager;
}
