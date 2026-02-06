/**
 * OAuth Authentication Middleware
 * Validates OAuth access tokens for SSE and API requests
 */

import { Request, Response, NextFunction } from 'express';
import { OAuthService } from '../services/oauth-service.js';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

export interface OAuthAuthenticatedRequest extends Request {
  userId?: string;
  clientId?: string;
  scope?: string;
}

/**
 * OAuth authentication middleware
 * Checks for OAuth access token in Authorization header
 */
export function createOAuthMiddleware(db: Database) {
  const oauthService = new OAuthService(db);

  return async (req: OAuthAuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res.status(401).json({
          error: 'unauthorized',
          error_description: 'Authorization header required',
        });
      }

      // Extract Bearer token
      const match = authHeader.match(/^Bearer (.+)$/i);
      if (!match) {
        return res.status(401).json({
          error: 'unauthorized',
          error_description: 'Invalid authorization header format. Expected: Bearer <token>',
        });
      }

      const accessToken = match[1];

      // Verify access token
      const tokenData = await oauthService.verifyAccessToken(accessToken);

      if (!tokenData) {
        return res.status(401).json({
          error: 'invalid_token',
          error_description: 'Invalid or expired access token',
        });
      }

      // Attach user info to request
      req.userId = tokenData.userId;
      req.clientId = tokenData.clientId;
      req.scope = tokenData.scope;

      logger.debug('OAuth authentication successful', {
        userId: tokenData.userId,
        clientId: tokenData.clientId,
      });

      next();
    } catch (error: any) {
      logger.error('OAuth authentication error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error',
      });
    }
  };
}

/**
 * Hybrid authentication middleware
 * Supports both OAuth tokens and API keys (Bearer tokens from SECONDARY_LAYER_KEYS)
 */
export function createHybridAuthMiddleware(db: Database) {
  const oauthService = new OAuthService(db);
  const apiKeys = (process.env.SECONDARY_LAYER_KEYS || '').split(',').map((k) => k.trim());

  return async (req: OAuthAuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res.status(401).json({
          error: 'unauthorized',
          error_description: 'Authorization header required',
        });
      }

      // Extract Bearer token
      const match = authHeader.match(/^Bearer (.+)$/i);
      if (!match) {
        return res.status(401).json({
          error: 'unauthorized',
          error_description: 'Invalid authorization header format. Expected: Bearer <token>',
        });
      }

      const token = match[1];

      // Try OAuth token first (if it starts with mcp_token_)
      if (token.startsWith('mcp_token_')) {
        const tokenData = await oauthService.verifyAccessToken(token);

        if (tokenData) {
          // Valid OAuth token
          req.userId = tokenData.userId;
          req.clientId = tokenData.clientId;
          req.scope = tokenData.scope;

          logger.debug('OAuth authentication successful', {
            userId: tokenData.userId,
            clientId: tokenData.clientId,
          });

          return next();
        }

        // Invalid OAuth token
        return res.status(401).json({
          error: 'invalid_token',
          error_description: 'Invalid or expired OAuth access token',
        });
      }

      // Try API key authentication
      if (apiKeys.includes(token)) {
        // Valid API key - no user ID attached
        logger.debug('API key authentication successful');
        return next();
      }

      // Neither OAuth token nor API key
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'Invalid access token or API key',
      });
    } catch (error: any) {
      logger.error('Hybrid authentication error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error',
      });
    }
  };
}
