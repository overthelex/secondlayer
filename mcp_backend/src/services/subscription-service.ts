/**
 * Subscription Service
 * CRUD operations for managing recurring subscriptions
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

export interface Subscription {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  tier_key: string;
  status: 'trial' | 'active' | 'past_due' | 'canceled' | 'expired';
  billing_cycle: 'monthly' | 'quarterly' | 'annual';
  price_usd: number;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_billing_date: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  user_email?: string;
  user_name?: string;
  org_name?: string;
  tier_display_name?: string;
}

export interface CreateSubscriptionInput {
  user_id?: string;
  organization_id?: string;
  tier_key: string;
  billing_cycle: 'monthly' | 'quarterly' | 'annual';
  price_usd: number;
  status?: string;
  trial_ends_at?: string;
  created_by: string;
}

export class SubscriptionService {
  constructor(private db: Database) {}

  async list(filters: {
    status?: string;
    user_id?: string;
    organization_id?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ subscriptions: Subscription[]; total: number }> {
    const { limit = 50, offset = 0 } = filters;
    let whereClause = '1=1';
    const params: any[] = [];
    let paramCount = 0;

    if (filters.status) {
      paramCount++;
      whereClause += ` AND s.status = $${paramCount}`;
      params.push(filters.status);
    }
    if (filters.user_id) {
      paramCount++;
      whereClause += ` AND s.user_id = $${paramCount}`;
      params.push(filters.user_id);
    }
    if (filters.organization_id) {
      paramCount++;
      whereClause += ` AND s.organization_id = $${paramCount}`;
      params.push(filters.organization_id);
    }

    const result = await this.db.query(`
      SELECT s.*,
        u.email as user_email, u.name as user_name,
        o.name as org_name,
        bt.display_name as tier_display_name
      FROM subscriptions s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN organizations o ON s.organization_id = o.id
      LEFT JOIN billing_tiers bt ON s.tier_key = bt.tier_key
      WHERE ${whereClause}
      ORDER BY s.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `, [...params, limit, offset]);

    const countResult = await this.db.query(`
      SELECT COUNT(*) as total FROM subscriptions s WHERE ${whereClause}
    `, params);

    return {
      subscriptions: result.rows.map(this.coerce),
      total: parseInt(countResult.rows[0].total),
    };
  }

  async get(id: string): Promise<Subscription | null> {
    const result = await this.db.query(`
      SELECT s.*,
        u.email as user_email, u.name as user_name,
        o.name as org_name,
        bt.display_name as tier_display_name
      FROM subscriptions s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN organizations o ON s.organization_id = o.id
      LEFT JOIN billing_tiers bt ON s.tier_key = bt.tier_key
      WHERE s.id = $1
    `, [id]);
    if (result.rows.length === 0) return null;
    return this.coerce(result.rows[0]);
  }

  async create(input: CreateSubscriptionInput): Promise<Subscription> {
    const now = new Date().toISOString();
    const status = input.status || 'active';

    // Calculate period
    let periodEnd: string;
    const periodStart = now;
    const cycle = input.billing_cycle;
    const startDate = new Date();
    if (cycle === 'monthly') {
      startDate.setMonth(startDate.getMonth() + 1);
    } else if (cycle === 'quarterly') {
      startDate.setMonth(startDate.getMonth() + 3);
    } else {
      startDate.setFullYear(startDate.getFullYear() + 1);
    }
    periodEnd = startDate.toISOString();

    const result = await this.db.query(`
      INSERT INTO subscriptions (
        user_id, organization_id, tier_key, status, billing_cycle, price_usd,
        trial_ends_at, current_period_start, current_period_end, next_billing_date, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      input.user_id || null,
      input.organization_id || null,
      input.tier_key,
      status,
      input.billing_cycle,
      input.price_usd,
      input.trial_ends_at || null,
      periodStart,
      periodEnd,
      periodEnd,
      input.created_by,
    ]);

    logger.info('Subscription created', { id: result.rows[0].id, tier: input.tier_key });
    return this.coerce(result.rows[0]);
  }

  async update(id: string, data: {
    tier_key?: string;
    billing_cycle?: string;
    price_usd?: number;
    status?: string;
  }): Promise<Subscription | null> {
    const updates: string[] = [];
    const params: any[] = [];
    let paramCount = 0;

    if (data.tier_key !== undefined) {
      paramCount++;
      updates.push(`tier_key = $${paramCount}`);
      params.push(data.tier_key);
    }
    if (data.billing_cycle !== undefined) {
      paramCount++;
      updates.push(`billing_cycle = $${paramCount}`);
      params.push(data.billing_cycle);
    }
    if (data.price_usd !== undefined) {
      paramCount++;
      updates.push(`price_usd = $${paramCount}`);
      params.push(data.price_usd);
    }
    if (data.status !== undefined) {
      paramCount++;
      updates.push(`status = $${paramCount}`);
      params.push(data.status);
    }

    if (updates.length === 0) return this.get(id);

    paramCount++;
    params.push(id);
    const result = await this.db.query(`
      UPDATE subscriptions SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${paramCount}
      RETURNING *
    `, params);

    if (result.rows.length === 0) return null;
    logger.info('Subscription updated', { id, changes: data });
    return this.coerce(result.rows[0]);
  }

  async cancel(id: string, reason: string): Promise<Subscription | null> {
    const result = await this.db.query(`
      UPDATE subscriptions
      SET status = 'canceled', canceled_at = NOW(), cancel_reason = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [reason, id]);
    if (result.rows.length === 0) return null;
    logger.info('Subscription canceled', { id, reason });
    return this.coerce(result.rows[0]);
  }

  async activate(id: string): Promise<Subscription | null> {
    const result = await this.db.query(`
      UPDATE subscriptions
      SET status = 'active', canceled_at = NULL, cancel_reason = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);
    if (result.rows.length === 0) return null;
    logger.info('Subscription activated', { id });
    return this.coerce(result.rows[0]);
  }

  async getUserSubscription(userId: string): Promise<Subscription | null> {
    const result = await this.db.query(`
      SELECT s.*, bt.display_name as tier_display_name
      FROM subscriptions s
      LEFT JOIN billing_tiers bt ON s.tier_key = bt.tier_key
      WHERE s.user_id = $1 AND s.status IN ('active', 'trial')
      ORDER BY s.created_at DESC LIMIT 1
    `, [userId]);
    if (result.rows.length === 0) return null;
    return this.coerce(result.rows[0]);
  }

  async getOrgSubscription(orgId: string): Promise<Subscription | null> {
    const result = await this.db.query(`
      SELECT s.*, bt.display_name as tier_display_name
      FROM subscriptions s
      LEFT JOIN billing_tiers bt ON s.tier_key = bt.tier_key
      WHERE s.organization_id = $1 AND s.status IN ('active', 'trial')
      ORDER BY s.created_at DESC LIMIT 1
    `, [orgId]);
    if (result.rows.length === 0) return null;
    return this.coerce(result.rows[0]);
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM subscriptions WHERE id = $1', [id]);
    logger.info('Subscription deleted', { id });
  }

  async getStats(): Promise<{
    total: number;
    by_status: Record<string, number>;
    by_tier: Record<string, number>;
    mrr_usd: number;
  }> {
    const totalResult = await this.db.query('SELECT COUNT(*) as cnt FROM subscriptions');
    const statusResult = await this.db.query(
      `SELECT status, COUNT(*) as cnt FROM subscriptions GROUP BY status`
    );
    const tierResult = await this.db.query(
      `SELECT tier_key, COUNT(*) as cnt FROM subscriptions GROUP BY tier_key`
    );
    const mrrResult = await this.db.query(
      `SELECT COALESCE(SUM(price_usd), 0) as mrr FROM subscriptions WHERE status IN ('active', 'trial')`
    );

    const byStatus: Record<string, number> = {};
    for (const row of statusResult.rows) {
      byStatus[row.status] = parseInt(row.cnt);
    }

    const byTier: Record<string, number> = {};
    for (const row of tierResult.rows) {
      byTier[row.tier_key] = parseInt(row.cnt);
    }

    return {
      total: parseInt(totalResult.rows[0].cnt),
      by_status: byStatus,
      by_tier: byTier,
      mrr_usd: parseFloat(mrrResult.rows[0].mrr),
    };
  }

  private coerce(row: any): Subscription {
    return {
      ...row,
      price_usd: Number(row.price_usd) || 0,
    };
  }
}
