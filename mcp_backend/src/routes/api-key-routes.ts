/**
 * API Key Management Routes - Phase 2 Billing
 * Endpoints for creating, listing, and managing API keys
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { ApiKeyService } from '../services/api-key-service.js';
import { CreditService } from '../services/credit-service.js';
import { logger } from '../utils/logger.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  user?: any;
}

export function createApiKeyRouter(pool: Pool): Router {
  const router = Router();
  const apiKeyService = new ApiKeyService(pool);
  const creditService = new CreditService(pool);

  /**
   * GET /api/keys - List all API keys for authenticated user
   */
  router.get('/', async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      if (!req.userId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User ID not found in request',
        });
      }

      const keys = await apiKeyService.listUserApiKeys(req.userId);

      // Mask keys (show only prefix and suffix)
      const maskedKeys = keys.map((key: any) => ({
        ...key,
        key: `${key.key.substring(0, 12)}...${key.key.substring(key.key.length - 4)}`,
      }));

      return res.json({
        success: true,
        keys: maskedKeys,
        count: maskedKeys.length,
      });
    } catch (error: any) {
      logger.error('[ApiKeyRoutes] Error listing API keys', {
        error: error.message,
        userId: req.userId,
      });
      return res.status(500).json({
        error: 'Failed to list API keys',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/keys - Create new API key
   */
  router.post('/', async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      if (!req.userId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User ID not found in request',
        });
      }

      const { name, description, expiresAt } = req.body;

      if (!name || name.trim().length === 0) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Key name is required',
        });
      }

      if (name.length > 100) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Key name must be 100 characters or less',
        });
      }

      const expiresAtDate = expiresAt ? new Date(expiresAt) : undefined;

      const newKey = await apiKeyService.createApiKey(
        req.userId,
        name.trim(),
        description?.trim(),
        expiresAtDate
      );

      // Return full key only once at creation
      return res.status(201).json({
        success: true,
        key: newKey,
        message: 'API key created successfully. Save this key - it will not be shown again!',
      });
    } catch (error: any) {
      logger.error('[ApiKeyRoutes] Error creating API key', {
        error: error.message,
        userId: req.userId,
      });
      return res.status(500).json({
        error: 'Failed to create API key',
        message: error.message,
      });
    }
  });

  /**
   * DELETE /api/keys/:keyId - Revoke (deactivate) API key
   */
  router.delete('/:keyId', async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      if (!req.userId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User ID not found in request',
        });
      }

      const { keyId } = req.params;

      if (!keyId) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Key ID is required',
        });
      }

      const success = await apiKeyService.revokeApiKey(keyId, req.userId);

      if (!success) {
        return res.status(404).json({
          error: 'Not found',
          message: 'API key not found or you do not have permission to revoke it',
        });
      }

      return res.json({
        success: true,
        message: 'API key revoked successfully',
      });
    } catch (error: any) {
      logger.error('[ApiKeyRoutes] Error revoking API key', {
        error: error.message,
        userId: req.userId,
        keyId: req.params.keyId,
      });
      return res.status(500).json({
        error: 'Failed to revoke API key',
        message: error.message,
      });
    }
  });

  /**
   * GET /api/balance - Get user credit balance and status
   */
  router.get('/balance', async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      if (!req.userId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User ID not found in request',
        });
      }

      const balanceStatus = await creditService.getBalanceStatus(req.userId);

      if (!balanceStatus) {
        // Initialize credits if not exists
        await creditService.initializeUserCredits(req.userId, 0);

        return res.json({
          success: true,
          balance: 0,
          lifetimePurchased: 0,
          lifetimeUsed: 0,
          subscriptionStatus: 'none',
          balanceStatus: 'depleted',
        });
      }

      return res.json({
        success: true,
        ...balanceStatus,
      });
    } catch (error: any) {
      logger.error('[ApiKeyRoutes] Error getting balance', {
        error: error.message,
        userId: req.userId,
      });
      return res.status(500).json({
        error: 'Failed to get balance',
        message: error.message,
      });
    }
  });

  /**
   * GET /api/transactions - Get recent credit transactions
   */
  router.get('/transactions', async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      if (!req.userId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User ID not found in request',
        });
      }

      const limit = parseInt(req.query.limit as string) || 20;

      if (limit < 1 || limit > 100) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Limit must be between 1 and 100',
        });
      }

      const transactions = await creditService.getTransactions(req.userId, limit);

      return res.json({
        success: true,
        transactions,
        count: transactions.length,
      });
    } catch (error: any) {
      logger.error('[ApiKeyRoutes] Error getting transactions', {
        error: error.message,
        userId: req.userId,
      });
      return res.status(500).json({
        error: 'Failed to get transactions',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/credits/add - Add credits to user balance (admin/testing)
   * TODO: Add admin authorization check
   */
  router.post('/credits/add', async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      if (!req.userId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User ID not found in request',
        });
      }

      const { amount, description } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Amount must be a positive number',
        });
      }

      const result = await creditService.addCredits(
        req.userId,
        amount,
        'bonus',
        'manual_grant',
        undefined,
        description || 'Manual credit grant'
      );

      return res.json({
        success: true,
        newBalance: result.newBalance,
        transactionId: result.transactionId,
        message: `${amount} credits added successfully`,
      });
    } catch (error: any) {
      logger.error('[ApiKeyRoutes] Error adding credits', {
        error: error.message,
        userId: req.userId,
      });
      return res.status(500).json({
        error: 'Failed to add credits',
        message: error.message,
      });
    }
  });

  return router;
}
