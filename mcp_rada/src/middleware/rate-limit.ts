import { getRedisClient } from '../utils/redis-client.js';
import { logger } from '../utils/logger.js';

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
  skipSuccessfulRequests?: boolean;
}

export function createRateLimiter(options: RateLimitOptions) {
  const {
    windowMs,
    maxRequests,
    keyPrefix = 'ratelimit',
  } = options;

  return async (req: any, res: any, next: any): Promise<void> => {
    try {
      const redis = getRedisClient();
      const identifier = req.ip || req.socket.remoteAddress || 'unknown';
      const key = keyPrefix + ':' + identifier;

      const current = await redis.get(key);
      const currentCount = current ? parseInt(current, 10) : 0;

      if (currentCount >= maxRequests) {
        logger.warn('[RateLimit] Limit exceeded', {
          identifier,
          current: currentCount,
          max: maxRequests,
          path: req.path,
        });

        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Maximum ' + maxRequests + ' requests per ' + (windowMs / 1000) + ' seconds',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil(windowMs / 1000),
        });
        return;
      }

      const multi = redis.multi();
      multi.incr(key);

      if (currentCount === 0) {
        multi.expire(key, Math.ceil(windowMs / 1000));
      }

      await multi.exec();

      res.setHeader('X-RateLimit-Limit', maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', (maxRequests - currentCount - 1).toString());
      res.setHeader('X-RateLimit-Reset', (Date.now() + windowMs).toString());

      next();
    } catch (error) {
      logger.error('[RateLimit] Redis error, allowing request', {
        error: (error as Error).message,
        path: req.path,
      });
      next();
    }
  };
}

export const mcpDiscoveryRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyPrefix: 'ratelimit:mcp-discovery',
});

export const healthCheckRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: 'ratelimit:health',
});

export const webhookRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'ratelimit:webhook',
});
