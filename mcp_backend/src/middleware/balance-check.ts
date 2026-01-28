/**
 * Balance Check Middleware
 * Pre-flight balance validation before tool execution
 */

import { Request, Response, NextFunction } from 'express';
import { BillingService } from '../services/billing-service.js';
import { CostTracker } from '../services/cost-tracker.js';
import { logger } from '../utils/logger.js';

export interface DualAuthRequest extends Request {
  user?: {
    userId: string;
    email: string;
    name: string;
  };
  clientKey?: string;
  authType?: 'jwt' | 'apikey';
}

/**
 * Create balance check middleware
 */
export function createBalanceCheckMiddleware(
  billingService: BillingService,
  costTracker: CostTracker
) {
  return async (req: DualAuthRequest, res: Response, next: NextFunction) => {
    try {
      // Skip balance check for API key authentication
      if (req.authType === 'apikey') {
        logger.debug('Skipping balance check for API key auth');
        return next();
      }

      // Skip if no user (shouldn't happen with dual-auth)
      if (!req.user || !req.user.userId) {
        logger.warn('Balance check: no user in request');
        return next();
      }

      const userId = req.user.userId;

      // Get or create billing account
      const billing = await billingService.getOrCreateUserBilling(userId);

      // Skip if billing is disabled for this user
      if (!billing.billing_enabled) {
        logger.debug('Billing disabled for user', { userId });
        return next();
      }

      // Estimate cost for this request
      const toolName = req.params.toolName || req.body.toolName || 'unknown';
      const estimatedCost = costTracker.estimateCost(toolName, req.body);

      logger.debug('Pre-flight balance check', {
        userId,
        toolName,
        estimatedCost: estimatedCost.total_estimated_cost_usd,
        currentBalance: billing.balance_usd,
      });

      // Check if user has sufficient balance
      const balanceCheck = await billingService.checkBalance(
        userId,
        estimatedCost.total_estimated_cost_usd
      );

      if (!balanceCheck.hasBalance) {
        logger.warn('Insufficient balance', {
          userId,
          required: estimatedCost.total_estimated_cost_usd,
          available: balanceCheck.currentBalance,
        });

        return res.status(402).json({
          error: 'Insufficient balance',
          message: `Required: $${estimatedCost.total_estimated_cost_usd.toFixed(2)}, Available: $${balanceCheck.currentBalance.toFixed(2)}`,
          code: 'INSUFFICIENT_BALANCE',
          balance: {
            current_usd: balanceCheck.currentBalance,
            required_usd: estimatedCost.total_estimated_cost_usd,
            shortfall_usd: estimatedCost.total_estimated_cost_usd - balanceCheck.currentBalance,
          },
          topup_url: `${process.env.FRONTEND_URL || 'https://billing.legal.org.ua'}/topup`,
        });
      }

      // Check daily and monthly limits
      const limitsCheck = await billingService.checkLimits(userId);

      if (!limitsCheck.withinDailyLimit) {
        logger.warn('Daily limit exceeded', {
          userId,
          dailySpent: limitsCheck.todaySpent,
          dailyLimit: limitsCheck.dailyLimit,
        });

        return res.status(429).json({
          error: 'Daily limit exceeded',
          message: `You have reached your daily spending limit of $${limitsCheck.dailyLimit.toFixed(2)}`,
          code: 'DAILY_LIMIT_EXCEEDED',
          limits: {
            daily_limit_usd: limitsCheck.dailyLimit,
            daily_spent_usd: limitsCheck.todaySpent,
            monthly_limit_usd: limitsCheck.monthlyLimit,
            monthly_spent_usd: limitsCheck.monthSpent,
          },
          reset_at: limitsCheck.dailyResetAt,
        });
      }

      if (!limitsCheck.withinMonthlyLimit) {
        logger.warn('Monthly limit exceeded', {
          userId,
          monthlySpent: limitsCheck.monthSpent,
          monthlyLimit: limitsCheck.monthlyLimit,
        });

        return res.status(429).json({
          error: 'Monthly limit exceeded',
          message: `You have reached your monthly spending limit of $${limitsCheck.monthlyLimit.toFixed(2)}`,
          code: 'MONTHLY_LIMIT_EXCEEDED',
          limits: {
            daily_limit_usd: limitsCheck.dailyLimit,
            daily_spent_usd: limitsCheck.todaySpent,
            monthly_limit_usd: limitsCheck.monthlyLimit,
            monthly_spent_usd: limitsCheck.monthSpent,
          },
          reset_at: limitsCheck.monthlyResetAt,
        });
      }

      // All checks passed - proceed to tool execution
      logger.debug('Pre-flight checks passed', { userId, toolName });
      next();
    } catch (error: any) {
      logger.error('Balance check middleware error', {
        error: error.message,
        userId: req.user?.userId,
      });

      // Don't block request on middleware errors - log and continue
      next();
    }
  };
}
