/**
 * Dual Authentication Middleware
 * Supports both JWT tokens (for users) and API keys (for MCP clients)
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Database } from '../database/database.js';
import { UserService, User } from '../services/user-service.js';
import { ApiKeyService } from '../services/api-key-service.js';
import { logger } from '../utils/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

// Read API keys dynamically to support runtime updates
function getSecondaryLayerKeys(): string[] {
  const keys = process.env.SECONDARY_LAYER_KEYS?.split(',').map(k => k.trim()).filter(k => k.length > 0) || [];
  if (keys.length === 0) {
    logger.warn('No SECONDARY_LAYER_KEYS configured');
  }
  return keys;
}

export interface AuthenticatedRequest extends Request {
  user?: User;
  clientKey?: string;
  authType?: 'jwt' | 'apikey';
}

let userService: UserService;
let apiKeyService: ApiKeyService;

/**
 * Initialize dual auth middleware with database instance
 */
export function initializeDualAuth(db: Database, apiKeySvc: ApiKeyService) {
  userService = new UserService(db);
  apiKeyService = apiKeySvc;
  logger.info('Dual auth middleware initialized');
}

/**
 * Get the initialized UserService instance
 * Use this in controllers that need to interact with users
 */
export function getUserService(): UserService {
  if (!userService) {
    throw new Error('UserService not initialized. Call initializeDualAuth first.');
  }
  return userService;
}

/**
 * Authenticate with JWT token
 */
async function authenticateWithJWT(req: AuthenticatedRequest, token: string): Promise<void> {
  try {
    // Verify JWT signature and expiry
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // Fetch user from database
    if (!userService) {
      throw new Error('UserService not initialized');
    }

    const user = await userService.findById(decoded.userId);

    if (!user) {
      throw new Error('User not found');
    }

    // Attach user to request
    req.user = user;
    req.authType = 'jwt';

    logger.debug('JWT authentication successful', {
      userId: user.id,
      email: user.email,
    });
  } catch (error: any) {
    if (error.name === 'JsonWebTokenError') {
      throw new Error('Invalid token');
    }
    if (error.name === 'TokenExpiredError') {
      throw new Error('Token expired');
    }
    throw error;
  }
}

/**
 * Authenticate with API key
 * Supports both Phase 2 billing API keys (from database) and legacy env-based keys
 */
async function authenticateWithAPIKey(req: AuthenticatedRequest, apiKey: string): Promise<void> {
  // First try to validate as Phase 2 billing API key from database
  if (apiKeyService) {
    try {
      logger.debug('Attempting Phase 2 API key validation', {
        keyPrefix: apiKey.substring(0, 12) + '...',
      });
      const keyInfo = await apiKeyService.validateApiKey(apiKey);

      logger.debug('Phase 2 API key validation result', {
        keyPrefix: apiKey.substring(0, 12) + '...',
        found: keyInfo !== null,
        userId: keyInfo?.userId,
      });

      if (keyInfo) {
        // Phase 2 API key found - load user from database
        if (!userService) {
          throw new Error('UserService not initialized');
        }

        const user = await userService.findById(keyInfo.userId);

        if (!user) {
          logger.error('User not found for valid API key', {
            userId: keyInfo.userId,
            keyId: keyInfo.id,
          });
          throw new Error('User not found');
        }

        // Attach user and API key to request
        req.user = user;
        req.clientKey = apiKey;
        req.authType = 'apikey';

        logger.debug('Phase 2 API key authentication successful', {
          userId: user.id,
          email: user.email,
          keyId: keyInfo.id,
          keyName: keyInfo.name,
        });

        return;
      }
    } catch (error: any) {
      logger.error('Error validating Phase 2 API key', {
        error: error.message,
        keyPrefix: apiKey.substring(0, 12) + '...',
      });
      // Continue to check legacy keys
    }
  }

  // Fall back to legacy env-based API keys
  const validKeys = getSecondaryLayerKeys();

  if (!validKeys.includes(apiKey)) {
    logger.warn('Invalid API key attempt (not found in Phase 2 or legacy keys)', {
      keyPrefix: apiKey.substring(0, 8) + '...',
      validKeysCount: validKeys.length,
    });
    throw new Error('Invalid API key');
  }

  // Legacy key validated - attach to request but no user
  req.clientKey = apiKey;
  req.authType = 'apikey';

  logger.debug('Legacy API key authentication successful', {
    keyPrefix: apiKey.substring(0, 8) + '...',
  });
}

/**
 * Dual authentication middleware
 * Accepts either JWT tokens or API keys
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
        message: 'Missing Authorization header. Use: Authorization: Bearer <token>',
      });
      return;
    }

    const token = authHeader.replace('Bearer ', '');

    // Detect token type based on format
    // JWT tokens contain dots (header.payload.signature)
    // API keys are plain strings
    if (token.includes('.')) {
      // JWT authentication
      await authenticateWithJWT(req, token);
    } else {
      // API key authentication
      await authenticateWithAPIKey(req, token);
    }

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
 * Require JWT authentication only (no API keys)
 * Use this for admin panel routes that require user login
 */
export async function requireJWT(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User authentication required',
      });
      return;
    }

    const token = authHeader.replace('Bearer ', '');

    // Check if token is JWT (contains dots)
    if (!token.includes('.')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User authentication required. API keys are not accepted for this endpoint.',
      });
      return;
    }

    // Authenticate with JWT
    await authenticateWithJWT(req, token);
    next();
  } catch (error: any) {
    logger.warn('JWT authentication failed', {
      error: error.message,
      path: req.path,
      ip: req.ip,
    });

    res.status(401).json({
      error: 'Unauthorized',
      message: error.message || 'JWT authentication failed',
    });
  }
}

/**
 * Optional JWT middleware
 * Parses JWT if present and attaches user to request, but does NOT reject if missing.
 * Use for routes that are public but need user context when authenticated (e.g. /auth).
 */
export async function optionalJWT(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      if (token.includes('.')) {
        await authenticateWithJWT(req, token);
      }
    }
  } catch (error: any) {
    // Silently ignore auth errors — request continues unauthenticated
    logger.debug('Optional JWT parsing failed', { error: error.message, path: req.path });
  }

  next();
}

/**
 * Require API key authentication only (no JWTs)
 * Use this for MCP tool endpoints that require client API keys
 */
export async function requireAPIKey(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
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

    // Check if token is API key (no dots)
    if (token.includes('.')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'API key required. JWT tokens are not accepted for this endpoint.',
      });
      return;
    }

    // Authenticate with API key
    await authenticateWithAPIKey(req, token);
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
