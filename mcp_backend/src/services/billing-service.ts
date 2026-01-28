/**
 * Billing Service
 * Manages user balances, charges, and transaction history
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

export interface UserBilling {
  id: string;
  user_id: string;
  balance_usd: number;
  balance_uah: number;
  daily_limit_usd: number;
  monthly_limit_usd: number;
  total_spent_usd: number;
  total_spent_uah: number;
  total_requests: number;
  is_active: boolean;
  billing_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BillingTransaction {
  id: string;
  user_id: string;
  type: 'charge' | 'refund' | 'topup' | 'adjustment';
  amount_usd: number;
  amount_uah: number;
  balance_before_usd: number;
  balance_after_usd: number;
  request_id?: string;
  payment_provider?: string;
  payment_id?: string;
  description?: string;
  metadata?: any;
  created_at: Date;
}

export interface BillingSummary {
  user_id: string;
  email: string;
  name: string;
  balance_usd: number;
  balance_uah: number;
  total_spent_usd: number;
  total_requests: number;
  daily_limit_usd: number;
  monthly_limit_usd: number;
  today_spent_usd: number;
  month_spent_usd: number;
  last_request_at?: Date;
}

export class BillingService {
  constructor(private db: Database) {}

  /**
   * Get or create user billing account
   */
  async getOrCreateUserBilling(userId: string): Promise<UserBilling> {
    try {
      // Try to get existing billing account
      const result = await this.db.query(
        'SELECT * FROM user_billing WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length > 0) {
        return result.rows[0] as UserBilling;
      }

      // Create new billing account with default values
      const createResult = await this.db.query(
        `INSERT INTO user_billing (
          user_id, balance_usd, balance_uah,
          daily_limit_usd, monthly_limit_usd
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [userId, 0.00, 0.00, 10.00, 100.00]
      );

      logger.info('Created billing account', { userId });
      return createResult.rows[0] as UserBilling;
    } catch (error: any) {
      logger.error('Failed to get or create user billing', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if user has sufficient balance for estimated cost
   */
  async checkBalance(userId: string, estimatedCostUsd: number): Promise<{
    hasBalance: boolean;
    currentBalance: number;
    estimatedCost: number;
  }> {
    const billing = await this.getOrCreateUserBilling(userId);

    // Check if billing is enabled
    if (!billing.billing_enabled || !billing.is_active) {
      return {
        hasBalance: true,
        currentBalance: billing.balance_usd,
        estimatedCost: estimatedCostUsd,
      };
    }

    const hasBalance = billing.balance_usd >= estimatedCostUsd;

    if (!hasBalance) {
      logger.warn('Insufficient balance', {
        userId,
        balance: billing.balance_usd,
        required: estimatedCostUsd,
      });
    }

    return {
      hasBalance,
      currentBalance: billing.balance_usd,
      estimatedCost: estimatedCostUsd,
    };
  }

  /**
   * Check if user is within daily and monthly limits
   */
  async checkLimits(userId: string, additionalCostUsd: number): Promise<{
    withinLimits: boolean;
    dailySpent: number;
    dailyLimit: number;
    monthlySpent: number;
    monthlyLimit: number;
    reason?: string;
  }> {
    const billing = await this.getOrCreateUserBilling(userId);

    // Get today's spending
    const todayResult = await this.db.query(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as spent
       FROM cost_tracking
       WHERE user_id = $1
         AND created_at >= CURRENT_DATE
         AND status = 'completed'`,
      [userId]
    );
    const dailySpent = parseFloat(todayResult.rows[0]?.spent || '0');

    // Get this month's spending
    const monthResult = await this.db.query(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as spent
       FROM cost_tracking
       WHERE user_id = $1
         AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
         AND status = 'completed'`,
      [userId]
    );
    const monthlySpent = parseFloat(monthResult.rows[0]?.spent || '0');

    // Check limits
    const dailyExceeded = dailySpent + additionalCostUsd > billing.daily_limit_usd;
    const monthlyExceeded = monthlySpent + additionalCostUsd > billing.monthly_limit_usd;

    let reason: string | undefined;
    if (dailyExceeded) {
      reason = `Daily limit exceeded: $${dailySpent.toFixed(2)}/$${billing.daily_limit_usd.toFixed(2)}`;
    } else if (monthlyExceeded) {
      reason = `Monthly limit exceeded: $${monthlySpent.toFixed(2)}/$${billing.monthly_limit_usd.toFixed(2)}`;
    }

    return {
      withinLimits: !dailyExceeded && !monthlyExceeded,
      dailySpent,
      dailyLimit: billing.daily_limit_usd,
      monthlySpent,
      monthlyLimit: billing.monthly_limit_usd,
      reason,
    };
  }

  /**
   * Charge user for a completed request
   */
  async chargeUser(params: {
    userId: string;
    requestId: string;
    amountUsd: number;
    amountUah?: number;
    description?: string;
  }): Promise<BillingTransaction> {
    const client = await this.db.getPool().connect();

    try {
      await client.query('BEGIN');

      // Get current billing account (with row lock)
      const billingResult = await client.query(
        'SELECT * FROM user_billing WHERE user_id = $1 FOR UPDATE',
        [params.userId]
      );

      if (billingResult.rows.length === 0) {
        throw new Error('User billing account not found');
      }

      const billing = billingResult.rows[0];
      const balanceBefore = parseFloat(billing.balance_usd);
      const balanceAfter = balanceBefore - params.amountUsd;

      // Update balance and statistics
      await client.query(
        `UPDATE user_billing
         SET balance_usd = balance_usd - $1,
             balance_uah = balance_uah - $2,
             total_spent_usd = total_spent_usd + $1,
             total_spent_uah = total_spent_uah + $2,
             total_requests = total_requests + 1,
             updated_at = NOW()
         WHERE user_id = $3`,
        [params.amountUsd, params.amountUah || 0, params.userId]
      );

      // Record transaction
      const transactionResult = await client.query(
        `INSERT INTO billing_transactions (
          user_id, type, amount_usd, amount_uah,
          balance_before_usd, balance_after_usd,
          request_id, description
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          params.userId,
          'charge',
          params.amountUsd,
          params.amountUah || 0,
          balanceBefore,
          balanceAfter,
          params.requestId,
          params.description || `Request ${params.requestId}`,
        ]
      );

      await client.query('COMMIT');

      const transaction = transactionResult.rows[0] as BillingTransaction;

      logger.info('User charged', {
        userId: params.userId,
        requestId: params.requestId,
        amount: params.amountUsd,
        balanceAfter,
      });

      return transaction;
    } catch (error: any) {
      await client.query('ROLLBACK');
      logger.error('Failed to charge user', {
        userId: params.userId,
        requestId: params.requestId,
        error: error.message,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Top up user balance (manual or via payment provider)
   */
  async topUpBalance(params: {
    userId: string;
    amountUsd: number;
    amountUah?: number;
    description?: string;
    paymentProvider?: string;
    paymentId?: string;
    metadata?: any;
  }): Promise<BillingTransaction> {
    const client = await this.db.getPool().connect();

    try {
      await client.query('BEGIN');

      // Get current billing account (with row lock)
      const billingResult = await client.query(
        'SELECT * FROM user_billing WHERE user_id = $1 FOR UPDATE',
        [params.userId]
      );

      if (billingResult.rows.length === 0) {
        throw new Error('User billing account not found');
      }

      const billing = billingResult.rows[0];
      const balanceBefore = parseFloat(billing.balance_usd);
      const balanceAfter = balanceBefore + params.amountUsd;

      // Update balance
      await client.query(
        `UPDATE user_billing
         SET balance_usd = balance_usd + $1,
             balance_uah = balance_uah + $2,
             updated_at = NOW()
         WHERE user_id = $3`,
        [params.amountUsd, params.amountUah || 0, params.userId]
      );

      // Record transaction
      const transactionResult = await client.query(
        `INSERT INTO billing_transactions (
          user_id, type, amount_usd, amount_uah,
          balance_before_usd, balance_after_usd,
          description, payment_provider, payment_id, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          params.userId,
          'topup',
          params.amountUsd,
          params.amountUah || 0,
          balanceBefore,
          balanceAfter,
          params.description || `Top up $${params.amountUsd}`,
          params.paymentProvider,
          params.paymentId,
          JSON.stringify(params.metadata || {}),
        ]
      );

      await client.query('COMMIT');

      const transaction = transactionResult.rows[0] as BillingTransaction;

      logger.info('Balance topped up', {
        userId: params.userId,
        amount: params.amountUsd,
        balanceAfter,
        provider: params.paymentProvider,
      });

      return transaction;
    } catch (error: any) {
      await client.query('ROLLBACK');
      logger.error('Failed to top up balance', {
        userId: params.userId,
        error: error.message,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get billing summary for user
   */
  async getBillingSummary(userId: string): Promise<BillingSummary | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM user_billing_summary WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as BillingSummary;
    } catch (error: any) {
      logger.error('Failed to get billing summary', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get transaction history for user
   */
  async getTransactionHistory(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      type?: string;
    } = {}
  ): Promise<BillingTransaction[]> {
    const { limit = 50, offset = 0, type } = options;

    try {
      let query = `
        SELECT * FROM billing_transactions
        WHERE user_id = $1
      `;
      const params: any[] = [userId];

      if (type) {
        query += ' AND type = $2';
        params.push(type);
      }

      query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
      params.push(limit, offset);

      const result = await this.db.query(query, params);
      return result.rows as BillingTransaction[];
    } catch (error: any) {
      logger.error('Failed to get transaction history', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update user billing settings (limits, status)
   */
  async updateBillingSettings(
    userId: string,
    settings: {
      dailyLimitUsd?: number;
      monthlyLimitUsd?: number;
      isActive?: boolean;
      billingEnabled?: boolean;
    }
  ): Promise<void> {
    try {
      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (settings.dailyLimitUsd !== undefined) {
        updates.push(`daily_limit_usd = $${paramIndex++}`);
        params.push(settings.dailyLimitUsd);
      }

      if (settings.monthlyLimitUsd !== undefined) {
        updates.push(`monthly_limit_usd = $${paramIndex++}`);
        params.push(settings.monthlyLimitUsd);
      }

      if (settings.isActive !== undefined) {
        updates.push(`is_active = $${paramIndex++}`);
        params.push(settings.isActive);
      }

      if (settings.billingEnabled !== undefined) {
        updates.push(`billing_enabled = $${paramIndex++}`);
        params.push(settings.billingEnabled);
      }

      if (updates.length === 0) {
        return;
      }

      params.push(userId);
      const query = `
        UPDATE user_billing
        SET ${updates.join(', ')}, updated_at = NOW()
        WHERE user_id = $${paramIndex}
      `;

      await this.db.query(query, params);

      logger.info('Billing settings updated', { userId, settings });
    } catch (error: any) {
      logger.error('Failed to update billing settings', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }
}
