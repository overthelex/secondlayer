import { Request, Response, NextFunction } from 'express';
import { createRateLimiter, setRateLimitCache } from '../rate-limit.js';

jest.mock('../../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function createMockReq(ip = '192.168.1.1', path = '/api/test'): Request {
  return {
    ip,
    path,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function createMockRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  return res as Response;
}

describe('createRateLimiter', () => {
  const next: NextFunction = jest.fn();
  let mockCache: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      increment: jest.fn().mockResolvedValue(1),
      ping: jest.fn().mockResolvedValue('PONG'),
      setex: jest.fn().mockResolvedValue('OK'),
      exists: jest.fn().mockResolvedValue(false),
      keys: jest.fn().mockResolvedValue([]),
    };
    setRateLimitCache(mockCache);
  });

  test('should allow request when under limit', async () => {
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
    const req = createMockReq();
    const res = createMockRes();

    await limiter(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '9');
  });

  test('should return 429 when rate limit exceeded', async () => {
    mockCache.increment.mockResolvedValue(11);
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
    const req = createMockReq();
    const res = createMockRes();

    await limiter(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('should skip rate limiting for localhost', async () => {
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
    const req = createMockReq('127.0.0.1');
    const res = createMockRes();

    await limiter(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockCache.increment).not.toHaveBeenCalled();
  });

  test('should skip rate limiting for IPv6 localhost', async () => {
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
    const req = createMockReq('::1');
    const res = createMockRes();

    await limiter(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockCache.increment).not.toHaveBeenCalled();
  });

  test('should skip rate limiting for IPv4-mapped IPv6 localhost', async () => {
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
    const req = createMockReq('::ffff:127.0.0.1');
    const res = createMockRes();

    await limiter(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('should use custom key prefix', async () => {
    const limiter = createRateLimiter({
      windowMs: 60000,
      maxRequests: 10,
      keyPrefix: 'custom-prefix',
    });
    const req = createMockReq();
    const res = createMockRes();

    await limiter(req, res, next);

    expect(mockCache.increment).toHaveBeenCalledWith('custom-prefix:192.168.1.1', expect.any(Number));
  });

  test('should use userId when keyByUserId is true', async () => {
    const limiter = createRateLimiter({
      windowMs: 60000,
      maxRequests: 10,
      keyByUserId: true,
    });
    const req = createMockReq() as any;
    req.user = { id: 'user-456' };
    const res = createMockRes();

    await limiter(req, res, next);

    expect(mockCache.increment).toHaveBeenCalledWith('ratelimit:user:user-456', expect.any(Number));
  });

  test('should fall back to IP when keyByUserId is true but no user', async () => {
    const limiter = createRateLimiter({
      windowMs: 60000,
      maxRequests: 10,
      keyByUserId: true,
    });
    const req = createMockReq();
    const res = createMockRes();

    await limiter(req, res, next);

    expect(mockCache.increment).toHaveBeenCalledWith('ratelimit:192.168.1.1', expect.any(Number));
  });

  test('should allow request when cache is unavailable', async () => {
    setRateLimitCache(null as any);
    // Need to re-create limiter after cache reset
    // But setRateLimitCache sets module-level var, so just test with null
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
    const req = createMockReq();
    const res = createMockRes();

    // Temporarily set rateCache to null
    setRateLimitCache(null as any);

    await limiter(req, res, next);

    expect(next).toHaveBeenCalled();

    // Restore cache for other tests
    setRateLimitCache(mockCache);
  });

  test('should allow request on cache error (fail open)', async () => {
    mockCache.increment.mockRejectedValue(new Error('Redis connection lost'));
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
    const req = createMockReq();
    const res = createMockRes();

    await limiter(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('should set correct remaining count', async () => {
    mockCache.increment.mockResolvedValue(8);
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
    const req = createMockReq();
    const res = createMockRes();

    await limiter(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '2');
  });

  test('should increment cache counter with correct TTL', async () => {
    const limiter = createRateLimiter({ windowMs: 120000, maxRequests: 10 });
    const req = createMockReq();
    const res = createMockRes();

    await limiter(req, res, next);

    expect(mockCache.increment).toHaveBeenCalledWith('ratelimit:192.168.1.1', 120);
  });
});
