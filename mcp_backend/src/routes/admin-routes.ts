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
import { logger } from '../utils/logger.js';

/**
 * Helper to ensure param is a string (Express can return string | string[])
 */
function getStringParam(param: string | string[] | undefined): string | null {
  if (!param) return null;
  return Array.isArray(param) ? param[0] : param;
}

export function createAdminRoutes(db: Database, prometheusUrl?: string): express.Router {
  const router = express.Router();
  const billingService = new BillingService(db);
  const preferencesService = new UserPreferencesService(db);
  const prometheus = new PrometheusService(prometheusUrl);

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
      // Get pricing tier configs
      const tiers = billingService.getAllPricingTiers();

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
      const summary = byJusticeKind.reduce(
        (acc, row) => ({
          total_documents: acc.total_documents + row.total,
          with_plaintext: acc.with_plaintext + row.has_plaintext,
          with_html: acc.with_html + row.has_html,
          with_both: acc.with_both + row.has_both,
          missing_both: acc.missing_both + row.missing_both,
        }),
        { total_documents: 0, with_plaintext: 0, with_html: 0, with_both: 0, missing_both: 0 }
      );

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

  return router;
}
