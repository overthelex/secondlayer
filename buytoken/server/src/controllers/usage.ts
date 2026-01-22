/**
 * Usage Controller
 * Business logic for token usage and statistics
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import { pool } from '../config/database.js';

export async function getBalance(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;

  const result = await pool.query(
    'SELECT balance, lifetime_purchased, lifetime_used, updated_at FROM user_token_balance WHERE user_id = $1',
    [user.id]
  );

  if (result.rows.length === 0) {
    return res.json({
      balance: 0,
      lifetime_purchased: 0,
      lifetime_used: 0,
    });
  }

  res.json(result.rows[0]);
}

export async function getTransactionHistory(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;

  const result = await pool.query(
    `SELECT id, type, amount, balance_after, description, created_at
     FROM token_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [user.id, limit, offset]
  );

  res.json({ transactions: result.rows });
}

export async function getUsageStats(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;

  const result = await pool.query(
    `SELECT year_month, tokens_used, api_calls, cost_usd
     FROM user_monthly_usage
     WHERE user_id = $1
     ORDER BY year_month DESC
     LIMIT 12`,
    [user.id]
  );

  res.json({ monthlyUsage: result.rows });
}

export async function getUsageBreakdown(req: AuthenticatedRequest, res: Response) {
  // TODO: Implement usage breakdown by tool/endpoint
  res.status(501).json({ message: 'Usage breakdown not yet implemented' });
}
