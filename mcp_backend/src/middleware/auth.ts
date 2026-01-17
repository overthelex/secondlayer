import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export interface AuthenticatedRequest extends Request {
  clientKey?: string;
}

/**
 * Middleware для аутентификации через SECONDARY_LAYER_KEY
 * Клиенты должны передавать токен в заголовке Authorization: Bearer <SECONDARY_LAYER_KEY>
 */
export function authenticateClient(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Unauthorized request - missing or invalid Authorization header', {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header. Use: Authorization: Bearer <SECONDARY_LAYER_KEY>',
    });
  }

  const clientKey = authHeader.substring(7); // Remove "Bearer " prefix
  const validKeys = process.env.SECONDARY_LAYER_KEYS?.split(',')
    .map(key => key.trim())
    .filter(key => key.length > 0) || [];

  if (validKeys.length === 0) {
    logger.error('SECONDARY_LAYER_KEYS not configured on server', {
      envValue: process.env.SECONDARY_LAYER_KEYS,
    });
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'Authentication keys not configured',
    });
  }

  if (!validKeys.includes(clientKey.trim())) {
    logger.warn('Unauthorized request - invalid client key', {
      ip: req.ip,
      path: req.path,
      keyPrefix: clientKey.substring(0, 8) + '...',
    });
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid SECONDARY_LAYER_KEY',
    });
  }

  // Attach client key to request for logging/analytics
  req.clientKey = clientKey;
  logger.info('Authenticated client request', {
    ip: req.ip,
    path: req.path,
    keyPrefix: clientKey.substring(0, 8) + '...',
  });

  return next();
}
