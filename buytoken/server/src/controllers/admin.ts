/**
 * Admin Controller
 * Business logic for admin operations
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import { pool } from '../config/database.js';

export async function listUsers(req: AuthenticatedRequest, res: Response) {
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.email_verified, u.created_at,
            tb.balance, s.status as subscription_status, sp.name as subscription_plan
     FROM users u
     LEFT JOIN user_token_balance tb ON u.id = tb.user_id
     LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
     LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const countResult = await pool.query('SELECT COUNT(*) FROM users');
  const total = parseInt(countResult.rows[0].count);

  res.json({
    users: result.rows,
    pagination: {
      limit,
      offset,
      total,
    },
  });
}

export async function getUserDetails(req: AuthenticatedRequest, res: Response) {
  const { userId } = req.params;

  const result = await pool.query(
    `SELECT u.*, tb.balance, tb.lifetime_purchased, tb.lifetime_used
     FROM users u
     LEFT JOIN user_token_balance tb ON u.id = tb.user_id
     WHERE u.id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ user: result.rows[0] });
}

export async function updateUser(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Update user not yet implemented' });
}

export async function deleteUser(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Delete user not yet implemented' });
}

export async function listSubscriptions(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'List subscriptions not yet implemented' });
}

export async function updateSubscription(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Update subscription not yet implemented' });
}

export async function listInvoices(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'List invoices not yet implemented' });
}

export async function getInvoiceDetails(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Get invoice details not yet implemented' });
}

export async function adjustUserTokens(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Adjust user tokens not yet implemented' });
}

export async function getPlatformStats(req: AuthenticatedRequest, res: Response) {
  // Basic platform statistics
  const stats = await Promise.all([
    pool.query('SELECT COUNT(*) as total_users FROM users'),
    pool.query('SELECT COUNT(*) as active_subscriptions FROM subscriptions WHERE status = \'active\''),
    pool.query('SELECT SUM(amount_usd) as monthly_revenue FROM invoices WHERE status = \'paid\' AND issued_at >= NOW() - INTERVAL \'30 days\''),
    pool.query('SELECT SUM(tokens_used) as total_tokens_used FROM user_monthly_usage WHERE year_month = TO_CHAR(NOW(), \'YYYY-MM\')'),
    pool.query('SELECT COUNT(*) as new_users_this_month FROM users WHERE created_at >= DATE_TRUNC(\'month\', NOW())'),
  ]);

  res.json({
    totalUsers: parseInt(stats[0].rows[0].total_users),
    activeSubscriptions: parseInt(stats[1].rows[0].active_subscriptions),
    monthlyRevenue: parseFloat(stats[2].rows[0].monthly_revenue || 0),
    totalTokensUsed: parseInt(stats[3].rows[0].total_tokens_used || 0),
    newUsersThisMonth: parseInt(stats[4].rows[0].new_users_this_month),
    topTools: [], // TODO: Implement after cost_tracking integration
  });
}

export async function getAuditLog(req: AuthenticatedRequest, res: Response) {
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;

  const result = await pool.query(
    `SELECT al.*, u.email as user_email, a.email as admin_email
     FROM audit_log al
     LEFT JOIN users u ON al.user_id = u.id
     LEFT JOIN users a ON al.admin_id = a.id
     ORDER BY al.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  res.json({ auditLog: result.rows });
}
