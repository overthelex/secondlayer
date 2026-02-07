import { createClient } from 'redis';
import { logger } from './logger';

let redisClient: ReturnType<typeof createClient> | null = null;
let initialized = false;

/**
 * Initialize Redis client. Call during server startup.
 */
export async function initRedisClient(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
    redisClient = createClient({ url: redisUrl });

    redisClient.on('error', (err) => {
      logger.error('[Redis] Client error:', err);
    });

    await redisClient.connect();
    logger.info('[Redis] Client initialized');
  } catch (error: any) {
    logger.warn('[Redis] Connection failed, rate limiting will be bypassed:', error.message);
    redisClient = null;
  }
}

/**
 * Get the Redis client instance (synchronous).
 * Returns the client or throws if not connected (caught by rate-limit middleware).
 */
export function getRedisClient(): ReturnType<typeof createClient> {
  if (!redisClient) {
    throw new Error('Redis client not initialized');
  }
  return redisClient;
}
