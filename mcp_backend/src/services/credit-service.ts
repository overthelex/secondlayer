/**
 * Credit Service - Phase 2 Billing
 * Handles credit balance checks, deductions, and additions
 */

import { Pool } from 'pg';
import { logger } from '../utils/logger.js';

export interface UserBalance {
  hasCredits: boolean;
  currentBalance: number;
  reason: string;
}

export interface CreditDeduction {
  success: boolean;
  newBalance: number;
  transactionId: string | null;
}

export interface CreditAddition {
  success: boolean;
  newBalance: number;
  transactionId: string;
}

export interface BalanceStatus {
  userId: string;
  email: string;
  name: string | null;
  balance: number;
  lifetimePurchased: number;
  lifetimeUsed: number;
  lastPurchaseAt: Date | null;
  subscriptionStatus: string;
  subscriptionPlanName: string | null;
  subscriptionTier: string | null;
  subscriptionMonthlyCredits: number | null;
  subscriptionExpiresAt: Date | null;
  balanceStatus: 'depleted' | 'low' | 'medium' | 'healthy';
}

export class CreditService {
  constructor(private pool: Pool) {}

  /**
   * Check if user has sufficient credits
   */
  async checkBalance(userId: string, requiredCredits: number = 1): Promise<UserBalance> {
    try {
      const result = await this.pool.query<UserBalance>(
        `SELECT * FROM check_user_balance($1, $2)`,
        [userId, requiredCredits]
      );

      if (result.rows.length === 0) {
        return {
          hasCredits: false,
          currentBalance: 0,
          reason: 'Balance check failed',
        };
      }

      return result.rows[0];
    } catch (error: any) {
      logger.error('[CreditService] Error checking balance', {
        error: error.message,
        userId,
      });
      throw error;
    }
  }

  /**
   * Deduct credits from user balance
   */
  async deductCredits(
    userId: string,
    amount: number,
    toolName: string,
    costTrackingId?: string,
    description?: string
  ): Promise<CreditDeduction> {
    try {
      const result = await this.pool.query<CreditDeduction>(
        `SELECT * FROM deduct_credits($1, $2, $3, $4, $5)`,
        [userId, amount, toolName, costTrackingId || null, description || null]
      );

      if (result.rows.length === 0) {
        return {
          success: false,
          newBalance: 0,
          transactionId: null,
        };
      }

      const deduction = result.rows[0];

      if (deduction.success) {
        logger.info('[CreditService] Credits deducted', {
          userId,
          amount,
          toolName,
          newBalance: deduction.newBalance,
          transactionId: deduction.transactionId,
        });
      } else {
        logger.warn('[CreditService] Insufficient credits', {
          userId,
          amount,
          toolName,
          newBalance: deduction.newBalance,
        });
      }

      return deduction;
    } catch (error: any) {
      logger.error('[CreditService] Error deducting credits', {
        error: error.message,
        userId,
        amount,
        toolName,
      });
      throw error;
    }
  }

  /**
   * Add credits to user balance
   */
  async addCredits(
    userId: string,
    amount: number,
    transactionType: 'purchase' | 'bonus' | 'refund' | 'subscription_grant',
    source: string,
    sourceId?: string,
    description?: string,
    stripePaymentIntentId?: string
  ): Promise<CreditAddition> {
    try {
      const result = await this.pool.query<CreditAddition>(
        `SELECT * FROM add_credits($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          amount,
          transactionType,
          source,
          sourceId || null,
          description || null,
          stripePaymentIntentId || null,
        ]
      );

      if (result.rows.length === 0) {
        throw new Error('Failed to add credits');
      }

      const addition = result.rows[0];

      logger.info('[CreditService] Credits added', {
        userId,
        amount,
        transactionType,
        source,
        newBalance: addition.newBalance,
        transactionId: addition.transactionId,
      });

      return addition;
    } catch (error: any) {
      logger.error('[CreditService] Error adding credits', {
        error: error.message,
        userId,
        amount,
        transactionType,
      });
      throw error;
    }
  }

  /**
   * Calculate credits needed for tool call
   */
  async calculateCreditsForTool(toolName: string, userId?: string): Promise<number> {
    try {
      const result = await this.pool.query<{ calculate_credits_for_tool: number }>(
        `SELECT calculate_credits_for_tool($1, $2) as credits`,
        [toolName, userId || null]
      );

      if (result.rows.length === 0) {
        logger.warn('[CreditService] Could not calculate credits for tool', {
          toolName,
        });
        return 1; // Default
      }

      return result.rows[0].calculate_credits_for_tool || 1;
    } catch (error: any) {
      logger.error('[CreditService] Error calculating credits for tool', {
        error: error.message,
        toolName,
      });
      return 1; // Fallback to 1 credit
    }
  }

  /**
   * Get user balance status with subscription info
   */
  async getBalanceStatus(userId: string): Promise<BalanceStatus | null> {
    try {
      const result = await this.pool.query<BalanceStatus>(
        `SELECT
          user_id as "userId",
          email,
          name,
          balance,
          lifetime_purchased as "lifetimePurchased",
          lifetime_used as "lifetimeUsed",
          last_purchase_at as "lastPurchaseAt",
          subscription_status as "subscriptionStatus",
          subscription_plan_name as "subscriptionPlanName",
          subscription_tier as "subscriptionTier",
          subscription_monthly_credits as "subscriptionMonthlyCredits",
          subscription_expires_at as "subscriptionExpiresAt",
          balance_status as "balanceStatus"
        FROM user_balance_status
        WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error: any) {
      logger.error('[CreditService] Error getting balance status', {
        error: error.message,
        userId,
      });
      throw error;
    }
  }

  /**
   * Get recent credit transactions
   */
  async getTransactions(userId: string, limit: number = 20): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT
          id,
          transaction_type as "transactionType",
          amount,
          balance_before as "balanceBefore",
          balance_after as "balanceAfter",
          source,
          source_id as "sourceId",
          description,
          created_at as "createdAt"
        FROM credit_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
        [userId, limit]
      );

      return result.rows;
    } catch (error: any) {
      logger.error('[CreditService] Error getting transactions', {
        error: error.message,
        userId,
      });
      throw error;
    }
  }

  /**
   * Initialize user credits record if not exists
   */
  async initializeUserCredits(userId: string, initialBalance: number = 0): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO user_credits (user_id, balance)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, initialBalance]
      );

      logger.info('[CreditService] User credits initialized', {
        userId,
        initialBalance,
      });
    } catch (error: any) {
      logger.error('[CreditService] Error initializing user credits', {
        error: error.message,
        userId,
      });
      throw error;
    }
  }
}
