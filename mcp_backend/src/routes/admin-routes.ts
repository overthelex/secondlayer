/**
 * Admin Billing Routes
 * Administrative endpoints for managing users, billing, and system settings
 * Requires admin authentication
 */

import express, { Request, Response } from 'express';
import { Database } from '../database/database.js';
import { BillingService } from '../services/billing-service.js';
import { UserPreferencesService } from '../services/user-preferences-service.js';
import { PrometheusService } from '../services/prometheus-service.js';
import { PricingService } from '../services/pricing-service.js';
import { SubscriptionService } from '../services/subscription-service.js';
import { logger } from '../utils/logger.js';

/**
 * Helper to ensure param is a string (Express can return string | string[])
 */
function getStringParam(param: string | string[] | undefined): string | null {
  if (!param) return null;
  return Array.isArray(param) ? param[0] : param;
}

export function createAdminRoutes(
  db: Database,
  prometheusUrl?: string,
  pricingService?: PricingService,
  subscriptionService?: SubscriptionService
): express.Router {
  const router = express.Router();
  const billingService = new BillingService(db);
  const preferencesService = new UserPreferencesService(db);
  const prometheus = new PrometheusService(prometheusUrl);
  const pricing = pricingService || new PricingService(db);
  const subscriptions = subscriptionService || new SubscriptionService(db);

  /**
   * Middleware to verify admin access
   */
  const requireAdmin = async (req: Request, res: Response, next: any) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      // Check if user has admin role in database
      const result = await db.query('SELECT is_admin, role FROM users WHERE id = $1', [user.id]);

      if (!result.rows[0]?.is_admin && result.rows[0]?.role !== 'administrator') {
        logger.warn('Non-admin user attempted to access admin endpoint', {
          userId: user.id,
          email: user.email || 'unknown',
          endpoint: req.path,
          ip: req.ip,
        });
        return res.status(403).json({ error: 'Admin access required' });
      }

      next();
    } catch (error: any) {
      logger.error('Error checking admin status', { error: error.message, userId: user.id });
      res.status(500).json({ error: 'Failed to verify admin access' });
    }
  };

  /**
   * Log admin action to audit log
   */
  const logAdminAction = async (
    adminId: string,
    action: string,
    targetUserId: string | null,
    targetResourceId: string | null,
    details: any,
    req: Request
  ) => {
    try {
      await db.query(
        `INSERT INTO admin_audit_log
          (admin_id, action, target_user_id, target_resource_id, details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          adminId,
          action,
          targetUserId,
          targetResourceId,
          JSON.stringify(details),
          req.ip,
          req.headers['user-agent'] || null,
        ]
      );
    } catch (error: any) {
      logger.error('Failed to log admin action', { error: error.message, action });
    }
  };

  router.use(requireAdmin);

  // ========================================
  // DASHBOARD & STATISTICS
  // ========================================

  /**
   * GET /api/admin/stats/overview
   * Get dashboard overview statistics
   */
  router.get('/stats/overview', async (req: Request, res: Response) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // Today's revenue
      const todayRevenue = await db.query(`
        SELECT
          COALESCE(SUM(total_cost_usd), 0) as revenue_usd,
          COALESCE(SUM(markup_amount_usd), 0) as profit_usd,
          COUNT(*) as requests
        FROM cost_tracking
        WHERE DATE(created_at) = $1
      `, [today]);

      // This month's revenue
      const monthRevenue = await db.query(`
        SELECT
          COALESCE(SUM(total_cost_usd), 0) as revenue_usd,
          COALESCE(SUM(markup_amount_usd), 0) as profit_usd,
          COUNT(*) as requests
        FROM cost_tracking
        WHERE DATE(created_at) >= DATE_TRUNC('month', CURRENT_DATE)
      `);

      // Active users (made a request in last 30 days)
      const activeUsers = await db.query(`
        SELECT COUNT(DISTINCT user_id) as count
        FROM cost_tracking
        WHERE created_at >= $1
      `, [thirtyDaysAgo]);

      // Total users
      const totalUsers = await db.query('SELECT COUNT(*) as count FROM users');

      // Low balance alerts (< $5)
      const lowBalanceUsers = await db.query(`
        SELECT COUNT(*) as count
        FROM user_billing
        WHERE balance_usd < 5.00 AND balance_usd > 0
      `);

      // Failed requests today
      const failedRequests = await db.query(`
        SELECT COUNT(*) as count
        FROM cost_tracking
        WHERE DATE(created_at) = $1
          AND request_id IN (
            SELECT request_id FROM billing_transactions WHERE status = 'failed'
          )
      `, [today]);

      res.json({
        today: {
          revenue_usd: parseFloat(todayRevenue.rows[0].revenue_usd),
          profit_usd: parseFloat(todayRevenue.rows[0].profit_usd),
          requests: parseInt(todayRevenue.rows[0].requests),
        },
        month: {
          revenue_usd: parseFloat(monthRevenue.rows[0].revenue_usd),
          profit_usd: parseFloat(monthRevenue.rows[0].profit_usd),
          requests: parseInt(monthRevenue.rows[0].requests),
        },
        users: {
          total: parseInt(totalUsers.rows[0].count),
          active: parseInt(activeUsers.rows[0].count),
          low_balance: parseInt(lowBalanceUsers.rows[0].count),
        },
        alerts: {
          failed_requests_today: parseInt(failedRequests.rows[0].count),
        },
      });
    } catch (error: any) {
      logger.error('Failed to get admin overview stats', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve statistics' });
    }
  });

  /**
   * GET /api/admin/stats/revenue-chart
   * Get revenue data for charts (last 30 days)
   */
  router.get('/stats/revenue-chart', async (req: Request, res: Response) => {
    try {
      const days = Math.min(90, Math.max(7, Number(req.query.days || 30)));

      const result = await db.query(`
        SELECT
          DATE(created_at) as date,
          COALESCE(SUM(total_cost_usd), 0) as revenue_usd,
          COALESCE(SUM(CASE WHEN openai_cost_usd IS NOT NULL THEN openai_cost_usd ELSE 0 END), 0) as cost_usd,
          COALESCE(SUM(total_cost_usd), 0) - COALESCE(SUM(CASE WHEN openai_cost_usd IS NOT NULL THEN openai_cost_usd ELSE 0 END), 0) as profit_usd,
          COUNT(*) as requests
        FROM cost_tracking
        WHERE created_at >= CURRENT_DATE - $1::integer * INTERVAL '1 day'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `, [days]);

      res.json({
        data: result.rows.map((row: any) => ({
          date: row.date,
          revenue_usd: parseFloat(row.revenue_usd),
          cost_usd: parseFloat(row.cost_usd),
          profit_usd: parseFloat(row.profit_usd),
          requests: parseInt(row.requests),
        })),
      });
    } catch (error: any) {
      logger.error('Failed to get revenue chart data', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve chart data' });
    }
  });

  /**
   * GET /api/admin/stats/tier-distribution
   * Get user distribution across pricing tiers
   */
  router.get('/stats/tier-distribution', async (req: Request, res: Response) => {
    try {
      const result = await db.query(`
        SELECT
          pricing_tier,
          COUNT(*) as user_count,
          COALESCE(SUM(balance_usd), 0) as total_balance
        FROM user_billing
        GROUP BY pricing_tier
        ORDER BY user_count DESC
      `);

      res.json({
        tiers: result.rows.map((row: any) => ({
          tier: row.pricing_tier,
          user_count: parseInt(row.user_count),
          total_balance_usd: parseFloat(row.total_balance),
        })),
      });
    } catch (error: any) {
      logger.error('Failed to get tier distribution', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve tier distribution' });
    }
  });

  // ========================================
  // USER MANAGEMENT
  // ========================================

  /**
   * GET /api/admin/users
   * List all users with filtering and pagination
   */
  router.get('/users', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      const search = req.query.search as string | undefined;
      const tier = req.query.tier as string | undefined;
      const status = req.query.status as string | undefined;

      let whereClause = '1=1';
      const params: any[] = [];
      let paramCount = 0;

      if (search) {
        paramCount++;
        whereClause += ` AND (u.email ILIKE $${paramCount} OR u.name ILIKE $${paramCount} OR u.id::text ILIKE $${paramCount})`;
        params.push(`%${search}%`);
      }

      if (tier) {
        paramCount++;
        whereClause += ` AND ub.pricing_tier = $${paramCount}`;
        params.push(tier);
      }

      if (status === 'active') {
        whereClause += ` AND EXISTS (
          SELECT 1 FROM cost_tracking ct
          WHERE ct.user_id = u.id
            AND ct.created_at >= CURRENT_DATE - INTERVAL '30 days'
        )`;
      } else if (status === 'inactive') {
        whereClause += ` AND NOT EXISTS (
          SELECT 1 FROM cost_tracking ct
          WHERE ct.user_id = u.id
            AND ct.created_at >= CURRENT_DATE - INTERVAL '30 days'
        )`;
      }

      const result = await db.query(`
        SELECT
          u.id,
          u.email,
          u.name,
          u.created_at,
          ub.balance_usd,
          ub.total_spent_usd,
          ub.pricing_tier,
          ub.daily_limit_usd,
          ub.monthly_limit_usd,
          (
            SELECT COUNT(*)
            FROM cost_tracking ct
            WHERE ct.user_id = u.id
          ) as total_requests,
          (
            SELECT MAX(created_at)
            FROM cost_tracking ct
            WHERE ct.user_id = u.id
          ) as last_request_at
        FROM users u
        LEFT JOIN user_billing ub ON u.id = ub.user_id
        WHERE ${whereClause}
        ORDER BY u.created_at DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
      `, [...params, limit, offset]);

      const countResult = await db.query(`
        SELECT COUNT(*) as total
        FROM users u
        LEFT JOIN user_billing ub ON u.id = ub.user_id
        WHERE ${whereClause}
      `, params);

      res.json({
        users: result.rows.map((row: any) => ({
          id: row.id,
          email: row.email,
          name: row.name || null,
          created_at: row.created_at,
          balance_usd: parseFloat(row.balance_usd || 0),
          total_spent_usd: parseFloat(row.total_spent_usd || 0),
          pricing_tier: row.pricing_tier || 'startup',
          daily_limit_usd: parseFloat(row.daily_limit_usd || 0),
          monthly_limit_usd: parseFloat(row.monthly_limit_usd || 0),
          total_requests: parseInt(row.total_requests || 0),
          last_request_at: row.last_request_at,
        })),
        pagination: {
          limit,
          offset,
          total: parseInt(countResult.rows[0].total),
        },
      });
    } catch (error: any) {
      logger.error('Failed to list users', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve users' });
    }
  });

  /**
   * GET /api/admin/users/:userId
   * Get detailed user information
   */
  router.get('/users/:userId', async (req: Request, res: Response) => {
    try {
      const userId = getStringParam(req.params.userId);

      const userResult = await db.query(`
        SELECT
          u.id,
          u.email,
          u.created_at,
          ub.balance_usd,
          ub.total_spent_usd,
          ub.pricing_tier,
          ub.daily_limit_usd,
          ub.monthly_limit_usd,
          urp.*
        FROM users u
        LEFT JOIN user_billing ub ON u.id = ub.user_id
        LEFT JOIN user_request_preferences urp ON u.id = urp.user_id
        WHERE u.id = $1
      `, [userId]);

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Get recent transactions
      const transactions = await db.query(`
        SELECT *
        FROM billing_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 10
      `, [userId]);

      // Get usage stats
      const statsResult = await db.query(`
        SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(total_cost_usd), 0) as total_spent,
          COALESCE(AVG(total_cost_usd), 0) as avg_cost,
          MAX(created_at) as last_request
        FROM cost_tracking
        WHERE user_id = $1
      `, [userId]);

      res.json({
        user: userResult.rows[0],
        transactions: transactions.rows,
        stats: statsResult.rows[0],
      });
    } catch (error: any) {
      logger.error('Failed to get user details', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve user details' });
    }
  });

  /**
   * PUT /api/admin/users/:userId/tier
   * Update user's pricing tier
   */
  router.put('/users/:userId/tier', async (req: Request, res: Response) => {
    try {
      const userId = getStringParam(req.params.userId);
      const { tier } = req.body;

      if (!['free', 'startup', 'business', 'enterprise', 'internal'].includes(tier)) {
        return res.status(400).json({ error: 'Invalid pricing tier' });
      }

      // Get old tier for audit log
      const oldTierResult = await db.query(
        'SELECT pricing_tier FROM user_billing WHERE user_id = $1',
        [userId]
      );
      const oldTier = oldTierResult.rows[0]?.pricing_tier;

      await db.query(
        'UPDATE user_billing SET pricing_tier = $1, updated_at = NOW() WHERE user_id = $2',
        [tier, userId]
      );

      // Log admin action
      await logAdminAction(
        (req as any).user.id,
        'update_tier',
        userId,
        null,
        { old_tier: oldTier, new_tier: tier },
        req
      );

      logger.info('Admin updated user pricing tier', { userId, tier, admin: (req as any).user?.id });

      res.json({ success: true, message: 'Pricing tier updated' });
    } catch (error: any) {
      logger.error('Failed to update user tier', { error: error.message });
      res.status(500).json({ error: 'Failed to update tier' });
    }
  });

  /**
   * POST /api/admin/users/:userId/adjust-balance
   * Adjust user's balance (add/subtract funds)
   */
  router.post('/users/:userId/adjust-balance', async (req: Request, res: Response) => {
    try {
      const userId = getStringParam(req.params.userId);
      const { amount, reason } = req.body;

      if (typeof amount !== 'number' || isNaN(amount)) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      const result = await db.query(
        `UPDATE user_billing
         SET balance_usd = balance_usd + $1, updated_at = NOW()
         WHERE user_id = $2
         RETURNING balance_usd`,
        [amount, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Create transaction record
      await db.query(`
        INSERT INTO billing_transactions
          (user_id, transaction_type, amount_usd, status, metadata)
        VALUES ($1, $2, $3, 'completed', $4)
      `, [
        userId,
        amount > 0 ? 'admin_credit' : 'admin_debit',
        Math.abs(amount),
        JSON.stringify({ reason, admin_id: (req as any).user?.id }),
      ]);

      // Log admin action
      await logAdminAction(
        (req as any).user.id,
        'adjust_balance',
        userId,
        null,
        { amount, reason, new_balance: parseFloat(result.rows[0].balance_usd) },
        req
      );

      logger.info('Admin adjusted user balance', {
        userId,
        amount,
        reason,
        admin: (req as any).user?.id
      });

      res.json({
        success: true,
        new_balance_usd: parseFloat(result.rows[0].balance_usd)
      });
    } catch (error: any) {
      logger.error('Failed to adjust balance', { error: error.message });
      res.status(500).json({ error: 'Failed to adjust balance' });
    }
  });

  /**
   * PUT /api/admin/users/:userId/limits
   * Update user's daily/monthly limits
   */
  router.put('/users/:userId/limits', async (req: Request, res: Response) => {
    try {
      const userId = getStringParam(req.params.userId);
      const { dailyLimitUsd, monthlyLimitUsd } = req.body;

      const updates: string[] = [];
      const params: any[] = [];
      let paramCount = 0;

      if (dailyLimitUsd !== undefined) {
        paramCount++;
        updates.push(`daily_limit_usd = $${paramCount}`);
        params.push(Number(dailyLimitUsd));
      }

      if (monthlyLimitUsd !== undefined) {
        paramCount++;
        updates.push(`monthly_limit_usd = $${paramCount}`);
        params.push(Number(monthlyLimitUsd));
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No limits provided' });
      }

      paramCount++;
      params.push(userId);

      await db.query(
        `UPDATE user_billing
         SET ${updates.join(', ')}, updated_at = NOW()
         WHERE user_id = $${paramCount}`,
        params
      );

      // Log admin action
      await logAdminAction(
        (req as any).user.id,
        'update_limits',
        userId,
        null,
        { daily_limit_usd: dailyLimitUsd, monthly_limit_usd: monthlyLimitUsd },
        req
      );

      logger.info('Admin updated user limits', { userId, dailyLimitUsd, monthlyLimitUsd });

      res.json({ success: true, message: 'Limits updated' });
    } catch (error: any) {
      logger.error('Failed to update limits', { error: error.message });
      res.status(500).json({ error: 'Failed to update limits' });
    }
  });

  // ========================================
  // TRANSACTION MANAGEMENT
  // ========================================

  /**
   * GET /api/admin/transactions
   * List all transactions with filtering
   */
  router.get('/transactions', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      const type = req.query.type as string | undefined;
      const status = req.query.status as string | undefined;
      const userId = req.query.userId as string | undefined;

      let whereClause = '1=1';
      const params: any[] = [];
      let paramCount = 0;

      if (type) {
        paramCount++;
        whereClause += ` AND transaction_type = $${paramCount}`;
        params.push(type);
      }

      if (status) {
        paramCount++;
        whereClause += ` AND status = $${paramCount}`;
        params.push(status);
      }

      if (userId) {
        paramCount++;
        whereClause += ` AND user_id = $${paramCount}`;
        params.push(userId);
      }

      const result = await db.query(`
        SELECT
          bt.*,
          u.email as user_email
        FROM billing_transactions bt
        JOIN users u ON bt.user_id = u.id
        WHERE ${whereClause}
        ORDER BY bt.created_at DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
      `, [...params, limit, offset]);

      const countResult = await db.query(`
        SELECT COUNT(*) as total
        FROM billing_transactions bt
        WHERE ${whereClause}
      `, params);

      res.json({
        transactions: result.rows,
        pagination: {
          limit,
          offset,
          total: parseInt(countResult.rows[0].total),
        },
      });
    } catch (error: any) {
      logger.error('Failed to list transactions', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve transactions' });
    }
  });

  /**
   * POST /api/admin/transactions/:transactionId/refund
   * Refund a transaction
   */
  router.post('/transactions/:transactionId/refund', async (req: Request, res: Response) => {
    try {
      const transactionId = getStringParam(req.params.transactionId);
      const { reason } = req.body;

      const txResult = await db.query(
        'SELECT * FROM billing_transactions WHERE id = $1',
        [transactionId]
      );

      if (txResult.rows.length === 0) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      const transaction = txResult.rows[0];

      if (transaction.status === 'refunded') {
        return res.status(400).json({ error: 'Transaction already refunded' });
      }

      // Update transaction status
      await db.query(
        `UPDATE billing_transactions
         SET status = 'refunded',
             metadata = COALESCE(metadata, '{}'::jsonb) || $1
         WHERE id = $2`,
        [
          JSON.stringify({
            refund_reason: reason,
            refunded_by: (req as any).user?.id,
            refunded_at: new Date().toISOString()
          }),
          transactionId
        ]
      );

      // Refund balance
      await db.query(
        'UPDATE user_billing SET balance_usd = balance_usd + $1 WHERE user_id = $2',
        [transaction.amount_usd, transaction.user_id]
      );

      // Log admin action
      await logAdminAction(
        (req as any).user.id,
        'refund_transaction',
        transaction.user_id,
        transactionId,
        { amount: transaction.amount_usd, reason, transaction_type: transaction.transaction_type },
        req
      );

      logger.info('Admin refunded transaction', {
        transactionId,
        userId: transaction.user_id,
        amount: transaction.amount_usd,
        reason
      });

      res.json({ success: true, message: 'Transaction refunded' });
    } catch (error: any) {
      logger.error('Failed to refund transaction', { error: error.message });
      res.status(500).json({ error: 'Failed to refund transaction' });
    }
  });

  // ========================================
  // ANALYTICS & REPORTS
  // ========================================

  /**
   * GET /api/admin/analytics/cohorts
   * Analyze user cohorts by signup month
   */
  router.get('/analytics/cohorts', async (req: Request, res: Response) => {
    try {
      const result = await db.query(`
        SELECT
          DATE_TRUNC('month', u.created_at) as cohort_month,
          COUNT(*) as users,
          COUNT(DISTINCT ct.user_id) as active_users,
          COALESCE(SUM(ct.total_cost_usd), 0) as total_revenue
        FROM users u
        LEFT JOIN cost_tracking ct ON u.id = ct.user_id
        GROUP BY DATE_TRUNC('month', u.created_at)
        ORDER BY cohort_month DESC
        LIMIT 12
      `);

      res.json({
        cohorts: result.rows.map((row: any) => ({
          month: row.cohort_month,
          users: parseInt(row.users),
          active_users: parseInt(row.active_users),
          total_revenue_usd: parseFloat(row.total_revenue),
          retention_rate: (parseInt(row.active_users) / parseInt(row.users)) * 100,
        })),
      });
    } catch (error: any) {
      logger.error('Failed to get cohort analytics', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve cohort data' });
    }
  });

  /**
   * GET /api/admin/analytics/usage
   * Get usage statistics by tool/feature
   */
  router.get('/analytics/usage', async (req: Request, res: Response) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query.days || 30)));

      const result = await db.query(`
        SELECT
          tool_name,
          COUNT(*) as request_count,
          COALESCE(SUM(total_cost_usd), 0) as total_revenue,
          COALESCE(AVG(total_cost_usd), 0) as avg_cost
        FROM cost_tracking
        WHERE created_at >= CURRENT_DATE - $1::integer * INTERVAL '1 day'
          AND tool_name IS NOT NULL
        GROUP BY tool_name
        ORDER BY request_count DESC
      `, [days]);

      res.json({
        usage: result.rows.map((row: any) => ({
          tool_name: row.tool_name,
          request_count: parseInt(row.request_count),
          total_revenue_usd: parseFloat(row.total_revenue),
          avg_cost_usd: parseFloat(row.avg_cost),
        })),
      });
    } catch (error: any) {
      logger.error('Failed to get usage analytics', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve usage data' });
    }
  });

  // ========================================
  // API KEY MANAGEMENT
  // ========================================

  /**
   * GET /api/admin/api-keys
   * List all API keys
   */
  router.get('/api-keys', async (req: Request, res: Response) => {
    try {
      // TODO: Implement API key storage in database
      // For now, return placeholder
      res.json({
        message: 'API key management not yet implemented',
        keys: [],
      });
    } catch (error: any) {
      logger.error('Failed to list API keys', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve API keys' });
    }
  });

  // ========================================
  // SYSTEM SETTINGS
  // ========================================

  /**
   * GET /api/admin/settings
   * Get system settings
   */
  router.get('/settings', async (req: Request, res: Response) => {
    try {
      // Get pricing tier configs (DB-backed)
      const tiers = await pricing.getAllTiersAsync();

      // Get presets
      const presets = await preferencesService.getAllPresets();

      res.json({
        pricing_tiers: tiers,
        request_presets: presets,
      });
    } catch (error: any) {
      logger.error('Failed to get settings', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve settings' });
    }
  });

  // ========================================
  // PROMETHEUS METRICS
  // ========================================

  /**
   * GET /api/admin/metrics/traffic
   * Request rate & error rate time-series
   * Query params: range=1h|6h|24h (default 1h)
   */
  router.get('/metrics/traffic', async (req: Request, res: Response) => {
    try {
      const range = (req.query.range as string) || '1h';
      const rangeSeconds: Record<string, number> = { '1h': 3600, '6h': 21600, '24h': 86400 };
      const seconds = rangeSeconds[range] || 3600;
      const step = seconds <= 3600 ? '30s' : seconds <= 21600 ? '2m' : '5m';
      const end = Math.floor(Date.now() / 1000);
      const start = end - seconds;

      const [rpsResults, errorResults] = await Promise.all([
        prometheus.queryRange(
          'sum(rate(http_requests_total[1m]))',
          start, end, step
        ),
        prometheus.queryRange(
          'sum(rate(http_requests_total{status_code=~"5.."}[1m]))',
          start, end, step
        ),
      ]);

      const rps = rpsResults[0]?.values?.map(([ts, val]) => ({
        timestamp: ts,
        value: parseFloat(val) || 0,
      })) || [];

      const errors = errorResults[0]?.values?.map(([ts, val]) => ({
        timestamp: ts,
        value: parseFloat(val) || 0,
      })) || [];

      res.json({ rps, errors, range });
    } catch (error: any) {
      logger.error('Failed to get traffic metrics', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve traffic metrics' });
    }
  });

  /**
   * GET /api/admin/metrics/latency
   * P50/P95/P99 latency time-series
   * Query params: range=1h|6h|24h (default 1h)
   */
  router.get('/metrics/latency', async (req: Request, res: Response) => {
    try {
      const range = (req.query.range as string) || '1h';
      const rangeSeconds: Record<string, number> = { '1h': 3600, '6h': 21600, '24h': 86400 };
      const seconds = rangeSeconds[range] || 3600;
      const step = seconds <= 3600 ? '30s' : seconds <= 21600 ? '2m' : '5m';
      const end = Math.floor(Date.now() / 1000);
      const start = end - seconds;

      const [p50Results, p95Results, p99Results] = await Promise.all([
        prometheus.queryRange(
          'histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))',
          start, end, step
        ),
        prometheus.queryRange(
          'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))',
          start, end, step
        ),
        prometheus.queryRange(
          'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))',
          start, end, step
        ),
      ]);

      const format = (results: any[]) =>
        results[0]?.values?.map(([ts, val]: [number, string]) => ({
          timestamp: ts,
          value: (parseFloat(val) || 0) * 1000, // convert to ms
        })) || [];

      res.json({
        p50: format(p50Results),
        p95: format(p95Results),
        p99: format(p99Results),
        range,
      });
    } catch (error: any) {
      logger.error('Failed to get latency metrics', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve latency metrics' });
    }
  });

  /**
   * GET /api/admin/metrics/services
   * Service health: up/down per service
   */
  router.get('/metrics/services', async (req: Request, res: Response) => {
    try {
      const upResults = await prometheus.queryInstant('up');

      const services = upResults.map((r) => ({
        job: r.metric.job || r.metric.instance || 'unknown',
        instance: r.metric.instance || '',
        up: r.value[1] === '1',
      }));

      res.json({ services });
    } catch (error: any) {
      logger.error('Failed to get service health', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve service health' });
    }
  });

  /**
   * GET /api/admin/metrics/system
   * System gauges: PG pool, Redis memory, upload queue depth
   */
  router.get('/metrics/system', async (req: Request, res: Response) => {
    try {
      const [pgPool, redisMem, redisMaxMem, uploadQueue] = await Promise.all([
        prometheus.queryInstant('pg_pool_active_connections'),
        prometheus.queryInstant('redis_memory_used_bytes'),
        prometheus.queryInstant('redis_memory_max_bytes'),
        prometheus.queryInstant('upload_queue_depth'),
      ]);

      const pgActive = parseFloat(pgPool[0]?.value?.[1] || '0');
      const pgMax = 500; // from PG config
      const redisUsed = parseFloat(redisMem[0]?.value?.[1] || '0');
      const redisMax = parseFloat(redisMaxMem[0]?.value?.[1] || '1');
      const queueDepth = parseFloat(uploadQueue[0]?.value?.[1] || '0');

      res.json({
        pg_pool: { active: pgActive, max: pgMax, utilization_pct: (pgActive / pgMax) * 100 },
        redis: {
          used_bytes: redisUsed,
          max_bytes: redisMax,
          utilization_pct: redisMax > 0 ? (redisUsed / redisMax) * 100 : 0,
        },
        upload_queue: { depth: queueDepth },
      });
    } catch (error: any) {
      logger.error('Failed to get system metrics', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve system metrics' });
    }
  });

  // ========================================
  // COST BREAKDOWN
  // ========================================

  /**
   * GET /api/admin/stats/cost-breakdown
   * Detailed cost breakdown by provider, model, and day
   * Query params: days=30 (7-90)
   */
  router.get('/stats/cost-breakdown', async (req: Request, res: Response) => {
    try {
      const days = Math.min(90, Math.max(7, Number(req.query.days || 30)));
      const interval = `${days} days`;

      // 1. Totals
      const totalsResult = await db.query(`
        SELECT
          COALESCE(SUM(openai_cost_usd), 0) as openai_cost,
          COALESCE(SUM(anthropic_cost_usd), 0) as anthropic_cost,
          COALESCE(SUM(zakononline_cost_usd), 0) as zakononline_cost,
          COALESCE(SUM(secondlayer_cost_usd), 0) as secondlayer_cost,
          COALESCE(SUM(openai_cost_usd), 0) + COALESCE(SUM(anthropic_cost_usd), 0) +
            COALESCE(SUM(zakononline_cost_usd), 0) + COALESCE(SUM(secondlayer_cost_usd), 0) as total_cost,
          COUNT(*) as total_requests
        FROM cost_tracking
        WHERE created_at >= NOW() - $1::interval
          AND status = 'completed'
      `, [interval]);

      const totals = totalsResult.rows[0];

      // 2. By provider (with token counts from JSONB)
      const openaiTokensResult = await db.query(`
        SELECT
          COALESCE(SUM((elem->>'tokens')::numeric), 0) as tokens,
          COUNT(*) as calls
        FROM cost_tracking,
          jsonb_array_elements(CASE WHEN openai_calls IS NOT NULL AND openai_calls != 'null'::jsonb AND jsonb_typeof(openai_calls) = 'array' THEN openai_calls ELSE '[]'::jsonb END) AS elem
        WHERE created_at >= NOW() - $1::interval
          AND status = 'completed'
      `, [interval]);

      const anthropicTokensResult = await db.query(`
        SELECT
          COALESCE(SUM((elem->>'tokens')::numeric), 0) as tokens,
          COUNT(*) as calls
        FROM cost_tracking,
          jsonb_array_elements(CASE WHEN anthropic_calls IS NOT NULL AND anthropic_calls != 'null'::jsonb AND jsonb_typeof(anthropic_calls) = 'array' THEN anthropic_calls ELSE '[]'::jsonb END) AS elem
        WHERE created_at >= NOW() - $1::interval
          AND status = 'completed'
      `, [interval]);

      const zoCallsResult = await db.query(`
        SELECT COALESCE(SUM(zakononline_api_calls), 0) as calls
        FROM cost_tracking
        WHERE created_at >= NOW() - $1::interval
          AND status = 'completed'
      `, [interval]);

      const byProvider = [
        {
          provider: 'OpenAI',
          cost_usd: parseFloat(totals.openai_cost),
          requests: parseInt(openaiTokensResult.rows[0]?.calls || '0'),
          tokens: parseInt(openaiTokensResult.rows[0]?.tokens || '0'),
        },
        {
          provider: 'Anthropic',
          cost_usd: parseFloat(totals.anthropic_cost),
          requests: parseInt(anthropicTokensResult.rows[0]?.calls || '0'),
          tokens: parseInt(anthropicTokensResult.rows[0]?.tokens || '0'),
        },
        {
          provider: 'ZakonOnline',
          cost_usd: parseFloat(totals.zakononline_cost),
          calls: parseInt(zoCallsResult.rows[0]?.calls || '0'),
        },
        {
          provider: 'SecondLayer API',
          cost_usd: parseFloat(totals.secondlayer_cost),
          calls: parseInt(totals.total_requests),
        },
      ];

      // 3. By model (unpack JSONB arrays)
      const byModelResult = await db.query(`
        WITH openai_models AS (
          SELECT
            'OpenAI' as provider,
            elem->>'model' as model,
            COALESCE((elem->>'cost')::numeric, 0) as cost,
            COALESCE((elem->>'tokens')::numeric, 0) as tokens
          FROM cost_tracking,
            jsonb_array_elements(CASE WHEN openai_calls IS NOT NULL AND openai_calls != 'null'::jsonb AND jsonb_typeof(openai_calls) = 'array' THEN openai_calls ELSE '[]'::jsonb END) AS elem
          WHERE created_at >= NOW() - $1::interval
            AND status = 'completed'
        ),
        anthropic_models AS (
          SELECT
            'Anthropic' as provider,
            elem->>'model' as model,
            COALESCE((elem->>'cost')::numeric, 0) as cost,
            COALESCE((elem->>'tokens')::numeric, 0) as tokens
          FROM cost_tracking,
            jsonb_array_elements(CASE WHEN anthropic_calls IS NOT NULL AND anthropic_calls != 'null'::jsonb AND jsonb_typeof(anthropic_calls) = 'array' THEN anthropic_calls ELSE '[]'::jsonb END) AS elem
          WHERE created_at >= NOW() - $1::interval
            AND status = 'completed'
        ),
        all_models AS (
          SELECT * FROM openai_models
          UNION ALL
          SELECT * FROM anthropic_models
        )
        SELECT
          provider,
          model,
          SUM(cost) as cost_usd,
          SUM(tokens) as tokens,
          COUNT(*) as requests
        FROM all_models
        WHERE model IS NOT NULL
        GROUP BY provider, model
        ORDER BY cost_usd DESC
      `, [interval]);

      const byModel = byModelResult.rows.map((row: any) => ({
        provider: row.provider,
        model: row.model,
        cost_usd: parseFloat(row.cost_usd),
        tokens: parseInt(row.tokens),
        requests: parseInt(row.requests),
      }));

      // 4. Daily breakdown
      const dailyResult = await db.query(`
        SELECT
          DATE(created_at) as date,
          COALESCE(SUM(openai_cost_usd), 0) as openai,
          COALESCE(SUM(anthropic_cost_usd), 0) as anthropic,
          COALESCE(SUM(zakononline_cost_usd), 0) as zakononline,
          COALESCE(SUM(secondlayer_cost_usd), 0) as secondlayer
        FROM cost_tracking
        WHERE created_at >= NOW() - $1::interval
          AND status = 'completed'
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `, [interval]);

      const daily = dailyResult.rows.map((row: any) => ({
        date: row.date,
        openai: parseFloat(row.openai),
        anthropic: parseFloat(row.anthropic),
        zakononline: parseFloat(row.zakononline),
        secondlayer: parseFloat(row.secondlayer),
      }));

      const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const toDate = new Date().toISOString().split('T')[0];

      res.json({
        period: { from: fromDate, to: toDate, days },
        totals: {
          openai_cost_usd: parseFloat(totals.openai_cost),
          anthropic_cost_usd: parseFloat(totals.anthropic_cost),
          zakononline_cost_usd: parseFloat(totals.zakononline_cost),
          secondlayer_cost_usd: parseFloat(totals.secondlayer_cost),
          total_cost_usd: parseFloat(totals.total_cost),
          total_requests: parseInt(totals.total_requests),
        },
        by_provider: byProvider,
        by_model: byModel,
        daily,
      });
    } catch (error: any) {
      logger.error('Failed to get cost breakdown', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve cost breakdown' });
    }
  });

  // ========================================
  // DATA SOURCES MONITORING
  // ========================================

  /**
   * GET /api/admin/data-sources
   * Returns status of all external data sources for the admin monitoring dashboard
   */
  // Helper: fetch backend table stats
  const getBackendStats = async () => {
    const backendQueries = [
      { id: 'documents', name: 'Документи (судові рішення)', query: "SELECT COUNT(*) as cnt, MAX(updated_at) as lu, COUNT(*) FILTER (WHERE updated_at::date = (SELECT MAX(updated_at)::date FROM documents)) as lb FROM documents", source: 'ZakonOnline API', sourceUrl: 'https://zakononline.com.ua', frequency: 'За запитом (кеш 7 днів)' },
      { id: 'document_sections', name: 'Секції документів', query: "SELECT COUNT(*) as cnt, MAX(created_at) as lu, COUNT(*) FILTER (WHERE created_at::date = (SELECT MAX(created_at)::date FROM document_sections)) as lb FROM document_sections", source: 'SemanticSectionizer (автоматично)', sourceUrl: '', frequency: 'При завантаженні документа' },
      { id: 'embedding_chunks', name: 'Вектори (embeddings)', query: "SELECT COUNT(*) as cnt, MAX(created_at) as lu, COUNT(*) FILTER (WHERE created_at::date = (SELECT MAX(created_at)::date FROM embedding_chunks)) as lb FROM embedding_chunks", source: 'OpenAI text-embedding-3-small', sourceUrl: 'https://platform.openai.com', frequency: 'При обробці документа' },
      { id: 'legislation', name: 'Кодекси та закони', query: "SELECT COUNT(*) as cnt, MAX(updated_at) as lu, COUNT(*) FILTER (WHERE updated_at::date = (SELECT MAX(updated_at)::date FROM legislation)) as lb FROM legislation", source: 'Верховна Рада API', sourceUrl: 'https://zakon.rada.gov.ua/api', frequency: 'Ручний синхр. (кеш 30 днів)' },
      { id: 'legislation_articles', name: 'Статті законодавства', query: "SELECT COUNT(*) as cnt, MAX(updated_at) as lu, COUNT(*) FILTER (WHERE updated_at::date = (SELECT MAX(updated_at)::date FROM legislation_articles)) as lb FROM legislation_articles", source: 'Верховна Рада API', sourceUrl: 'https://zakon.rada.gov.ua/api', frequency: 'Ручний синхр. (get_legislation_structure)' },
      { id: 'zo_dictionaries', name: 'Довідники ZakonOnline', query: "SELECT COUNT(*) as cnt, MAX(updated_at) as lu, COUNT(*) FILTER (WHERE updated_at::date = (SELECT MAX(updated_at)::date FROM zo_dictionaries)) as lb FROM zo_dictionaries", source: 'ZakonOnline API', sourceUrl: 'https://zakononline.com.ua', frequency: 'Ручний синхр. (sync-dictionaries.ts)' },
      { id: 'conversations', name: 'Розмови (чат)', query: "SELECT COUNT(*) as cnt, MAX(updated_at) as lu, COUNT(*) FILTER (WHERE updated_at::date = (SELECT MAX(updated_at)::date FROM conversations)) as lb FROM conversations", source: 'Дії користувачів', sourceUrl: '', frequency: 'Реальний час' },
      { id: 'conversation_messages', name: 'Повідомлення чату', query: "SELECT COUNT(*) as cnt, MAX(created_at) as lu, COUNT(*) FILTER (WHERE created_at::date = (SELECT MAX(created_at)::date FROM conversation_messages)) as lb FROM conversation_messages", source: 'AI + користувачі', sourceUrl: '', frequency: 'Реальний час' },
      { id: 'users', name: 'Користувачі', query: "SELECT COUNT(*) as cnt, MAX(created_at) as lu, COUNT(*) FILTER (WHERE created_at::date = (SELECT MAX(created_at)::date FROM users)) as lb FROM users", source: 'Google OAuth', sourceUrl: '', frequency: 'При реєстрації' },
      { id: 'cost_tracking', name: 'Трекінг витрат API', query: "SELECT COUNT(*) as cnt, MAX(created_at) as lu, COUNT(*) FILTER (WHERE created_at::date = (SELECT MAX(created_at)::date FROM cost_tracking)) as lb FROM cost_tracking", source: 'CostTracker (автоматично)', sourceUrl: '', frequency: 'Кожен API виклик' },
      { id: 'clients', name: 'Клієнти', query: "SELECT COUNT(*) as cnt, MAX(created_at) as lu, COUNT(*) FILTER (WHERE created_at::date = (SELECT MAX(created_at)::date FROM clients)) as lb FROM clients", source: 'Дії адміністратора', sourceUrl: '', frequency: 'При створенні' },
      { id: 'matters', name: 'Справи', query: "SELECT COUNT(*) as cnt, MAX(created_at) as lu, COUNT(*) FILTER (WHERE created_at::date = (SELECT MAX(created_at)::date FROM matters)) as lb FROM matters", source: 'Дії юристів', sourceUrl: '', frequency: 'При створенні' },
      { id: 'upload_sessions', name: 'Сесії завантаження', query: "SELECT COUNT(*) as cnt, MAX(updated_at) as lu, COUNT(*) FILTER (WHERE updated_at::date = (SELECT MAX(updated_at)::date FROM upload_sessions)) as lb FROM upload_sessions", source: 'UploadService', sourceUrl: '', frequency: 'При завантаженні файлів' },
    ];

    const tables = [];
    for (const q of backendQueries) {
      try {
        const result = await db.query(q.query);
        tables.push({
          id: q.id, name: q.name,
          rows: parseInt(result.rows[0]?.cnt || '0'),
          source: q.source, sourceUrl: q.sourceUrl,
          updateFrequency: q.frequency,
          lastUpdate: result.rows[0]?.lu || null,
          lastBatchCount: parseInt(result.rows[0]?.lb || '0'),
        });
      } catch {
        tables.push({
          id: q.id, name: q.name, rows: 0,
          source: q.source, sourceUrl: q.sourceUrl,
          updateFrequency: q.frequency, lastUpdate: null, lastBatchCount: 0,
        });
      }
    }

    let dbSizeMb = 0;
    try {
      const sizeResult = await db.query("SELECT pg_database_size(current_database()) as size_bytes");
      dbSizeMb = Math.round(parseInt(sizeResult.rows[0]?.size_bytes || '0') / 1024 / 1024);
    } catch { /* ignore */ }

    return { tables, dbSizeMb, timestamp: new Date().toISOString() };
  };

  // Helper: fetch from external service with timeout
  const fetchServiceStats = async (url: string, serviceName: string, timeoutMs = 30000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (e: any) {
      return { service: serviceName, tables: {}, dbSizeMb: 0, error: e.message, timestamp: new Date().toISOString() };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * GET /api/admin/data-sources?section=backend|rada|openreyestr
   * With section param: returns only that section (for progressive loading)
   * Without section param: returns all sections (backwards compat)
   */
  router.get('/data-sources', async (req: Request, res: Response) => {
    try {
      const section = req.query.section as string | undefined;
      const radaUrl = process.env.RADA_MCP_URL || 'http://rada-mcp-app-local:3001';
      const openreyestrUrl = process.env.OPENREYESTR_MCP_URL || 'http://openreyestr-app-local:3004';

      if (section === 'backend') {
        return res.json(await getBackendStats());
      }

      if (section === 'rada') {
        return res.json(await fetchServiceStats(`${radaUrl}/api/stats`, 'rada'));
      }

      if (section === 'openreyestr') {
        return res.json(await fetchServiceStats(`${openreyestrUrl}/api/stats`, 'openreyestr'));
      }

      // Full response (no section)
      const [backend, rada, openreyestr] = await Promise.all([
        getBackendStats(),
        fetchServiceStats(`${radaUrl}/api/stats`, 'rada'),
        fetchServiceStats(`${openreyestrUrl}/api/stats`, 'openreyestr'),
      ]);

      res.json({ backend, rada, openreyestr, timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      logger.error('Failed to get data sources status', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve data sources status' });
    }
  });

  // ========================================
  // RECENT COURT DOCUMENTS BY PRACTICE AREA
  // ========================================

  /**
   * GET /api/admin/court-documents/recent
   * Returns recent court documents grouped by justice_kind (вид права / вид судочинства)
   * Uses metadata->>'justice_kind' for ZO docs, falls back to dispute_category text for scraped docs
   * Query params:
   *   days - number of days to look back (default 30, max 365)
   *   limit - max documents per category (default 5, max 20)
   */
  router.get('/court-documents/recent', async (req: Request, res: Response) => {
    try {
      const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
      const limitPerCategory = Math.min(20, Math.max(1, Number(req.query.limit || 5)));

      // 1. Load justiceKinds dictionary: justice_kind id -> name
      //    justiceKinds maps justice_kind numeric id to broad category name
      const kindNames: Record<string, string> = {};
      try {
        const dictResult = await db.query(`
          SELECT data FROM zo_dictionaries
          WHERE dictionary_name = 'justiceKinds' AND domain = 'court_decisions'
          LIMIT 1
        `);
        if (dictResult.rows[0]?.data) {
          const items = dictResult.rows[0].data;
          if (Array.isArray(items)) {
            for (const item of items) {
              if (item.justice_kind != null && item.name) {
                kindNames[String(item.justice_kind)] = item.name;
              }
            }
          }
        }
      } catch { /* dictionary not available */ }

      // 2. Get summary stats grouped by justice_kind
      //    ZO docs have metadata->>'justice_kind', scraped docs have text in dispute_category
      const summaryResult = await db.query(`
        SELECT
          COALESCE(metadata->>'justice_kind', 'other') as kind,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE created_at >= NOW() - $1::integer * INTERVAL '1 day') as recent,
          MIN(date) as earliest_date,
          MAX(date) as latest_date,
          MAX(created_at) as last_loaded_at
        FROM documents
        WHERE type = 'court_decision'
        GROUP BY COALESCE(metadata->>'justice_kind', 'other')
        ORDER BY recent DESC, total DESC
      `, [days]);

      // 3. Get recent documents per kind
      const recentResult = await db.query(`
        WITH ranked AS (
          SELECT
            id, title, date, court, case_number, dispute_category,
            COALESCE(metadata->>'justice_kind', 'other') as kind,
            created_at,
            ROW_NUMBER() OVER (PARTITION BY COALESCE(metadata->>'justice_kind', 'other') ORDER BY created_at DESC) as rn
          FROM documents
          WHERE type = 'court_decision'
            AND created_at >= NOW() - $1::integer * INTERVAL '1 day'
        )
        SELECT * FROM ranked WHERE rn <= $2
        ORDER BY kind, created_at DESC
      `, [days, limitPerCategory]);

      // 4. Totals
      const totalsResult = await db.query(`
        SELECT
          COUNT(*) as total_court_docs,
          COUNT(*) FILTER (WHERE created_at >= NOW() - $1::integer * INTERVAL '1 day') as recent_court_docs
        FROM documents
        WHERE type = 'court_decision'
      `, [days]);

      // Build grouped response
      const categories = summaryResult.rows.map((row: any) => {
        const kind = row.kind;
        let name: string;
        if (kindNames[kind]) {
          name = kindNames[kind];
        } else if (kind === 'other') {
          name = 'Реєстр судових рішень';
        } else {
          name = `Вид ${kind}`;
        }

        return {
          code: kind,
          name,
          total: parseInt(row.total),
          recent: parseInt(row.recent),
          earliest_date: row.earliest_date,
          latest_date: row.latest_date,
          last_loaded_at: row.last_loaded_at,
          documents: recentResult.rows
            .filter((d: any) => d.kind === kind)
            .map((d: any) => ({
              id: d.id,
              title: d.title,
              date: d.date,
              court: d.court,
              case_number: d.case_number,
              dispute_category: d.dispute_category,
              loaded_at: d.created_at,
            })),
        };
      });

      res.json({
        total_court_docs: parseInt(totalsResult.rows[0]?.total_court_docs || '0'),
        recent_court_docs: parseInt(totalsResult.rows[0]?.recent_court_docs || '0'),
        days,
        categories,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      logger.error('Failed to get recent court documents', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve court document statistics' });
    }
  });

  // ========================================
  // DOCUMENT COMPLETENESS CHECK
  // ========================================

  const completenessRunCounts = new Map<string, number>();
  const MAX_COMPLETENESS_RUNS_PER_DAY = 5;

  router.post('/document-completeness-check', async (req: Request, res: Response) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const runsToday = completenessRunCounts.get(today) || 0;

      if (runsToday >= MAX_COMPLETENESS_RUNS_PER_DAY) {
        return res.status(429).json({
          error: `Ліміт вичерпано: ${MAX_COMPLETENESS_RUNS_PER_DAY}/${MAX_COMPLETENESS_RUNS_PER_DAY} перевірок сьогодні`,
          runs_today: runsToday,
          max_runs_per_day: MAX_COMPLETENESS_RUNS_PER_DAY,
        });
      }

      // Increment run count (clean up old dates)
      for (const key of completenessRunCounts.keys()) {
        if (key !== today) completenessRunCounts.delete(key);
      }
      completenessRunCounts.set(today, runsToday + 1);

      // Load justice_kind names from zo_dictionaries
      const kindNames: Record<string, string> = {};
      try {
        const dictResult = await db.query(`
          SELECT data FROM zo_dictionaries
          WHERE dictionary_name = 'justiceKinds' AND domain = 'court_decisions'
          LIMIT 1
        `);
        if (dictResult.rows[0]?.data) {
          const items = dictResult.rows[0].data;
          if (Array.isArray(items)) {
            for (const item of items) {
              if (item.justice_kind != null && item.name) {
                kindNames[String(item.justice_kind)] = item.name;
              }
            }
          }
        }
      } catch { /* dictionary not available */ }

      // Run completeness query
      const result = await db.query(`
        SELECT
          COALESCE(metadata->>'justice_kind', 'unknown') AS justice_kind,
          COUNT(*) AS total,
          COUNT(full_text) FILTER (WHERE full_text IS NOT NULL AND full_text != '') AS has_plaintext,
          COUNT(full_text_html) FILTER (WHERE full_text_html IS NOT NULL AND full_text_html != '') AS has_html,
          COUNT(*) FILTER (WHERE (full_text IS NULL OR full_text = '') AND (full_text_html IS NULL OR full_text_html = '')) AS missing_both,
          COUNT(*) FILTER (WHERE full_text IS NOT NULL AND full_text != '' AND full_text_html IS NOT NULL AND full_text_html != '') AS has_both
        FROM documents
        WHERE user_id IS NULL
        GROUP BY COALESCE(metadata->>'justice_kind', 'unknown')
        ORDER BY total DESC
      `);

      const byJusticeKind = result.rows.map((row: any) => {
        const total = parseInt(row.total);
        const hasBoth = parseInt(row.has_both);
        const kindCode = row.justice_kind;
        return {
          justice_kind: kindNames[kindCode] || (kindCode === 'unknown' ? 'Невідомий' : `Вид ${kindCode}`),
          justice_kind_code: kindCode,
          total,
          has_plaintext: parseInt(row.has_plaintext),
          has_html: parseInt(row.has_html),
          has_both: hasBoth,
          missing_both: parseInt(row.missing_both),
          completeness_pct: total > 0 ? Math.round((hasBoth / total) * 10000) / 100 : 0,
        };
      });

      // Compute totals
      let summary = { total_documents: 0, with_plaintext: 0, with_html: 0, with_both: 0, missing_both: 0 };
      for (const row of byJusticeKind) {
        summary = {
          total_documents: summary.total_documents + row.total,
          with_plaintext: summary.with_plaintext + row.has_plaintext,
          with_html: summary.with_html + row.has_html,
          with_both: summary.with_both + row.has_both,
          missing_both: summary.missing_both + row.missing_both,
        };
      }

      res.json({
        checked_at: new Date().toISOString(),
        runs_today: runsToday + 1,
        max_runs_per_day: MAX_COMPLETENESS_RUNS_PER_DAY,
        summary: {
          ...summary,
          completeness_pct: summary.total_documents > 0
            ? Math.round((summary.with_both / summary.total_documents) * 10000) / 100
            : 0,
        },
        by_justice_kind: byJusticeKind,
      });
    } catch (error: any) {
      logger.error('Failed to run document completeness check', { error: error.message });
      res.status(500).json({ error: 'Failed to run document completeness check' });
    }
  });

  // ========================================
  // BILLING MANAGEMENT (Pricing Tiers & Subscriptions)
  // ========================================

  /**
   * GET /api/admin/billing/tiers
   * List all billing tiers directly from billing_tiers table
   */
  router.get('/billing/tiers', async (_req: Request, res: Response) => {
    try {
      const result = await db.query(`
        SELECT id, tier_key, display_name, markup_percentage, description,
               features, default_daily_limit_usd, default_monthly_limit_usd,
               is_default, is_active, sort_order, created_at, updated_at
        FROM billing_tiers
        ORDER BY sort_order ASC, tier_key ASC
      `);
      const tiers = result.rows.map((row: any) => ({
        ...row,
        markup_percentage: parseFloat(row.markup_percentage),
        default_daily_limit_usd: parseFloat(row.default_daily_limit_usd),
        default_monthly_limit_usd: parseFloat(row.default_monthly_limit_usd),
        features: row.features || [],
      }));
      res.json({ tiers });
    } catch (error: any) {
      logger.error('Failed to get billing tiers', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve billing tiers' });
    }
  });

  /**
   * PUT /api/admin/billing/tiers/:idOrKey
   * Update a billing tier by UUID or tier_key
   */
  router.put('/billing/tiers/:idOrKey', async (req: Request, res: Response) => {
    try {
      const idOrKey = getStringParam(req.params.idOrKey);
      if (!idOrKey) return res.status(400).json({ error: 'Tier identifier is required' });

      const { display_name, markup_percentage, description, features, default_daily_limit_usd, default_monthly_limit_usd } = req.body;

      // Determine whether idOrKey is a UUID or a tier_key
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrKey);
      const whereClause = isUuid ? 'id = $1' : 'tier_key = $1';

      const updates: string[] = [];
      const params: any[] = [idOrKey];
      let paramCount = 1;

      if (display_name !== undefined) { paramCount++; updates.push(`display_name = $${paramCount}`); params.push(display_name); }
      if (markup_percentage !== undefined) { paramCount++; updates.push(`markup_percentage = $${paramCount}`); params.push(markup_percentage); }
      if (description !== undefined) { paramCount++; updates.push(`description = $${paramCount}`); params.push(description); }
      if (features !== undefined) { paramCount++; updates.push(`features = $${paramCount}`); params.push(JSON.stringify(features)); }
      if (default_daily_limit_usd !== undefined) { paramCount++; updates.push(`default_daily_limit_usd = $${paramCount}`); params.push(default_daily_limit_usd); }
      if (default_monthly_limit_usd !== undefined) { paramCount++; updates.push(`default_monthly_limit_usd = $${paramCount}`); params.push(default_monthly_limit_usd); }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      updates.push('updated_at = NOW()');

      const result = await db.query(
        `UPDATE billing_tiers SET ${updates.join(', ')} WHERE ${whereClause} RETURNING tier_key`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Tier not found' });
      }

      // Also update PricingService cache if available
      try { await pricing.updateTier(result.rows[0].tier_key, req.body); } catch { /* cache update is best-effort */ }

      await logAdminAction(
        (req as any).user.id,
        'update_billing_tier',
        null,
        idOrKey,
        req.body,
        req
      );

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Failed to update billing tier', { error: error.message });
      res.status(500).json({ error: 'Failed to update billing tier' });
    }
  });

  /**
   * PUT /api/admin/billing/tiers/:id/default
   * Set a tier as the default
   */
  router.put('/billing/tiers/:id/default', async (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Tier id is required' });

      await db.query('UPDATE billing_tiers SET is_default = false, updated_at = NOW()');
      const result = await db.query(
        'UPDATE billing_tiers SET is_default = true, updated_at = NOW() WHERE id = $1 RETURNING tier_key',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Tier not found' });
      }

      await logAdminAction(
        (req as any).user.id,
        'set_default_tier',
        null,
        id,
        { tier_key: result.rows[0].tier_key },
        req
      );

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Failed to set default tier', { error: error.message });
      res.status(500).json({ error: 'Failed to set default tier' });
    }
  });

  /**
   * DELETE /api/admin/billing/tiers/:id
   * Deactivate a billing tier (soft delete)
   */
  router.delete('/billing/tiers/:id', async (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Tier id is required' });

      const result = await db.query(
        'UPDATE billing_tiers SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING tier_key',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Tier not found' });
      }

      await logAdminAction(
        (req as any).user.id,
        'deactivate_billing_tier',
        null,
        id,
        { tier_key: result.rows[0].tier_key },
        req
      );

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Failed to deactivate billing tier', { error: error.message });
      res.status(500).json({ error: 'Failed to deactivate billing tier' });
    }
  });

  /**
   * GET /api/admin/billing/volume-discounts
   * List volume discount thresholds
   */
  router.get('/billing/volume-discounts', async (_req: Request, res: Response) => {
    try {
      const result = await db.query(
        'SELECT id, min_monthly_spend_usd, discount_percentage FROM volume_discount_thresholds ORDER BY min_monthly_spend_usd ASC'
      );
      const discounts = result.rows.map((row: any) => ({
        ...row,
        min_monthly_spend_usd: parseFloat(row.min_monthly_spend_usd),
        discount_percentage: parseFloat(row.discount_percentage),
      }));
      res.json({ discounts });
    } catch (error: any) {
      logger.error('Failed to get volume discounts', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve volume discounts' });
    }
  });

  /**
   * PUT /api/admin/billing/volume-discounts
   * Replace all volume discount thresholds
   */
  router.put('/billing/volume-discounts', async (req: Request, res: Response) => {
    try {
      const { thresholds } = req.body;
      if (!Array.isArray(thresholds)) {
        return res.status(400).json({ error: 'thresholds must be an array' });
      }

      const client = await (db as any).pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM volume_discount_thresholds');
        for (const t of thresholds) {
          await client.query(
            'INSERT INTO volume_discount_thresholds (min_monthly_spend_usd, discount_percentage) VALUES ($1, $2)',
            [t.min_monthly_spend_usd, t.discount_percentage]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      await logAdminAction(
        (req as any).user.id,
        'update_volume_discounts',
        null,
        null,
        { count: thresholds.length },
        req
      );

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Failed to update volume discounts', { error: error.message });
      res.status(500).json({ error: 'Failed to update volume discounts' });
    }
  });

  /**
   * GET /api/admin/billing/organizations
   * List all organizations with billing info
   */
  router.get('/billing/organizations', async (_req: Request, res: Response) => {
    try {
      const result = await db.query(`
        SELECT
          o.id, o.name, o.plan, o.max_members,
          o.billing_tier_key, o.billing_email,
          COALESCE(o.balance_usd, 0) as balance_usd,
          COALESCE(o.total_spent_usd, 0) as total_spent_usd,
          o.created_at,
          (SELECT COUNT(*) FROM organization_members om WHERE om.organization_id = o.id) as member_count,
          u.email as owner_email,
          u.name as owner_name
        FROM organizations o
        LEFT JOIN organization_members om_owner ON o.id = om_owner.organization_id AND om_owner.role = 'owner'
        LEFT JOIN users u ON om_owner.user_id = u.id
        ORDER BY o.created_at DESC
      `);
      const organizations = result.rows.map((row: any) => ({
        ...row,
        balance_usd: parseFloat(row.balance_usd),
        total_spent_usd: parseFloat(row.total_spent_usd),
        member_count: parseInt(row.member_count),
      }));
      res.json({ organizations });
    } catch (error: any) {
      logger.error('Failed to list organizations', { error: error.message });
      res.status(500).json({ error: 'Failed to list organizations' });
    }
  });

  /**
   * GET /api/admin/billing/organizations/:id
   * Get organization details with members
   */
  router.get('/billing/organizations/:id', async (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Organization id is required' });

      const orgResult = await db.query('SELECT * FROM organizations WHERE id = $1', [id]);
      if (orgResult.rows.length === 0) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      const membersResult = await db.query(`
        SELECT om.user_id, om.role, om.joined_at, u.email, u.name
        FROM organization_members om
        JOIN users u ON om.user_id = u.id
        WHERE om.organization_id = $1
        ORDER BY om.role ASC, om.joined_at ASC
      `, [id]);

      res.json({
        organization: orgResult.rows[0],
        members: membersResult.rows,
      });
    } catch (error: any) {
      logger.error('Failed to get organization details', { error: error.message });
      res.status(500).json({ error: 'Failed to get organization details' });
    }
  });

  /**
   * PUT /api/admin/billing/organizations/:id
   * Update organization billing fields
   */
  router.put('/billing/organizations/:id', async (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Organization id is required' });

      const { plan, max_members, billing_tier_key, billing_email } = req.body;

      const updates: string[] = [];
      const params: any[] = [id];
      let paramCount = 1;

      if (plan !== undefined) { paramCount++; updates.push(`plan = $${paramCount}`); params.push(plan); }
      if (max_members !== undefined) { paramCount++; updates.push(`max_members = $${paramCount}`); params.push(max_members); }
      if (billing_tier_key !== undefined) { paramCount++; updates.push(`billing_tier_key = $${paramCount}`); params.push(billing_tier_key || null); }
      if (billing_email !== undefined) { paramCount++; updates.push(`billing_email = $${paramCount}`); params.push(billing_email || null); }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      updates.push('updated_at = NOW()');

      const result = await db.query(
        `UPDATE organizations SET ${updates.join(', ')} WHERE id = $1 RETURNING id`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      await logAdminAction(
        (req as any).user.id,
        'update_organization',
        null,
        id,
        req.body,
        req
      );

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Failed to update organization', { error: error.message });
      res.status(500).json({ error: 'Failed to update organization' });
    }
  });

  /**
   * PUT /api/admin/billing/subscriptions/:id/cancel
   * Cancel a subscription
   */
  router.put('/billing/subscriptions/:id/cancel', async (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Subscription id is required' });

      const { reason } = req.body;
      const result = await subscriptions.cancel(id, reason || 'Admin canceled');

      if (!result) {
        return res.status(404).json({ error: 'Subscription not found' });
      }

      await logAdminAction(
        (req as any).user.id,
        'cancel_subscription',
        null,
        id,
        { reason },
        req
      );

      res.json(result);
    } catch (error: any) {
      logger.error('Failed to cancel subscription', { error: error.message });
      res.status(500).json({ error: 'Failed to cancel subscription' });
    }
  });

  /**
   * PUT /api/admin/billing/subscriptions/:id/activate
   * Activate a canceled subscription
   */
  router.put('/billing/subscriptions/:id/activate', async (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Subscription id is required' });

      const result = await subscriptions.activate(id);

      if (!result) {
        return res.status(404).json({ error: 'Subscription not found' });
      }

      await logAdminAction(
        (req as any).user.id,
        'activate_subscription',
        null,
        id,
        {},
        req
      );

      res.json(result);
    } catch (error: any) {
      logger.error('Failed to activate subscription', { error: error.message });
      res.status(500).json({ error: 'Failed to activate subscription' });
    }
  });

  /**
   * GET /api/admin/billing/subscriptions
   * List subscriptions with filtering
   */
  router.get('/billing/subscriptions', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      const status = req.query.status as string | undefined;
      const tier = req.query.tier as string | undefined;

      const result = await subscriptions.list({ limit, offset, status });
      res.json(result);
    } catch (error: any) {
      logger.error('Failed to list subscriptions', { error: error.message });
      res.status(500).json({ error: 'Failed to list subscriptions' });
    }
  });

  /**
   * POST /api/admin/billing/subscriptions
   * Create a new subscription
   */
  router.post('/billing/subscriptions', async (req: Request, res: Response) => {
    try {
      const sub = await subscriptions.create({
        ...req.body,
        created_by: (req as any).user.id,
      });

      await logAdminAction(
        (req as any).user.id,
        'create_subscription',
        req.body.user_id || null,
        sub.id,
        req.body,
        req
      );

      res.status(201).json(sub);
    } catch (error: any) {
      logger.error('Failed to create subscription', { error: error.message });
      res.status(500).json({ error: 'Failed to create subscription' });
    }
  });

  /**
   * PUT /api/admin/billing/subscriptions/:id
   * Update a subscription (status, tier, cycle, price, cancel)
   */
  router.put('/billing/subscriptions/:id', async (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const updated = await subscriptions.update(id, req.body);

      await logAdminAction(
        (req as any).user.id,
        'update_subscription',
        null,
        id,
        req.body,
        req
      );

      res.json(updated);
    } catch (error: any) {
      logger.error('Failed to update subscription', { error: error.message });
      res.status(500).json({ error: 'Failed to update subscription' });
    }
  });

  /**
   * DELETE /api/admin/billing/subscriptions/:id
   * Hard-delete a subscription
   */
  router.delete('/billing/subscriptions/:id', async (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      await subscriptions.remove(id);

      await logAdminAction(
        (req as any).user.id,
        'delete_subscription',
        null,
        id,
        {},
        req
      );

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Failed to delete subscription', { error: error.message });
      res.status(500).json({ error: 'Failed to delete subscription' });
    }
  });

  /**
   * GET /api/admin/billing/subscription-stats
   * Aggregate subscription statistics
   */
  router.get('/billing/subscription-stats', async (_req: Request, res: Response) => {
    try {
      const stats = await subscriptions.getStats();
      res.json(stats);
    } catch (error: any) {
      logger.error('Failed to get subscription stats', { error: error.message });
      res.status(500).json({ error: 'Failed to get subscription stats' });
    }
  });

  // ========================================
  // INFRASTRUCTURE METRICS
  // ========================================

  /**
   * Helper: parse range param and compute start/end/step
   */
  function parseRange(range: string) {
    const rangeSeconds: Record<string, number> = { '1h': 3600, '6h': 21600, '24h': 86400 };
    const seconds = rangeSeconds[range] || 3600;
    const step = seconds <= 3600 ? '30s' : seconds <= 21600 ? '2m' : '5m';
    const end = Math.floor(Date.now() / 1000);
    const start = end - seconds;
    return { start, end, step };
  }

  /**
   * Helper: extract series from prometheus range query result
   */
  function extractSeries(results: any[], valueKey = 'value') {
    return results[0]?.values?.map(([ts, val]: [number, string]) => ({
      timestamp: ts,
      [valueKey]: parseFloat(val) || 0,
    })) || [];
  }

  /**
   * GET /api/admin/metrics/infrastructure
   * CPU, memory, disk I/O, network, PG detailed, Redis detailed
   */
  router.get('/metrics/infrastructure', async (req: Request, res: Response) => {
    try {
      const range = (req.query.range as string) || '1h';
      const { start, end, step } = parseRange(range);

      const [
        cpuUser, cpuSystem, cpuIowait,
        memUsedPct, memTotal, memAvailable,
        diskRead, diskWrite,
        netRx, netTx,
        pgActive, pgIdle, pgIdleTx,
        pgCommits, pgRollbacks,
        pgCacheHit,
        redisMem, redisMaxMem,
        redisClients, redisCommands, redisEvicted,
      ] = await Promise.all([
        prometheus.queryRange('avg(rate(node_cpu_seconds_total{mode="user"}[1m]))', start, end, step),
        prometheus.queryRange('avg(rate(node_cpu_seconds_total{mode="system"}[1m]))', start, end, step),
        prometheus.queryRange('avg(rate(node_cpu_seconds_total{mode="iowait"}[1m]))', start, end, step),
        prometheus.queryInstant('(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100'),
        prometheus.queryInstant('node_memory_MemTotal_bytes'),
        prometheus.queryInstant('node_memory_MemAvailable_bytes'),
        prometheus.queryRange('rate(node_disk_read_bytes_total[1m])', start, end, step),
        prometheus.queryRange('rate(node_disk_written_bytes_total[1m])', start, end, step),
        prometheus.queryRange('rate(node_network_receive_bytes_total{device!="lo"}[1m])', start, end, step),
        prometheus.queryRange('rate(node_network_transmit_bytes_total{device!="lo"}[1m])', start, end, step),
        prometheus.queryRange('pg_stat_activity_count{state="active"}', start, end, step),
        prometheus.queryRange('pg_stat_activity_count{state="idle"}', start, end, step),
        prometheus.queryRange('pg_stat_activity_count{state="idle in transaction"}', start, end, step),
        prometheus.queryRange('rate(pg_stat_database_xact_commit{datname!=""}[1m])', start, end, step),
        prometheus.queryRange('rate(pg_stat_database_xact_rollback{datname!=""}[1m])', start, end, step),
        prometheus.queryInstant('pg_stat_database_blks_hit{datname!=""} / (pg_stat_database_blks_hit{datname!=""} + pg_stat_database_blks_read{datname!=""})'),
        prometheus.queryRange('redis_memory_used_bytes', start, end, step),
        prometheus.queryRange('redis_memory_max_bytes', start, end, step),
        prometheus.queryRange('redis_connected_clients', start, end, step),
        prometheus.queryRange('rate(redis_commands_processed_total[1m])', start, end, step),
        prometheus.queryRange('redis_evicted_keys_total', start, end, step),
      ]);

      // Build CPU series by merging timestamps
      const cpuUserSeries = cpuUser[0]?.values || [];
      const cpuSystemSeries = cpuSystem[0]?.values || [];
      const cpuIowaitSeries = cpuIowait[0]?.values || [];
      const cpuSeries = cpuUserSeries.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        user: parseFloat(val) || 0,
        system: parseFloat(cpuSystemSeries[i]?.[1] || '0'),
        iowait: parseFloat(cpuIowaitSeries[i]?.[1] || '0'),
      }));

      // Build PG connections series
      const pgActiveSeries = pgActive[0]?.values || [];
      const pgIdleSeries = pgIdle[0]?.values || [];
      const pgIdleTxSeries = pgIdleTx[0]?.values || [];
      const pgConnSeries = pgActiveSeries.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        active: parseFloat(val) || 0,
        idle: parseFloat(pgIdleSeries[i]?.[1] || '0'),
        idle_in_tx: parseFloat(pgIdleTxSeries[i]?.[1] || '0'),
      }));

      // Build PG transactions series
      const pgCommitsSeries = pgCommits[0]?.values || [];
      const pgRollbacksSeries = pgRollbacks[0]?.values || [];
      const pgTxSeries = pgCommitsSeries.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        commits: parseFloat(val) || 0,
        rollbacks: parseFloat(pgRollbacksSeries[i]?.[1] || '0'),
      }));

      // Build Redis series
      const redisMemSeries = redisMem[0]?.values || [];
      const redisMaxSeries = redisMaxMem[0]?.values || [];
      const redisMemMerged = redisMemSeries.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        used: parseFloat(val) || 0,
        max: parseFloat(redisMaxSeries[i]?.[1] || '0'),
      }));

      // Build disk series
      const diskReadSeries = diskRead[0]?.values || [];
      const diskWriteSeries = diskWrite[0]?.values || [];
      const diskSeries = diskReadSeries.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        read_bytes: parseFloat(val) || 0,
        write_bytes: parseFloat(diskWriteSeries[i]?.[1] || '0'),
      }));

      // Build network series
      const netRxSeries = netRx[0]?.values || [];
      const netTxSeries = netTx[0]?.values || [];
      const networkSeries = netRxSeries.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        rx_bytes: parseFloat(val) || 0,
        tx_bytes: parseFloat(netTxSeries[i]?.[1] || '0'),
      }));

      res.json({
        cpu: { series: cpuSeries },
        memory: {
          used_pct: parseFloat(memUsedPct[0]?.value?.[1] || '0'),
          total_bytes: parseFloat(memTotal[0]?.value?.[1] || '0'),
          available_bytes: parseFloat(memAvailable[0]?.value?.[1] || '0'),
        },
        disk_io: { series: diskSeries },
        network: { series: networkSeries },
        pg: {
          connections: { series: pgConnSeries },
          transactions: { series: pgTxSeries },
          cache_hit_ratio: parseFloat(pgCacheHit[0]?.value?.[1] || '0'),
        },
        redis: {
          memory: { series: redisMemMerged },
          clients: { series: extractSeries(redisClients) },
          commands_rate: { series: extractSeries(redisCommands) },
          evicted_keys: { series: extractSeries(redisEvicted) },
        },
        range,
      });
    } catch (error: any) {
      logger.error('Failed to get infrastructure metrics', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve infrastructure metrics' });
    }
  });

  /**
   * GET /api/admin/metrics/upload-pipeline
   * BullMQ jobs, processing duration, queue depth, concurrency
   */
  router.get('/metrics/upload-pipeline', async (req: Request, res: Response) => {
    try {
      const range = (req.query.range as string) || '1h';
      const { start, end, step } = parseRange(range);

      const [
        jobsCompleted, jobsFailed, jobsActive, jobsWaiting, jobsDelayed,
        durationP50, durationP95, durationP99,
        queueDepth,
        concurrencyActive, concurrencyMax,
      ] = await Promise.all([
        prometheus.queryRange('upload_jobs_completed_total', start, end, step),
        prometheus.queryRange('upload_jobs_failed_total', start, end, step),
        prometheus.queryRange('upload_jobs_active', start, end, step),
        prometheus.queryRange('upload_jobs_waiting', start, end, step),
        prometheus.queryRange('upload_jobs_delayed', start, end, step),
        prometheus.queryRange('histogram_quantile(0.50, rate(upload_processing_duration_seconds_bucket[5m]))', start, end, step),
        prometheus.queryRange('histogram_quantile(0.95, rate(upload_processing_duration_seconds_bucket[5m]))', start, end, step),
        prometheus.queryRange('histogram_quantile(0.99, rate(upload_processing_duration_seconds_bucket[5m]))', start, end, step),
        prometheus.queryRange('upload_queue_depth', start, end, step),
        prometheus.queryRange('upload_concurrent_processing', start, end, step),
        prometheus.queryRange('upload_max_concurrent_processing', start, end, step),
      ]);

      // Merge job series
      const completedVals = jobsCompleted[0]?.values || [];
      const failedVals = jobsFailed[0]?.values || [];
      const activeVals = jobsActive[0]?.values || [];
      const waitingVals = jobsWaiting[0]?.values || [];
      const delayedVals = jobsDelayed[0]?.values || [];
      const jobsSeries = completedVals.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        completed: parseFloat(val) || 0,
        failed: parseFloat(failedVals[i]?.[1] || '0'),
        active: parseFloat(activeVals[i]?.[1] || '0'),
        waiting: parseFloat(waitingVals[i]?.[1] || '0'),
        delayed: parseFloat(delayedVals[i]?.[1] || '0'),
      }));

      // Merge duration percentiles
      const p50Vals = durationP50[0]?.values || [];
      const p95Vals = durationP95[0]?.values || [];
      const p99Vals = durationP99[0]?.values || [];
      const durationSeries = p50Vals.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        p50: (parseFloat(val) || 0) * 1000,
        p95: (parseFloat(p95Vals[i]?.[1] || '0')) * 1000,
        p99: (parseFloat(p99Vals[i]?.[1] || '0')) * 1000,
      }));

      // Merge concurrency
      const activeConc = concurrencyActive[0]?.values || [];
      const maxConc = concurrencyMax[0]?.values || [];
      const concurrencySeries = activeConc.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        active: parseFloat(val) || 0,
        max: parseFloat(maxConc[i]?.[1] || '0'),
      }));

      res.json({
        jobs: { series: jobsSeries },
        processing_duration: { series: durationSeries },
        queue_depth: { series: extractSeries(queueDepth) },
        concurrency: { series: concurrencySeries },
        range,
      });
    } catch (error: any) {
      logger.error('Failed to get upload pipeline metrics', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve upload pipeline metrics' });
    }
  });

  /**
   * GET /api/admin/metrics/backend-detail
   * Per-route RPS, status code distribution, external API calls/duration
   */
  router.get('/metrics/backend-detail', async (req: Request, res: Response) => {
    try {
      const range = (req.query.range as string) || '1h';
      const { start, end, step } = parseRange(range);

      const [
        byRouteResults,
        status2xx, status3xx, status4xx, status5xx,
        externalCalls, externalDuration,
      ] = await Promise.all([
        prometheus.queryRange('sum(rate(http_requests_total[1m])) by (route)', start, end, step),
        prometheus.queryRange('sum(rate(http_requests_total{status_code=~"2.."}[1m]))', start, end, step),
        prometheus.queryRange('sum(rate(http_requests_total{status_code=~"3.."}[1m]))', start, end, step),
        prometheus.queryRange('sum(rate(http_requests_total{status_code=~"4.."}[1m]))', start, end, step),
        prometheus.queryRange('sum(rate(http_requests_total{status_code=~"5.."}[1m]))', start, end, step),
        prometheus.queryRange('sum(rate(external_api_calls_total[1m])) by (service)', start, end, step),
        prometheus.queryRange('histogram_quantile(0.95, sum(rate(external_api_duration_seconds_bucket[5m])) by (le, service))', start, end, step),
      ]);

      // By route: each result series is a route
      const byRoute = byRouteResults.map((r: any) => ({
        route: r.metric?.route || 'unknown',
        series: (r.values || []).map(([ts, val]: [number, string]) => ({
          timestamp: ts,
          rps: parseFloat(val) || 0,
        })),
      }));

      // Status codes merged
      const s2xx = status2xx[0]?.values || [];
      const s3xx = status3xx[0]?.values || [];
      const s4xx = status4xx[0]?.values || [];
      const s5xx = status5xx[0]?.values || [];
      const statusSeries = s2xx.map(([ts, val]: [number, string], i: number) => ({
        timestamp: ts,
        '2xx': parseFloat(val) || 0,
        '3xx': parseFloat(s3xx[i]?.[1] || '0'),
        '4xx': parseFloat(s4xx[i]?.[1] || '0'),
        '5xx': parseFloat(s5xx[i]?.[1] || '0'),
      }));

      // External API calls by service
      const externalCallsSeries = externalCalls.map((r: any) => ({
        service: r.metric?.service || 'unknown',
        series: (r.values || []).map(([ts, val]: [number, string]) => ({
          timestamp: ts,
          value: parseFloat(val) || 0,
        })),
      }));

      const externalDurationSeries = externalDuration.map((r: any) => ({
        service: r.metric?.service || 'unknown',
        series: (r.values || []).map(([ts, val]: [number, string]) => ({
          timestamp: ts,
          value: (parseFloat(val) || 0) * 1000,
        })),
      }));

      res.json({
        by_route: byRoute,
        status_codes: { series: statusSeries },
        external_apis: {
          calls: externalCallsSeries,
          duration_p95: externalDurationSeries,
        },
        range,
      });
    } catch (error: any) {
      logger.error('Failed to get backend detail metrics', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve backend detail metrics' });
    }
  });

  /**
   * GET /api/admin/metrics/cost-realtime
   * Cost/hour, cost/day, cost/month extrapolated, cost trend by model, top tools
   */
  router.get('/metrics/cost-realtime', async (req: Request, res: Response) => {
    try {
      const range = (req.query.range as string) || '6h';
      const { start, end, step } = parseRange(range);

      // Cost from last hour for rate calculation
      const lastHourResult = await db.query(`
        SELECT COALESCE(SUM(
          COALESCE(openai_cost_usd, 0) + COALESCE(anthropic_cost_usd, 0) +
          COALESCE(zakononline_cost_usd, 0) + COALESCE(secondlayer_cost_usd, 0)
        ), 0) as total
        FROM cost_tracking
        WHERE created_at >= NOW() - INTERVAL '1 hour'
          AND status = 'completed'
      `);
      const costPerHour = parseFloat(lastHourResult.rows[0]?.total || '0');
      const costPerDay = costPerHour * 24;
      const costPerMonth = costPerDay * 30;

      // Cost by model over time range
      const costByModelResult = await db.query(`
        SELECT
          date_trunc('hour', created_at) as hour,
          elem->>'model' as model,
          SUM((elem->>'cost')::numeric) as cost
        FROM cost_tracking,
          jsonb_array_elements(
            CASE WHEN openai_calls IS NOT NULL AND openai_calls != 'null'::jsonb AND jsonb_typeof(openai_calls) = 'array'
              THEN openai_calls ELSE '[]'::jsonb END
            ||
            CASE WHEN anthropic_calls IS NOT NULL AND anthropic_calls != 'null'::jsonb AND jsonb_typeof(anthropic_calls) = 'array'
              THEN anthropic_calls ELSE '[]'::jsonb END
          ) AS elem
        WHERE created_at >= NOW() - INTERVAL '${range === '24h' ? '24 hours' : range === '6h' ? '6 hours' : '1 hour'}'
          AND status = 'completed'
          AND elem->>'model' IS NOT NULL
        GROUP BY hour, model
        ORDER BY hour
      `);

      // Pivot by model
      const modelMap = new Map<number, Record<string, number>>();
      for (const row of costByModelResult.rows) {
        const ts = Math.floor(new Date(row.hour).getTime() / 1000);
        if (!modelMap.has(ts)) modelMap.set(ts, {});
        const entry = modelMap.get(ts)!;
        entry[row.model] = parseFloat(row.cost) || 0;
      }
      const byModelSeries = Array.from(modelMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([ts, models]) => ({ timestamp: ts, ...models }));

      // Top tools by cost
      const topToolsResult = await db.query(`
        SELECT
          tool_name,
          SUM(
            COALESCE(openai_cost_usd, 0) + COALESCE(anthropic_cost_usd, 0) +
            COALESCE(zakononline_cost_usd, 0) + COALESCE(secondlayer_cost_usd, 0)
          ) as total_cost
        FROM cost_tracking
        WHERE created_at >= NOW() - INTERVAL '7 days'
          AND status = 'completed'
          AND tool_name IS NOT NULL
        GROUP BY tool_name
        ORDER BY total_cost DESC
        LIMIT 10
      `);

      const topTools = topToolsResult.rows.map((r: any) => ({
        tool: r.tool_name,
        cost: parseFloat(r.total_cost) || 0,
      }));

      res.json({
        cost_per_hour: costPerHour,
        cost_per_day: costPerDay,
        cost_per_month: costPerMonth,
        by_model: { series: byModelSeries },
        top_tools: topTools,
      });
    } catch (error: any) {
      logger.error('Failed to get cost realtime metrics', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve cost realtime metrics' });
    }
  });

  return router;
}
