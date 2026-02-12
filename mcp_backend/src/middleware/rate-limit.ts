import { Request, Response, NextFunction } from 'express';
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

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const redis = await getRedisClient();
      if (!redis) {
        return next(); // Redis unavailable, skip rate limiting
      }
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

        return res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Maximum ' + maxRequests + ' requests per ' + (windowMs / 1000) + ' seconds',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil(windowMs / 1000),
        });
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

// Chat endpoint rate limiter (max 10 requests per minute)
export const chatRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'ratelimit:chat',
});

// Auth endpoint rate limiter (max 10 requests per 15 minutes)
export const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'ratelimit:auth',
});

// Strict rate limiter for password reset (max 3 requests per hour)
export const passwordResetRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 3,
  keyPrefix: 'ratelimit:password-reset',
});
