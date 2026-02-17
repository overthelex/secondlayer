/**
 * Billing Service
 * Manages user balances, charges, and transaction history
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { PricingService, PricingTier, PriceCalculation } from './pricing-service.js';

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
  pricing_tier: PricingTier;
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
  pricing_tier: PricingTier;
  billing_enabled: boolean;
  is_active: boolean;
  today_spent_usd: number;
  month_spent_usd: number;
  last_request_at?: Date;
  email_notifications: boolean;
  notify_low_balance: boolean;
  notify_payment_success: boolean;
  notify_payment_failure: boolean;
  notify_monthly_report: boolean;
  low_balance_threshold_usd: number;
}

export interface EmailPreferences {
  email_notifications: boolean;
  notify_low_balance: boolean;
  notify_payment_success: boolean;
  notify_payment_failure: boolean;
  notify_monthly_report: boolean;
  low_balance_threshold_usd: number;
}

export class BillingService {
  private pricingService: PricingService;

  constructor(private db: Database) {
    this.pricingService = new PricingService(db);
  }

  /**
   * PG returns numeric(10,2) as string — coerce to number
   */
  private coerceNumericFields(row: any): UserBilling {
    row.balance_usd = Number(row.balance_usd) || 0;
    row.balance_uah = Number(row.balance_uah) || 0;
    row.daily_limit_usd = Number(row.daily_limit_usd) || 0;
    row.monthly_limit_usd = Number(row.monthly_limit_usd) || 0;
    row.total_spent_usd = Number(row.total_spent_usd) || 0;
    row.total_spent_uah = Number(row.total_spent_uah) || 0;
    row.low_balance_threshold_usd = Number(row.low_balance_threshold_usd) || 0;
    return row as UserBilling;
  }

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
        return this.coerceNumericFields(result.rows[0]);
      }

      // Create new billing account with default values
      const defaultTier = this.pricingService.getDefaultTier();
      const createResult = await this.db.query(
        `INSERT INTO user_billing (
          user_id, balance_usd, balance_uah,
          daily_limit_usd, monthly_limit_usd, pricing_tier
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [userId, 0.00, 0.00, 10.00, 100.00, defaultTier]
      );

      logger.info('Created billing account', { userId });
      return this.coerceNumericFields(createResult.rows[0]);
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
   * Charge user for a completed request with pricing tier markup
   */
  async chargeUser(params: {
    userId: string;
    requestId: string;
    amountUsd: number; // This is the BASE cost (our actual cost)
    amountUah?: number;
    description?: string;
  }): Promise<BillingTransaction & { pricing_details?: PriceCalculation }> {
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
      const pricingTier: PricingTier = billing.pricing_tier || 'startup';

      // Calculate price with markup based on tier
      const priceCalc = this.pricingService.calculatePrice(params.amountUsd, pricingTier);

      // The amount we charge the client
      const chargeAmount = priceCalc.price_usd;

      const balanceBefore = parseFloat(billing.balance_usd);
      const balanceAfter = balanceBefore - chargeAmount;

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
        [chargeAmount, params.amountUah || 0, params.userId]
      );

      // Record transaction with pricing metadata
      const transactionMetadata = {
        base_cost_usd: priceCalc.cost_usd,
        markup_percentage: priceCalc.markup_percentage,
        markup_amount_usd: priceCalc.markup_amount_usd,
        pricing_tier: pricingTier,
      };

      const transactionResult = await client.query(
        `INSERT INTO billing_transactions (
          user_id, type, amount_usd, amount_uah,
          balance_before_usd, balance_after_usd,
          request_id, description, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          params.userId,
          'charge',
          chargeAmount,
          params.amountUah || 0,
          balanceBefore,
          balanceAfter,
          params.requestId,
          params.description || `Request ${params.requestId}`,
          JSON.stringify(transactionMetadata),
        ]
      );

      // Update cost_tracking table with pricing details
      await client.query(
        `UPDATE cost_tracking
         SET base_cost_usd = $1,
             markup_percentage = $2,
             markup_amount_usd = $3,
             client_tier = $4,
             total_cost_usd = $5
         WHERE request_id = $6`,
        [
          priceCalc.cost_usd,
          priceCalc.markup_percentage,
          priceCalc.markup_amount_usd,
          pricingTier,
          priceCalc.price_usd,
          params.requestId,
        ]
      );

      await client.query('COMMIT');

      const transaction = transactionResult.rows[0] as BillingTransaction;

      logger.info('User charged with markup', {
        userId: params.userId,
        requestId: params.requestId,
        baseCost: `$${priceCalc.cost_usd.toFixed(6)}`,
        markup: `${priceCalc.markup_percentage}%`,
        charged: `$${chargeAmount.toFixed(6)}`,
        profit: `$${priceCalc.markup_amount_usd.toFixed(6)}`,
        tier: pricingTier,
        balanceAfter: `$${balanceAfter.toFixed(2)}`,
      });

      return {
        ...transaction,
        pricing_details: priceCalc,
      };
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
   * Update user billing settings (limits, status, pricing tier)
   */
  async updateBillingSettings(
    userId: string,
    settings: {
      dailyLimitUsd?: number;
      monthlyLimitUsd?: number;
      isActive?: boolean;
      billingEnabled?: boolean;
      pricingTier?: PricingTier;
      email_notifications?: boolean;
      notify_low_balance?: boolean;
      notify_payment_success?: boolean;
      notify_payment_failure?: boolean;
      notify_monthly_report?: boolean;
      low_balance_threshold_usd?: number;
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

      if (settings.pricingTier !== undefined) {
        // Validate pricing tier
        if (!this.pricingService.isValidTier(settings.pricingTier)) {
          throw new Error(`Invalid pricing tier: ${settings.pricingTier}`);
        }
        updates.push(`pricing_tier = $${paramIndex++}`);
        params.push(settings.pricingTier);
      }

      if (settings.email_notifications !== undefined) {
        updates.push(`email_notifications = $${paramIndex++}`);
        params.push(settings.email_notifications);
      }

      if (settings.notify_low_balance !== undefined) {
        updates.push(`notify_low_balance = $${paramIndex++}`);
        params.push(settings.notify_low_balance);
      }

      if (settings.notify_payment_success !== undefined) {
        updates.push(`notify_payment_success = $${paramIndex++}`);
        params.push(settings.notify_payment_success);
      }

      if (settings.notify_payment_failure !== undefined) {
        updates.push(`notify_payment_failure = $${paramIndex++}`);
        params.push(settings.notify_payment_failure);
      }

      if (settings.notify_monthly_report !== undefined) {
        updates.push(`notify_monthly_report = $${paramIndex++}`);
        params.push(settings.notify_monthly_report);
      }

      if (settings.low_balance_threshold_usd !== undefined) {
        updates.push(`low_balance_threshold_usd = $${paramIndex++}`);
        params.push(settings.low_balance_threshold_usd);
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

  /**
   * Get user's pricing tier
   */
  async getUserPricingTier(userId: string): Promise<PricingTier> {
    const billing = await this.getOrCreateUserBilling(userId);
    return billing.pricing_tier || 'startup';
  }

  /**
   * Get pricing information for user
   */
  async getUserPricingInfo(userId: string): Promise<{
    current_tier: PricingTier;
    tier_config: any;
    recommended_tier?: PricingTier;
    monthly_spending_usd: number;
  }> {
    const billing = await this.getOrCreateUserBilling(userId);
    const tier = billing.pricing_tier || 'startup';
    const tierConfig = this.pricingService.getTierConfig(tier);

    // Get monthly spending
    const monthResult = await this.db.query(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as spent
       FROM cost_tracking
       WHERE user_id = $1
         AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
         AND status = 'completed'`,
      [userId]
    );
    const monthlySpending = parseFloat(monthResult.rows[0]?.spent || '0');

    const recommendedTier = this.pricingService.getRecommendedTier(monthlySpending);

    return {
      current_tier: tier,
      tier_config: tierConfig,
      recommended_tier: tier !== recommendedTier ? recommendedTier : undefined,
      monthly_spending_usd: monthlySpending,
    };
  }

  /**
   * Get all available pricing tiers
   */
  getAllPricingTiers(): any[] {
    return this.pricingService.getAllTiers();
  }

  /**
   * Calculate estimated price for a cost
   */
  calculateEstimatedPrice(costUsd: number, tier?: PricingTier): PriceCalculation {
    const pricingTier = tier || this.pricingService.getDefaultTier();
    return this.pricingService.calculatePrice(costUsd, pricingTier);
  }

  /**
   * Set invoice number on a billing transaction
   */
  async setTransactionInvoiceNumber(transactionId: string, invoiceNumber: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE billing_transactions SET invoice_number = $1 WHERE id = $2`,
        [invoiceNumber, transactionId]
      );
    } catch (error: any) {
      logger.error('Failed to set invoice number', {
        transactionId,
        invoiceNumber,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get email notification preferences for a user
   */
  async getEmailPreferences(userId: string): Promise<EmailPreferences> {
    try {
      const result = await this.db.query(
        `SELECT
          email_notifications,
          notify_low_balance,
          notify_payment_success,
          notify_payment_failure,
          notify_monthly_report,
          low_balance_threshold_usd
        FROM user_billing
        WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return {
          email_notifications: true,
          notify_low_balance: true,
          notify_payment_success: true,
          notify_payment_failure: true,
          notify_monthly_report: true,
          low_balance_threshold_usd: 5.00,
        };
      }

      const row = result.rows[0];
      return {
        email_notifications: row.email_notifications ?? true,
        notify_low_balance: row.notify_low_balance ?? true,
        notify_payment_success: row.notify_payment_success ?? true,
        notify_payment_failure: row.notify_payment_failure ?? true,
        notify_monthly_report: row.notify_monthly_report ?? true,
        low_balance_threshold_usd: parseFloat(row.low_balance_threshold_usd) || 5.00,
      };
    } catch (error: any) {
      logger.error('Failed to get email preferences', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }
}
