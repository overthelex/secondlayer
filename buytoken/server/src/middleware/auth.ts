/**
 * Authentication Middleware
 * Validates JWT tokens and API keys
 */

import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { pool } from '../config/database.js';
import {
  AuthenticatedRequest,
  JWTPayload,
  User,
  UnauthorizedError,
  ForbiddenError,
} from '../types/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

/**
 * Middleware to require authentication (JWT or API key)
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('No authentication token provided');
    }

    const token = authHeader.replace('Bearer ', '');

    // Check if it's an API key (starts with sk_live_ or sk_test_)
    if (token.startsWith('sk_live_') || token.startsWith('sk_test_')) {
      await authenticateWithAPIKey(req, token);
    } else {
      // JWT authentication
      await authenticateWithJWT(req, token);
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Authenticate using JWT token
 */
async function authenticateWithJWT(req: AuthenticatedRequest, token: string) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;

    // Fetch user from database
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      throw new UnauthorizedError('User not found');
    }

    req.user = result.rows[0] as User;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new UnauthorizedError('Invalid token');
    }
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Token expired');
    }
    throw error;
  }
}

/**
 * Authenticate using API key
 */
async function authenticateWithAPIKey(req: AuthenticatedRequest, apiKey: string) {
  // Extract prefix (first 12 chars, e.g., "sk_live_abcd")
  const prefix = apiKey.substring(0, 12);

  // Find all active API keys with this prefix
  const result = await pool.query(
    `SELECT ak.*, u.*
     FROM api_keys ak
     JOIN users u ON ak.user_id = u.id
     WHERE ak.key_prefix = $1 AND ak.revoked_at IS NULL`,
    [prefix]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid API key');
  }

  // Check if any of the keys match (there should only be one, but handle collisions)
  let matchedUser: User | null = null;

  for (const row of result.rows) {
    const isValid = await bcrypt.compare(apiKey, row.key_hash);
    if (isValid) {
      matchedUser = {
        id: row.user_id,
        email: row.email,
        name: row.name,
        password_hash: row.password_hash,
        google_id: row.google_id,
        role: row.role,
        email_verified: row.email_verified,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };

      // Update last_used_at timestamp
      await pool.query(
        'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
        [row.id]
      );

      break;
    }
  }

  if (!matchedUser) {
    throw new UnauthorizedError('Invalid API key');
  }

  req.user = matchedUser;
}

/**
 * Middleware to require admin role
 */
export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.user) {
    return next(new UnauthorizedError('Authentication required'));
  }

  if (req.user.role !== 'admin') {
    return next(new ForbiddenError('Admin access required'));
  }

  next();
}

/**
 * Middleware to check if user has an active subscription
 */
export async function requireActiveSubscription(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    const result = await pool.query(
      `SELECT * FROM subscriptions
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return next(new ForbiddenError('Active subscription required'));
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware to check if user has sufficient token balance
 */
export async function requireTokenBalance(minimumTokens: number = 1) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return next(new UnauthorizedError('Authentication required'));
      }

      const result = await pool.query(
        'SELECT balance FROM user_token_balance WHERE user_id = $1',
        [req.user.id]
      );

      if (result.rows.length === 0 || result.rows[0].balance < minimumTokens) {
        return next(new ForbiddenError('Insufficient token balance'));
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Generate JWT token for user
 */
export function generateToken(user: User): string {
  const payload: JWTPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as string,
  } as any);
}

/**
 * Generate API key
 * Returns: { apiKey: string, keyHash: string, keyPrefix: string }
 */
export async function generateAPIKey(): Promise<{
  apiKey: string;
  keyHash: string;
  keyPrefix: string;
}> {
  // Generate random key: sk_live_<32 random chars>
  const randomPart = Array.from({ length: 32 }, () =>
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[
      Math.floor(Math.random() * 62)
    ]
  ).join('');

  const apiKey = `sk_live_${randomPart}`;
  const keyPrefix = apiKey.substring(0, 12); // "sk_live_abcd"
  const keyHash = await bcrypt.hash(apiKey, 10);

  return { apiKey, keyHash, keyPrefix };
}
