import { Response, NextFunction } from 'express';
import { getRedisClient } from '../utils/redis-client.js';
import { logger } from '../utils/logger.js';
import { AuthenticatedRequest as DualAuthRequest } from './dual-auth.js';

interface UserRateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

function createUserRateLimiter(options: UserRateLimitOptions) {
  const { windowMs, maxRequests, keyPrefix } = options;

  return async (req: DualAuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return next(); // Let auth middleware handle unauthenticated requests
      }

      const redis = await getRedisClient();
      if (!redis) {
        return next(); // Redis unavailable, skip rate limiting
      }

      const key = `${keyPrefix}:${userId}`;
      const current = await redis.get(key);
      const currentCount = current ? parseInt(current, 10) : 0;

      if (currentCount >= maxRequests) {
        const retryAfter = Math.ceil(windowMs / 1000);
        logger.warn('[UploadRateLimit] User rate limit exceeded', {
          userId,
          prefix: keyPrefix,
          current: currentCount,
          max: maxRequests,
        });

        res.setHeader('Retry-After', retryAfter.toString());
        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Upload rate limit exceeded. Maximum ${maxRequests} requests per ${retryAfter} seconds`,
          code: 'UPLOAD_RATE_LIMIT_EXCEEDED',
          retryAfter,
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

      next();
    } catch (error) {
      logger.error('[UploadRateLimit] Redis error, allowing request', {
        error: (error as Error).message,
      });
      next();
    }
  };
}

// 200 init requests per minute per user (generous — session quota is the real abuse protection)
export const uploadInitRateLimit = createUserRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 200,
  keyPrefix: 'ratelimit:upload-init',
});

// 5 batch-init requests per minute per user (each batch handles up to 500 files)
// Session quota (MAX_USER_SESSIONS) provides the real abuse protection
export const uploadBatchInitRateLimit = createUserRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 5,
  keyPrefix: 'ratelimit:upload-init-batch',
});

// 200 chunk uploads per minute per user
export const uploadChunkRateLimit = createUserRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 200,
  keyPrefix: 'ratelimit:upload-chunk',
});
