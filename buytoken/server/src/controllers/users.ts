/**
 * User Controller
 * Business logic for user management
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import { pool } from '../config/database.js';
import { generateAPIKey } from '../middleware/auth.js';

export async function getProfile(req: AuthenticatedRequest, res: Response) {
  // User is already attached by requireAuth middleware
  const user = req.user!;

  // Get token balance
  const balanceResult = await pool.query(
    'SELECT balance, lifetime_purchased, lifetime_used FROM user_token_balance WHERE user_id = $1',
    [user.id]
  );

  const balance = balanceResult.rows[0] || { balance: 0, lifetime_purchased: 0, lifetime_used: 0 };

  // Get subscription
  const subscriptionResult = await pool.query(
    `SELECT s.*, sp.name as plan_name
     FROM subscriptions s
     JOIN subscription_plans sp ON s.plan_id = sp.id
     WHERE s.user_id = $1 AND s.status = 'active'
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [user.id]
  );

  const subscription = subscriptionResult.rows[0] || null;

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      email_verified: user.email_verified,
    },
    balance,
    subscription,
  });
}

export async function updateProfile(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;
  const { name } = req.body;

  const result = await pool.query(
    'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [name, user.id]
  );

  res.json({ user: result.rows[0] });
}

export async function listAPIKeys(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;

  const result = await pool.query(
    `SELECT id, key_prefix, name, last_used_at, created_at
     FROM api_keys
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [user.id]
  );

  res.json({ apiKeys: result.rows });
}

export async function createAPIKey(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;
  const { name } = req.body;

  // Generate new API key
  const { apiKey, keyHash, keyPrefix } = await generateAPIKey();

  // Store in database
  await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)`,
    [user.id, keyHash, keyPrefix, name]
  );

  // Return the full API key (only shown once!)
  res.status(201).json({
    apiKey, // Full key - save this!
    keyPrefix,
    name,
    message: 'API key created. Save it now - you won\'t see it again!',
  });
}

export async function revokeAPIKey(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;
  const { keyId } = req.params;

  await pool.query(
    'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2',
    [keyId, user.id]
  );

  res.json({ message: 'API key revoked successfully' });
}
