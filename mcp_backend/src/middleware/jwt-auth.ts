import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';

export interface JWTPayload {
  sub: string;  // Subject (user/client identifier)
  iat: number;  // Issued at
  exp: number;  // Expiration
}

export interface AuthenticatedRequest extends Request {
  jwt?: JWTPayload;
  clientId?: string;
}

/**
 * JWT Authentication Middleware for Remote MCP Server
 *
 * Validates JWT tokens in the Authorization header
 * Format: Authorization: Bearer <jwt_token>
 */
export function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Skip authentication for health check
  if (req.path === '/health') {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    logger.warn('Missing Authorization header', { path: req.path, ip: req.ip });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing Authorization header. Use: Authorization: Bearer <token>',
    });
    return;
  }

  // Extract token from "Bearer <token>" format
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    logger.warn('Invalid Authorization header format', { authHeader, ip: req.ip });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid Authorization header format. Use: Authorization: Bearer <token>',
    });
    return;
  }

  const token = parts[1];
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    logger.error('JWT_SECRET not configured in environment');
    res.status(500).json({
      error: 'Server configuration error',
      message: 'JWT authentication not properly configured',
    });
    return;
  }

  try {
    // Verify and decode JWT token
    const decoded = jwt.verify(token, jwtSecret) as JWTPayload;

    // Attach JWT payload to request
    req.jwt = decoded;
    req.clientId = decoded.sub;

    logger.info('JWT authentication successful', {
      clientId: decoded.sub,
      path: req.path,
    });

    next();
  } catch (error: any) {
    logger.warn('JWT verification failed', {
      error: error.message,
      ip: req.ip,
      path: req.path,
    });

    if (error.name === 'TokenExpiredError') {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Token has expired',
      });
    } else if (error.name === 'JsonWebTokenError') {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
    } else {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Token verification failed',
      });
    }
  }
}
