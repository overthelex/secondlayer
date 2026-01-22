/**
 * Dual Authentication Middleware
 * Supports API keys for MCP clients (JWT support can be added later)
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

const RADA_API_KEYS = process.env.RADA_API_KEYS?.split(',') || [];

export interface AuthenticatedRequest extends Request {
  clientKey?: string;
  authType?: 'apikey';
}

/**
 * Authenticate with API key
 */
function authenticateWithAPIKey(req: AuthenticatedRequest, apiKey: string): void {
  // Check if API key is valid
  if (!RADA_API_KEYS.includes(apiKey)) {
    throw new Error('Invalid API key');
  }

  // Attach API key to request
  req.clientKey = apiKey;
  req.authType = 'apikey';

  logger.debug('API key authentication successful', {
    keyPrefix: apiKey.substring(0, 8) + '...',
  });
}

/**
 * Dual authentication middleware
 * Currently supports API keys only (JWT support can be added later)
 */
export async function dualAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing Authorization header. Use: Authorization: Bearer <api-key>',
      });
      return;
    }

    const token = authHeader.replace('Bearer ', '');

    // Authenticate with API key
    authenticateWithAPIKey(req, token);

    next();
  } catch (error: any) {
    logger.warn('Authentication failed', {
      error: error.message,
      path: req.path,
      ip: req.ip,
    });

    res.status(401).json({
      error: 'Unauthorized',
      message: error.message || 'Authentication failed',
    });
  }
}

/**
 * Require API key authentication
 * Use this for MCP tool endpoints that require client API keys
 */
export function requireAPIKey(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'API key required',
      });
      return;
    }

    const token = authHeader.replace('Bearer ', '');

    // Authenticate with API key
    authenticateWithAPIKey(req, token);
    next();
  } catch (error: any) {
    logger.warn('API key authentication failed', {
      error: error.message,
      path: req.path,
      ip: req.ip,
    });

    res.status(401).json({
      error: 'Unauthorized',
      message: error.message || 'API key authentication failed',
    });
  }
}
