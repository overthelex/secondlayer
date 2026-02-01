/**
 * Billing Middleware - Phase 2 Billing
 * Checks API keys, validates balance, and enforces rate limits
 */

import { Request, Response, NextFunction } from 'express';
import { ApiKeyService } from '../services/api-key-service.js';
import { CreditService } from '../services/credit-service.js';
import { logger } from '../utils/logger.js';

export interface BillingRequest extends Request {
  userId?: string;
  clientKey?: string;
  apiKeyInfo?: any;
  creditsRequired?: number;
}

/**
 * Middleware to validate API key and attach user info to request
 * This does NOT block anonymous requests - for backward compatibility
 */
export function validateApiKey(
  apiKeyService: ApiKeyService
) {
  return async (req: BillingRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No API key provided - continue as anonymous
      logger.debug('[BillingMiddleware] No API key provided, continuing as anonymous');
      return next();
    }

    const token = authHeader.replace('Bearer ', '');

    // Skip JWT tokens (handled by other middleware)
    if (token.includes('.')) {
      logger.debug('[BillingMiddleware] JWT token detected, skipping API key validation');
      return next();
    }

    try {
      // Validate API key
      const keyInfo = await apiKeyService.validateApiKey(token);

      if (!keyInfo) {
        logger.warn('[BillingMiddleware] Invalid or expired API key', {
          keyPrefix: token.substring(0, 12) + '...',
        });
        return res.status(401).json({
          error: 'Invalid or expired API key',
          code: 'INVALID_API_KEY',
        });
      }

      // Check rate limits
      const rateLimit = await apiKeyService.checkRateLimit(token);

      if (!rateLimit.allowed) {
        logger.warn('[BillingMiddleware] Rate limit exceeded', {
          keyId: keyInfo.id,
          reason: rateLimit.reason,
          requestsToday: rateLimit.requestsToday,
          rateLimitPerDay: rateLimit.rateLimitPerDay,
        });
        return res.status(429).json({
          error: 'Rate limit exceeded',
          code: 'RATE_LIMIT_EXCEEDED',
          reason: rateLimit.reason,
          requestsToday: rateLimit.requestsToday,
          rateLimitPerDay: rateLimit.rateLimitPerDay,
        });
      }

      // Attach user info to request
      req.userId = keyInfo.userId;
      req.clientKey = token;
      req.apiKeyInfo = keyInfo;

      logger.debug('[BillingMiddleware] API key validated', {
        userId: keyInfo.userId,
        keyId: keyInfo.id,
        userEmail: keyInfo.userEmail,
      });

      // Update usage stats (async, don't wait)
      apiKeyService.updateUsage(token).catch((error) => {
        logger.error('[BillingMiddleware] Failed to update API key usage', {
          error: error.message,
        });
      });

      next();
    } catch (error: any) {
      logger.error('[BillingMiddleware] Error validating API key', {
        error: error.message,
      });
      return res.status(500).json({
        error: 'Internal server error during API key validation',
        code: 'INTERNAL_ERROR',
      });
    }
  };
}

/**
 * Middleware to require API key (blocks anonymous requests)
 * Use this for endpoints that MUST have authentication
 */
export function requireApiKey(
  apiKeyService: ApiKeyService
) {
  return async (req: BillingRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'API key required',
        code: 'API_KEY_REQUIRED',
        message: 'This endpoint requires authentication with an API key',
      });
    }

    // Use the validation middleware
    return validateApiKey(apiKeyService)(req, res, next);
  };
}

/**
 * Middleware to check if user has sufficient credits
 * Blocks request if balance is insufficient
 */
export function checkCredits(
  creditService: CreditService,
  toolName?: string
) {
  return async (req: BillingRequest, res: Response, next: NextFunction) => {
    // Skip check for anonymous users (backward compatibility)
    if (!req.userId) {
      logger.debug('[BillingMiddleware] No userId, skipping credit check (anonymous mode)');
      return next();
    }

    try {
      // Calculate credits required
      let creditsRequired = 1;

      if (toolName) {
        creditsRequired = await creditService.calculateCreditsForTool(toolName, req.userId);
      } else if (req.body?.toolName) {
        creditsRequired = await creditService.calculateCreditsForTool(
          req.body.toolName,
          req.userId
        );
      } else if (req.params?.toolName) {
        creditsRequired = await creditService.calculateCreditsForTool(
          req.params.toolName,
          req.userId
        );
      }

      // Attach credits required to request for later use
      req.creditsRequired = creditsRequired;

      // Check if user has sufficient credits
      const balance = await creditService.checkBalance(req.userId, creditsRequired);

      if (!balance.hasCredits) {
        logger.warn('[BillingMiddleware] Insufficient credits', {
          userId: req.userId,
          currentBalance: balance.currentBalance,
          creditsRequired,
          toolName,
        });
        return res.status(402).json({
          error: 'Insufficient credits',
          code: 'INSUFFICIENT_CREDITS',
          currentBalance: balance.currentBalance,
          creditsRequired,
          message: 'Your credit balance is too low to perform this operation. Please purchase more credits.',
        });
      }

      logger.debug('[BillingMiddleware] Credit check passed', {
        userId: req.userId,
        currentBalance: balance.currentBalance,
        creditsRequired,
      });

      next();
    } catch (error: any) {
      logger.error('[BillingMiddleware] Error checking credits', {
        error: error.message,
        userId: req.userId,
      });
      return res.status(500).json({
        error: 'Internal server error during credit check',
        code: 'INTERNAL_ERROR',
      });
    }
  };
}

/**
 * Helper to deduct credits after successful operation
 * Call this manually after tool execution
 */
export async function deductCreditsAfterExecution(
  creditService: CreditService,
  userId: string,
  toolName: string,
  costTrackingId?: string
): Promise<{ success: boolean; newBalance: number }> {
  try {
    // Calculate credits
    const creditsRequired = await creditService.calculateCreditsForTool(toolName, userId);

    // Deduct credits
    const result = await creditService.deductCredits(
      userId,
      creditsRequired,
      toolName,
      costTrackingId,
      `Tool execution: ${toolName}`
    );

    if (!result.success) {
      logger.error('[BillingMiddleware] Failed to deduct credits after execution', {
        userId,
        toolName,
        creditsRequired,
      });
    }

    return {
      success: result.success,
      newBalance: result.newBalance,
    };
  } catch (error: any) {
    logger.error('[BillingMiddleware] Error deducting credits after execution', {
      error: error.message,
      userId,
      toolName,
    });
    return {
      success: false,
      newBalance: 0,
    };
  }
}
