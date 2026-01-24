/**
 * Dual Authentication Middleware
 * Supports both JWT tokens (for users) and API keys (for MCP clients)
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Database } from '../database/database.js';
import { UserService, User } from '../services/user-service.js';
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

/**
 * Initialize dual auth middleware with database instance
 */
export function initializeDualAuth(db: Database) {
  userService = new UserService(db);
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
 */
function authenticateWithAPIKey(req: AuthenticatedRequest, apiKey: string): void {
  // Get current API keys from environment
  const validKeys = getSecondaryLayerKeys();
  
  // Check if API key is valid
  if (!validKeys.includes(apiKey)) {
    logger.warn('Invalid API key attempt', {
      keyPrefix: apiKey.substring(0, 8) + '...',
      validKeysCount: validKeys.length,
    });
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
      authenticateWithAPIKey(req, token);
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
 * Require API key authentication only (no JWTs)
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

    // Check if token is API key (no dots)
    if (token.includes('.')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'API key required. JWT tokens are not accepted for this endpoint.',
      });
      return;
    }

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
