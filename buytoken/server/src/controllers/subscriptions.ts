/**
 * Subscription Controller
 * Business logic for subscription management
 */

import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import { pool } from '../config/database.js';

export async function listPlans(req: Request, res: Response) {
  const result = await pool.query(
    'SELECT * FROM subscription_plans WHERE is_active = true ORDER BY price_monthly ASC'
  );

  res.json({ plans: result.rows });
}

export async function getCurrentSubscription(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;

  const result = await pool.query(
    `SELECT s.*, sp.name as plan_name, sp.price_monthly, sp.token_limit_monthly, sp.features
     FROM subscriptions s
     JOIN subscription_plans sp ON s.plan_id = sp.id
     WHERE s.user_id = $1 AND s.status = 'active'
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [user.id]
  );

  if (result.rows.length === 0) {
    return res.json({ subscription: null });
  }

  res.json({ subscription: result.rows[0] });
}

export async function subscribe(req: AuthenticatedRequest, res: Response) {
  // TODO: Implement Stripe subscription creation
  res.status(501).json({ message: 'Subscription creation not yet implemented' });
}

export async function cancelSubscription(req: AuthenticatedRequest, res: Response) {
  // TODO: Implement subscription cancellation
  res.status(501).json({ message: 'Subscription cancellation not yet implemented' });
}

export async function reactivateSubscription(req: AuthenticatedRequest, res: Response) {
  // TODO: Implement subscription reactivation
  res.status(501).json({ message: 'Subscription reactivation not yet implemented' });
}
