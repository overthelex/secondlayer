import { createClient } from 'redis';
import { logger } from './logger';

let redisClient: ReturnType<typeof createClient> | null = null;

/**
 * Получает singleton экземпляр Redis клиента.
 * Автоматически подключается при первом вызове.
 */
export async function getRedisClient(): Promise<ReturnType<typeof createClient> | null> {
  if (redisClient) {
    return redisClient;
  }

  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = createClient({ url: redisUrl });

    redisClient.on('error', (err) => {
      logger.error('[Redis] Client error:', err);
    });

    redisClient.on('connect', () => {
      logger.info('[Redis] Connected successfully');
    });

    redisClient.on('disconnect', () => {
      logger.warn('[Redis] Disconnected');
    });

    await redisClient.connect();
    logger.info('[Redis] Client initialized');

    return redisClient;
  } catch (error: any) {
    logger.warn('[Redis] Connection failed, continuing without cache:', error.message);
    redisClient = null;
    return null;
  }
}

/**
 * Закрывает соединение с Redis
 */
export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      logger.info('[Redis] Client disconnected');
    } catch (error: any) {
      logger.error('[Redis] Error during disconnect:', error.message);
    } finally {
      redisClient = null;
    }
  }
}

/**
 * Проверяет, подключен ли Redis клиент
 */
export function isRedisConnected(): boolean {
  return redisClient !== null && redisClient.isOpen;
}
