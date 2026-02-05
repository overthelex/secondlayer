/**
 * API Key Service - Phase 2 Billing
 * Handles API key validation, rate limiting, and user authentication
 */

import { Pool } from 'pg';
import { logger } from '../utils/logger.js';

export interface ApiKeyInfo {
  id: string;
  userId: string;
  key: string;
  name: string;
  isActive: boolean;
  lastUsedAt: Date | null;
  usageCount: number;
  rateLimitPerMinute: number;
  rateLimitPerDay: number;
  requestsToday: number;
  expiresAt: Date | null;
  userEmail: string;
  userName: string | null;
  userBalance: number;
}

export interface RateLimitCheck {
  allowed: boolean;
  reason: string;
  requestsToday: number;
  rateLimitPerDay: number;
}

export class ApiKeyService {
  constructor(private pool: Pool) {}

  /**
   * Validate API key and get user info
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyInfo | null> {
    try {
      const result = await this.pool.query<ApiKeyInfo>(
        `SELECT
          ak.id,
          ak.user_id as "userId",
          ak.key,
          ak.name,
          ak.is_active as "isActive",
          ak.last_used_at as "lastUsedAt",
          ak.usage_count as "usageCount",
          ak.rate_limit_per_minute as "rateLimitPerMinute",
          ak.rate_limit_per_day as "rateLimitPerDay",
          ak.requests_today as "requestsToday",
          ak.expires_at as "expiresAt",
          u.email as "userEmail",
          u.name as "userName",
          COALESCE(uc.balance, 0) as "userBalance"
        FROM api_keys ak
        JOIN users u ON u.id = ak.user_id
        LEFT JOIN user_credits uc ON uc.user_id = u.id
        WHERE ak.key = $1 AND ak.is_active = true`,
        [apiKey]
      );

      if (result.rows.length === 0) {
        logger.debug('[ApiKeyService] API key not found or inactive', {
          keyPrefix: apiKey.substring(0, 12) + '...',
        });
        return null;
      }

      const keyInfo = result.rows[0];

      // Check if expired
      if (keyInfo.expiresAt && new Date(keyInfo.expiresAt) < new Date()) {
        logger.warn('[ApiKeyService] API key expired', {
          keyId: keyInfo.id,
          expiresAt: keyInfo.expiresAt,
        });
        return null;
      }

      return keyInfo;
    } catch (error: any) {
      logger.error('[ApiKeyService] Error validating API key', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check rate limits for API key
   */
  async checkRateLimit(apiKey: string): Promise<RateLimitCheck> {
    try {
      const result = await this.pool.query<RateLimitCheck>(
        `SELECT * FROM check_api_key_rate_limit($1)`,
        [apiKey]
      );

      if (result.rows.length === 0) {
        return {
          allowed: false,
          reason: 'Rate limit check failed',
          requestsToday: 0,
          rateLimitPerDay: 0,
        };
      }

      return result.rows[0];
    } catch (error: any) {
      logger.error('[ApiKeyService] Error checking rate limit', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update API key usage stats
   */
  async updateUsage(apiKey: string): Promise<void> {
    try {
      await this.pool.query(`SELECT increment_api_key_usage($1)`, [apiKey]);
    } catch (error: any) {
      logger.error('[ApiKeyService] Error updating API key usage', {
        error: error.message,
      });
      // Don't throw - usage tracking is not critical
    }
  }

  /**
   * Create new API key for user
   */
  async createApiKey(
    userId: string,
    name: string,
    description?: string,
    expiresAt?: Date
  ): Promise<{ id: string; key: string }> {
    try {
      const result = await this.pool.query<{ id: string; key: string }>(
        `INSERT INTO api_keys (user_id, key, name, description, expires_at)
         VALUES ($1, generate_api_key(), $2, $3, $4)
         RETURNING id, key`,
        [userId, name, description || null, expiresAt || null]
      );

      logger.info('[ApiKeyService] API key created', {
        keyId: result.rows[0].id,
        userId,
        name,
      });

      return result.rows[0];
    } catch (error: any) {
      logger.error('[ApiKeyService] Error creating API key', {
        error: error.message,
        userId,
        name,
      });
      throw error;
    }
  }

  /**
   * List all API keys for user
   */
  async listUserApiKeys(userId: string): Promise<ApiKeyInfo[]> {
    try {
      const result = await this.pool.query<ApiKeyInfo>(
        `SELECT
          ak.id,
          ak.user_id as "userId",
          ak.key,
          ak.name,
          ak.description,
          ak.is_active as "isActive",
          ak.last_used_at as "lastUsedAt",
          ak.usage_count as "usageCount",
          ak.rate_limit_per_minute as "rateLimitPerMinute",
          ak.rate_limit_per_day as "rateLimitPerDay",
          ak.requests_today as "requestsToday",
          ak.created_at as "createdAt",
          ak.expires_at as "expiresAt",
          u.email as "userEmail",
          u.name as "userName",
          COALESCE(uc.balance, 0) as "userBalance"
        FROM api_keys ak
        JOIN users u ON u.id = ak.user_id
        LEFT JOIN user_credits uc ON uc.user_id = u.id
        WHERE ak.user_id = $1
        ORDER BY ak.created_at DESC`,
        [userId]
      );

      return result.rows;
    } catch (error: any) {
      logger.error('[ApiKeyService] Error listing API keys', {
        error: error.message,
        userId,
      });
      throw error;
    }
  }

  /**
   * Revoke (deactivate) API key
   */
  async revokeApiKey(keyId: string, userId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `UPDATE api_keys SET is_active = false WHERE id = $1 AND user_id = $2`,
        [keyId, userId]
      );

      logger.info('[ApiKeyService] API key revoked', { keyId, userId });

      return (result.rowCount || 0) > 0;
    } catch (error: any) {
      logger.error('[ApiKeyService] Error revoking API key', {
        error: error.message,
        keyId,
        userId,
      });
      throw error;
    }
  }

  /**
   * Delete API key permanently
   */
  async deleteApiKey(keyId: string, userId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `DELETE FROM api_keys WHERE id = $1 AND user_id = $2`,
        [keyId, userId]
      );

      logger.info('[ApiKeyService] API key deleted', { keyId, userId });

      return (result.rowCount || 0) > 0;
    } catch (error: any) {
      logger.error('[ApiKeyService] Error deleting API key', {
        error: error.message,
        keyId,
        userId,
      });
      throw error;
    }
  }
}
