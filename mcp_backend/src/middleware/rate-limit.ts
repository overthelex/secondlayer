import { Request, Response, NextFunction } from 'express';
import type { ICachePort } from '../domain/ports/index.js';
import { logger } from '../utils/logger.js';

let rateCache: ICachePort | null = null;

/** Set the cache port for rate limiting. Call from composition root. */
export function setRateLimitCache(cache: ICachePort): void {
  rateCache = cache;
}

// In-memory fallback when Redis is unavailable
const memoryStore = new Map<string, { count: number; expiresAt: number }>();
const MEMORY_CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

function memoryIncrement(key: string, windowMs: number): number {
  // Periodic cleanup of expired entries
  if (Date.now() - lastCleanup > MEMORY_CLEANUP_INTERVAL) {
    const now = Date.now();
    for (const [k, v] of memoryStore) {
      if (v.expiresAt <= now) memoryStore.delete(k);
    }
    lastCleanup = now;
  }

  const existing = memoryStore.get(key);
  const now = Date.now();
  if (existing && existing.expiresAt > now) {
    existing.count++;
    return existing.count;
  }
  memoryStore.set(key, { count: 1, expiresAt: now + windowMs });
  return 1;
}

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
  skipSuccessfulRequests?: boolean;
  /** Use authenticated user ID instead of IP for rate limiting (requires JWT auth before this middleware) */
  keyByUserId?: boolean;
}

export function createRateLimiter(options: RateLimitOptions) {
  const {
    windowMs,
    maxRequests,
    keyPrefix = 'ratelimit',
  } = options;

  const checkLimit = async (req: Request, res: Response, next: NextFunction, useMemory: boolean) => {
    const identifier = options.keyByUserId && (req as any).user?.id
      ? `user:${(req as any).user.id}`
      : req.ip || req.socket.remoteAddress || 'unknown';

    // Skip rate limiting for internal/localhost traffic (Prometheus, health monitors)
    if (identifier === '127.0.0.1' || identifier === '::1' || identifier === '::ffff:127.0.0.1') {
      return next();
    }

    const key = keyPrefix + ':' + identifier;
    let currentCount: number;

    if (useMemory) {
      currentCount = memoryIncrement(key, windowMs);
    } else {
      // increment возвращает значение ПОСЛЕ инкремента, так что читать ключ
      // отдельно не нужно: лишний round trip плюс гонка между GET и INCR, в
      // которой параллельные запросы получали одно и то же число.
      currentCount = await rateCache!.increment(key, Math.ceil(windowMs / 1000));
    }

    if (currentCount > maxRequests) {
      logger.warn('[RateLimit] Limit exceeded', {
        identifier,
        current: currentCount,
        max: maxRequests,
        path: req.path,
        backend: useMemory ? 'memory' : 'redis',
      });

      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Maximum ' + maxRequests + ' requests per ' + (windowMs / 1000) + ' seconds',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    }

    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', (maxRequests - currentCount).toString());
    res.setHeader('X-RateLimit-Reset', (Date.now() + windowMs).toString());

    next();
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!rateCache) {
        // Redis unavailable — fall back to in-memory rate limiting
        return await checkLimit(req, res, next, true);
      }
      return await checkLimit(req, res, next, false);
    } catch (error) {
      logger.error('[RateLimit] Redis error, falling back to memory', {
        error: (error as Error).message,
        path: req.path,
      });
      // Fall back to in-memory instead of allowing unlimited requests
      try {
        return checkLimit(req, res, next, true);
      } catch (memError) {
        logger.error('[RateLimit] Memory fallback also failed', {
          error: (memError as Error).message,
        });
        return res.status(503).json({
          error: 'Service Unavailable',
          message: 'Rate limiting service temporarily unavailable',
        });
      }
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
  maxRequests: 300,
  keyPrefix: 'ratelimit:health',
});

export const webhookRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'ratelimit:webhook',
});

// Chat endpoint rate limiter — per authenticated user, not per IP
// (Cloudflare proxies all traffic through shared IPs)
export const chatRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 180,
  keyPrefix: 'ratelimit:chat',
  keyByUserId: true,
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

// Consultation rate limiter — keyed by userId to avoid Cloudflare shared IP issues.
// 600/min: handles multiple open tabs/consultations with polling + SSE reconnects.
export const consultationRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 600,
  keyPrefix: 'ratelimit:consultation',
  keyByUserId: true,
});

// Global API rate limiter — covers all /api/ routes as a baseline.
// Raised to 3000/min to handle 20+ concurrent users behind Cloudflare (shared IP).
export const globalApiRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 3000,
  keyPrefix: 'ratelimit:global-api',
});

export const publicSearchRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyPrefix: 'ratelimit:public-search',
});
