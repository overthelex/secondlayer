/**
 * Tests for ZOAdapter Error Handling
 *
 * Tests custom error classes and error scenarios:
 * - ZakonOnlineAPIError
 * - ZakonOnlineRateLimitError
 * - ZakonOnlineAuthError
 * - ZakonOnlineServerError
 * - ZakonOnlineNotFoundError
 * - ZakonOnlineValidationError
 */

import {
  ZakonOnlineAPIError,
  ZakonOnlineRateLimitError,
  ZakonOnlineAuthError,
  ZakonOnlineServerError,
  ZakonOnlineNotFoundError,
  ZakonOnlineValidationError,
  createZakonOnlineError,
} from '../zakononline-errors.js';

describe('Zakononline Error Classes', () => {
  describe('ZakonOnlineAPIError', () => {
    test('should create error with all properties', () => {
      const error = new ZakonOnlineAPIError(
        'Test error',
        500,
        '/v1/search',
        { query: 'test' },
        { error: 'Server error' }
      );

      expect(error.message).toBe('Test error');
      expect(error.statusCode).toBe(500);
      expect(error.endpoint).toBe('/v1/search');
      expect(error.params).toEqual({ query: 'test' });
      expect(error.response).toEqual({ error: 'Server error' });
      expect(error.name).toBe('ZakonOnlineAPIError');
    });

    test('should be instance of Error', () => {
      const error = new ZakonOnlineAPIError('Test', 500, '/test', {});
      expect(error).toBeInstanceOf(Error);
    });

    test('should have stack trace', () => {
      const error = new ZakonOnlineAPIError('Test', 500, '/test', {});
      expect(error.stack).toBeDefined();
    });
  });

  describe('ZakonOnlineRateLimitError', () => {
    test('should create rate limit error with retryAfter', () => {
      const error = new ZakonOnlineRateLimitError('/v1/search', 5000);

      expect(error.statusCode).toBe(429);
      expect(error.retryAfter).toBe(5000);
      expect(error.message).toContain('Rate limit exceeded');
      expect(error.message).toContain('5000ms');
      expect(error.name).toBe('ZakonOnlineRateLimitError');
    });

    test('should extend ZakonOnlineAPIError', () => {
      const error = new ZakonOnlineRateLimitError('/v1/search', 1000);
      expect(error).toBeInstanceOf(ZakonOnlineAPIError);
    });
  });

  describe('ZakonOnlineAuthError', () => {
    test('should create auth error with default message', () => {
      const error = new ZakonOnlineAuthError('/v1/search');

      expect(error.statusCode).toBe(401);
      expect(error.message).toContain('Authentication failed');
      expect(error.message).toContain('X-App-Token');
      expect(error.name).toBe('ZakonOnlineAuthError');
    });

    test('should accept custom message', () => {
      const error = new ZakonOnlineAuthError('/v1/search', 401, 'Invalid token');

      expect(error.message).toBe('Invalid token');
      expect(error.statusCode).toBe(401);
    });

    test('should extend ZakonOnlineAPIError', () => {
      const error = new ZakonOnlineAuthError('/v1/search');
      expect(error).toBeInstanceOf(ZakonOnlineAPIError);
    });
  });

  describe('ZakonOnlineNotFoundError', () => {
    test('should create not found error without resource ID', () => {
      const error = new ZakonOnlineNotFoundError('/v1/search');

      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Resource not found');
      expect(error.name).toBe('ZakonOnlineNotFoundError');
    });

    test('should create not found error with resource ID', () => {
      const error = new ZakonOnlineNotFoundError('/v1/search', '12345');

      expect(error.message).toContain('12345');
      expect(error.message).toContain('Resource not found');
    });

    test('should extend ZakonOnlineAPIError', () => {
      const error = new ZakonOnlineNotFoundError('/v1/search');
      expect(error).toBeInstanceOf(ZakonOnlineAPIError);
    });
  });

  describe('ZakonOnlineServerError', () => {
    test('should create server error with status code', () => {
      const error = new ZakonOnlineServerError('/v1/search', 500);

      expect(error.statusCode).toBe(500);
      expect(error.message).toContain('Server error');
      expect(error.message).toContain('500');
      expect(error.name).toBe('ZakonOnlineServerError');
    });

    test('should include response data', () => {
      const responseData = { error: 'Internal error', code: 'ERR_500' };
      const error = new ZakonOnlineServerError('/v1/search', 500, responseData);

      expect(error.response).toEqual(responseData);
    });

    test('should work with different 5xx codes', () => {
      const error502 = new ZakonOnlineServerError('/v1/search', 502);
      const error503 = new ZakonOnlineServerError('/v1/search', 503);

      expect(error502.statusCode).toBe(502);
      expect(error503.statusCode).toBe(503);
    });

    test('should extend ZakonOnlineAPIError', () => {
      const error = new ZakonOnlineServerError('/v1/search', 500);
      expect(error).toBeInstanceOf(ZakonOnlineAPIError);
    });
  });

  describe('ZakonOnlineValidationError', () => {
    test('should create validation error', () => {
      const error = new ZakonOnlineValidationError('Invalid target');

      expect(error.message).toBe('Invalid target');
      expect(error.name).toBe('ZakonOnlineValidationError');
    });

    test('should be instance of Error but NOT ZakonOnlineAPIError', () => {
      const error = new ZakonOnlineValidationError('Invalid');

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ZakonOnlineAPIError);
    });
  });

  describe('createZakonOnlineError - Error Factory', () => {
    test('should create RateLimitError for 429 status', () => {
      const axiosError = {
        response: {
          status: 429,
          headers: { 'retry-after': '60' },
        },
        message: 'Rate limited',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', {});

      expect(error).toBeInstanceOf(ZakonOnlineRateLimitError);
      expect((error as ZakonOnlineRateLimitError).retryAfter).toBe(60000); // 60 seconds in ms
    });

    test('should create RateLimitError with default retryAfter if header missing', () => {
      const axiosError = {
        response: {
          status: 429,
          headers: {},
        },
        message: 'Rate limited',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', {});

      expect(error).toBeInstanceOf(ZakonOnlineRateLimitError);
      expect((error as ZakonOnlineRateLimitError).retryAfter).toBe(1000);
    });

    test('should create AuthError for 401 status', () => {
      const axiosError = {
        response: {
          status: 401,
        },
        message: 'Unauthorized',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', {});

      expect(error).toBeInstanceOf(ZakonOnlineAuthError);
      expect(error.statusCode).toBe(401);
    });

    test('should create AuthError for 403 status', () => {
      const axiosError = {
        response: {
          status: 403,
        },
        message: 'Forbidden',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', {});

      expect(error).toBeInstanceOf(ZakonOnlineAuthError);
      expect(error.statusCode).toBe(403);
    });

    test('should create NotFoundError for 404 status', () => {
      const axiosError = {
        response: {
          status: 404,
        },
        message: 'Not found',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', {});

      expect(error).toBeInstanceOf(ZakonOnlineNotFoundError);
      expect(error.statusCode).toBe(404);
    });

    test('should create ServerError for 500 status', () => {
      const axiosError = {
        response: {
          status: 500,
          data: { error: 'Internal error' },
        },
        message: 'Server error',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', {});

      expect(error).toBeInstanceOf(ZakonOnlineServerError);
      expect(error.statusCode).toBe(500);
      expect(error.response).toEqual({ error: 'Internal error' });
    });

    test('should create ServerError for 502 status', () => {
      const axiosError = {
        response: {
          status: 502,
        },
        message: 'Bad gateway',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', {});

      expect(error).toBeInstanceOf(ZakonOnlineServerError);
      expect(error.statusCode).toBe(502);
    });

    test('should create generic APIError for unknown status', () => {
      const axiosError = {
        response: {
          status: 418, // I'm a teapot
          data: { joke: 'true' },
        },
        message: 'Teapot',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', {});

      expect(error).toBeInstanceOf(ZakonOnlineAPIError);
      expect(error.statusCode).toBe(418);
      expect(error.message).toBe('Teapot');
    });

    test('should handle error without response', () => {
      const axiosError = {
        message: 'Network error',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', {});

      expect(error).toBeInstanceOf(ZakonOnlineAPIError);
      expect(error.statusCode).toBe(0);
      expect(error.message).toBe('Network error');
    });

    test('should preserve params in created error', () => {
      const params = { query: 'test', limit: 10 };
      const axiosError = {
        response: { status: 500 },
        message: 'Error',
      };

      const error = createZakonOnlineError(axiosError, '/v1/search', params);

      expect(error.params).toEqual(params);
    });
  });

  describe('Error Message Quality', () => {
    test('RateLimitError should have actionable message', () => {
      const error = new ZakonOnlineRateLimitError('/v1/search', 5000);
      expect(error.message).toContain('Retry after');
      expect(error.message).toContain('5000ms');
    });

    test('AuthError should mention API token', () => {
      const error = new ZakonOnlineAuthError('/v1/search');
      expect(error.message.toLowerCase()).toContain('token');
    });

    test('ServerError should indicate server-side issue', () => {
      const error = new ZakonOnlineServerError('/v1/search', 500);
      expect(error.message.toLowerCase()).toContain('server');
    });

    test('ServerError should mention possible causes', () => {
      const error = new ZakonOnlineServerError('/v1/search', 500);
      expect(error.message).toContain('invalid query parameters');
      expect(error.message).toContain('internal API issues');
    });
  });

  describe('Error Inheritance Chain', () => {
    test('all API errors should extend Error', () => {
      const errors = [
        new ZakonOnlineAPIError('test', 500, '/test', {}),
        new ZakonOnlineRateLimitError('/test', 1000),
        new ZakonOnlineAuthError('/test'),
        new ZakonOnlineServerError('/test', 500),
        new ZakonOnlineNotFoundError('/test'),
        new ZakonOnlineValidationError('test'),
      ];

      errors.forEach(error => {
        expect(error).toBeInstanceOf(Error);
      });
    });

    test('specific errors should extend ZakonOnlineAPIError (except ValidationError)', () => {
      const apiErrors = [
        new ZakonOnlineRateLimitError('/test', 1000),
        new ZakonOnlineAuthError('/test'),
        new ZakonOnlineServerError('/test', 500),
        new ZakonOnlineNotFoundError('/test'),
      ];

      apiErrors.forEach(error => {
        expect(error).toBeInstanceOf(ZakonOnlineAPIError);
      });
    });

    test('ValidationError should NOT extend ZakonOnlineAPIError', () => {
      const error = new ZakonOnlineValidationError('test');
      expect(error).not.toBeInstanceOf(ZakonOnlineAPIError);
    });
  });
});
