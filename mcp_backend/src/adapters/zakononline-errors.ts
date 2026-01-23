/**
 * Custom error classes for Zakononline API
 *
 * These errors provide better context for debugging and error handling
 * compared to generic Error objects.
 */

export class ZakonOnlineAPIError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public endpoint: string,
    public params: any,
    public response?: any
  ) {
    super(message);
    this.name = 'ZakonOnlineAPIError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ZakonOnlineRateLimitError extends ZakonOnlineAPIError {
  constructor(
    endpoint: string,
    public retryAfter: number,
    params: any = {}
  ) {
    super(
      `Rate limit exceeded. Retry after ${retryAfter}ms`,
      429,
      endpoint,
      params
    );
    this.name = 'ZakonOnlineRateLimitError';
  }
}

export class ZakonOnlineAuthError extends ZakonOnlineAPIError {
  constructor(
    endpoint: string,
    statusCode: number = 401,
    message?: string,
    params: any = {}
  ) {
    super(
      message || 'Authentication failed. Check API token (X-App-Token header).',
      statusCode,
      endpoint,
      params
    );
    this.name = 'ZakonOnlineAuthError';
  }
}

export class ZakonOnlineNotFoundError extends ZakonOnlineAPIError {
  constructor(endpoint: string, resourceId?: string, params: any = {}) {
    super(
      resourceId
        ? `Resource not found: ${resourceId}`
        : 'Resource not found',
      404,
      endpoint,
      params
    );
    this.name = 'ZakonOnlineNotFoundError';
  }
}

export class ZakonOnlineServerError extends ZakonOnlineAPIError {
  constructor(
    endpoint: string,
    statusCode: number,
    response?: any,
    params: any = {}
  ) {
    super(
      `Server error (${statusCode}). This may indicate invalid query parameters or internal API issues.`,
      statusCode,
      endpoint,
      params,
      response
    );
    this.name = 'ZakonOnlineServerError';
  }
}

export class ZakonOnlineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZakonOnlineValidationError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Create appropriate error based on HTTP status code
 */
export function createZakonOnlineError(
  error: any,
  endpoint: string,
  params: any
): ZakonOnlineAPIError {
  const status = error.response?.status;
  const response = error.response?.data;

  if (status === 429) {
    const retryAfter = error.response?.headers?.['retry-after']
      ? parseInt(error.response.headers['retry-after']) * 1000
      : 1000;
    return new ZakonOnlineRateLimitError(endpoint, retryAfter, params);
  }

  if (status === 401 || status === 403) {
    return new ZakonOnlineAuthError(endpoint, status, error.message, params);
  }

  if (status === 404) {
    return new ZakonOnlineNotFoundError(endpoint, undefined, params);
  }

  if (status >= 500) {
    return new ZakonOnlineServerError(endpoint, status, response, params);
  }

  return new ZakonOnlineAPIError(
    error.message || 'Unknown API error',
    status || 0,
    endpoint,
    params,
    response
  );
}
